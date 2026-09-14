import { eq } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  outboxTable,
  isDatabaseConnectionError,
  type OutboxEvent,
} from "@workspace/db";
import { openInvoiceCase } from "../desk/cases";
import { logger } from "../../lib/logger";
import {
  prepareInvoiceSubmit,
  performInvoiceRailCall,
  finalizeInvoiceSubmit,
} from "./submission";
import { HANDLERS, type HandlerOutcome } from "./handlers";
import {
  claimnextSafe,
  startLeaseHeartbeat,
  lockActiveLease,
  ownedEventWhere,
  assertOwnedUpdate,
  OutboxLeaseLost,
} from "./leases";
import { PARK_JITTER_MS, retryDisposition } from "./policy";

// Async submission pipeline (INT-09, SME-03 backend). A transactional outbox row
// is written when an invoice is submitted; this worker drains it, calls the rail
// adapter, appends attempt + stamp records, and applies exponential backoff with
// a dead-letter queue after maxAttempts. Nothing here is synchronous with the
// user request.

async function applyHandlerOutcome(
  event: OutboxEvent,
  outcome: HandlerOutcome,
): Promise<void> {
  const now = new Date();
  const attempts = event.attempts + 1;
  const firstAttemptAt = event.firstAttemptAt ?? now;
  const released = { lockedAt: null, lockToken: null, lockExpiresAt: null };
  if (outcome.kind === "park") {
    const until = new Date(
      outcome.until.getTime() + Math.random() * PARK_JITTER_MS,
    );
    const [updated] = await getDb()
      .update(outboxTable)
      .set({
        ...released,
        status: "pending",
        nextAttemptAt: until,
        parkedUntil: until,
        parkCount: event.parkCount + 1,
        lastError: `${outcome.error}: parked until ${until.toISOString()}`,
      })
      .where(ownedEventWhere(event))
      .returning({ id: outboxTable.id });
    assertOwnedUpdate(event, updated);
    return;
  }
  if (outcome.kind === "done") {
    const containsInboundPayload = event.type.startsWith("inbound.");
    const [updated] = await getDb()
      .update(outboxTable)
      .set({
        ...released,
        status: "done",
        attempts,
        firstAttemptAt,
        parkedUntil: null,
        ...(containsInboundPayload ? { payload: { redacted: true } } : {}),
      })
      .where(ownedEventWhere(event))
      .returning({ id: outboxTable.id });
    assertOwnedUpdate(event, updated);
    return;
  }
  if (outcome.kind === "dead") {
    const [updated] = await getDb()
      .update(outboxTable)
      .set({
        ...released,
        status: "dead",
        attempts,
        firstAttemptAt,
        parkedUntil: null,
        lastError: outcome.error,
        nextAttemptAt: now,
      })
      .where(ownedEventWhere(event))
      .returning({ id: outboxTable.id });
    assertOwnedUpdate(event, updated);
    await openCaseForDeadEvent(event, outcome.error);
    return;
  }
  const next = retryDisposition(event, attempts, now, outcome.notBefore);
  const [updated] = await getDb()
    .update(outboxTable)
    .set({
      ...released,
      status: next.dead ? "dead" : "pending",
      attempts,
      firstAttemptAt: next.firstAttemptAt,
      parkedUntil: null,
      lastError: outcome.error,
      nextAttemptAt: next.nextAttemptAt,
    })
    .where(ownedEventWhere(event))
    .returning({ id: outboxTable.id });
  assertOwnedUpdate(event, updated);
  if (next.dead) await openCaseForDeadEvent(event, outcome.error);
}

export async function processOne(): Promise<boolean> {
  // The claim commits before any handler runs. This frees the pool while an
  // authority request is in flight; lockToken/lockExpiresAt make a crash
  // reclaimable and make a late worker's finalization fail closed.
  const event = await runInBypassContext(claimnextSafe);
  if (!event) return false;
  const stopLeaseHeartbeat = startLeaseHeartbeat(event);

  try {
    if (event.type === "invoice.submit") {
      const prepared = await runInBypassContext(() =>
        prepareInvoiceSubmit(event),
      );
      const effect = prepared ? await performInvoiceRailCall(prepared) : null;
      await runInBypassContext(
        async () => {
          await lockActiveLease(event);
          const outcome = await finalizeInvoiceSubmit(event, prepared, effect);
          await applyHandlerOutcome(event, outcome);
        },
        { correlationId: event.correlationId },
      );
    } else {
      await runInBypassContext(
        async () => {
          await lockActiveLease(event);
          const handler = HANDLERS[event.type];
          const outcome = handler
            ? await handler(event)
            : { kind: "dead" as const, error: `No handler for ${event.type}` };
          await applyHandlerOutcome(event, outcome);
        },
        { correlationId: event.correlationId },
      );
    }
  } catch (error) {
    if (error instanceof OutboxLeaseLost) {
      logger.warn(
        { eventId: event.id, correlationId: event.correlationId },
        "outbox lease expired before finalization; a new worker owns the event",
      );
      return true;
    }
    if (isDatabaseConnectionError(error)) {
      // The handler may have completed an external operation before PostgreSQL
      // disconnected. Do not immediately execute the handler again or burn an
      // attempt: the durable lease remains the single recovery fence, and a
      // later claim can reconcile/replay it once the database is healthy. This
      // is deliberately different from a provider/network failure, for which
      // the handler's idempotency policy returns a normal retry outcome.
      logger.warn(
        { eventId: event.id, correlationId: event.correlationId },
        "database connection lost while processing outbox event; retaining lease for recovery",
      );
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    await runInBypassContext(
      async () => {
        try {
          await lockActiveLease(event);
        } catch (leaseError) {
          if (leaseError instanceof OutboxLeaseLost) return;
          throw leaseError;
        }
        const attempts = event.attempts + 1;
        const next = retryDisposition(event, attempts);
        await getDb()
          .update(outboxTable)
          .set({
            status: next.dead ? "dead" : "pending",
            attempts,
            firstAttemptAt: next.firstAttemptAt,
            parkedUntil: null,
            lockedAt: null,
            lockToken: null,
            lockExpiresAt: null,
            lastError: message,
            nextAttemptAt: next.nextAttemptAt,
          })
          .where(eq(outboxTable.id, event.id));
        if (next.dead) await openCaseForDeadEvent(event, message);
      },
      { correlationId: event.correlationId },
    );
  } finally {
    await stopLeaseHeartbeat();
  }
  return true;
}

// SME-06/CON-04: a dead-lettered invoice event is by definition an unresolved
// failure, so it enters the Compliance Desk queue the moment the pipeline
// gives up. Non-invoice aggregates stay visible via the dead-letter list.
async function openCaseForDeadEvent(
  event: OutboxEvent,
  error: string,
): Promise<void> {
  if (event.aggregateType !== "invoice") return;
  try {
    await openInvoiceCase({
      invoiceId: event.aggregateId,
      title: (invoiceNumber) =>
        event.type === "invoice.submit"
          ? `${invoiceNumber} failed: ${error}`
          : `${invoiceNumber} stuck in ${event.type}`,
      errorCode: error,
      priority: "high",
    });
  } catch {
    // Case intake must never fail the outbox bookkeeping it follows.
  }
}
