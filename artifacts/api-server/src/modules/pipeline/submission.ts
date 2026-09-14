import { and, eq } from "drizzle-orm";
import {
  getDb,
  invoicesTable,
  outboxTable,
  stampRecordsTable,
  submissionAttemptsTable,
  type OutboxEvent,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { buildCanonical } from "../invoice/service";
import { canTransition, recordTransition } from "../invoice/lifecycle";
import {
  railOpenCooldownMs,
  recoverExistingStamp,
  submitWithFailover,
  type FailoverResult,
  type StampResult,
} from "../rails/adapter";
import { RailLookupError } from "../rails/faults";
import { isRetriable } from "../errors";
import type { HandlerOutcome } from "./handlers";

// Shared mark-failed transition for handleInvoiceSubmit's two terminal paths
// (business rejection and non-retriable transport error): flip the invoice to
// `failed` and record the lifecycle transition. The transition reason and any
// per-branch audit stay with the caller.
async function markInvoiceFailed(
  invoiceId: string,
  invoice: {
    firmId: string;
    status: (typeof invoicesTable.$inferSelect)["status"];
  },
  reason: string,
): Promise<void> {
  await getDb()
    .update(invoicesTable)
    .set({ status: "failed" })
    .where(eq(invoicesTable.id, invoiceId));
  await recordTransition({
    invoiceId,
    firmId: invoice.firmId,
    fromStatus: invoice.status,
    toStatus: "failed",
    actorRole: "system",
    reason,
  });
}

export type InvoiceRow = typeof invoicesTable.$inferSelect;

// A 429's Retry-After (R95): honoured as a floor under the R96 backoff and
// capped, so a mistaken or hostile header cannot park an invoice for a day.
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

function retryAfterFrom(result: StampResult): Date | undefined {
  const ms = Number(
    (result.raw as { retryAfterMs?: unknown } | undefined)?.retryAfterMs,
  );
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(Date.now() + Math.min(ms, MAX_RETRY_AFTER_MS));
}

/**
 * Persist an accepted stamp and move the invoice to `stamped` (R97 factored
 * this out of the submit handler so duplicate recovery and reconcile share
 * one write path). Idempotent stamp write (INT-09): the unique(invoiceId)
 * constraint plus onConflictDoNothing guarantees a retried/double-processed
 * event can never create a second stamp, without deleting an append-only
 * lifecycle record. `recovered` marks a stamp the rail had already issued and
 * we only fetched back, which the audit trail records as its own action.
 */
export async function persistStamp(
  invoice: InvoiceRow,
  result: StampResult,
  recovered: boolean,
): Promise<void> {
  const invoiceId = invoice.id;
  await getDb()
    .insert(stampRecordsTable)
    .values({
      invoiceId,
      irn: result.irn!,
      csid: result.csid!,
      qrPayload: result.qrPayload!,
      signedArtifactRef: result.signedArtifactRef!,
      rail: result.rail,
      provider: result.provider ?? "simulator",
      environment: result.environment ?? "sandbox",
    })
    .onConflictDoNothing({ target: stampRecordsTable.invoiceId });
  await getDb()
    .update(invoicesTable)
    .set({ status: "stamped" })
    .where(eq(invoicesTable.id, invoiceId));
  await recordTransition({
    invoiceId,
    firmId: invoice.firmId,
    fromStatus: invoice.status,
    toStatus: "stamped",
    actorRole: "system",
    reason: recovered ? `rail:${result.rail}:recovered` : `rail:${result.rail}`,
  });
  await appendAudit({
    firmId: invoice.firmId,
    action: recovered ? "invoice.stamp_recovered" : "invoice.stamped",
    entityType: "invoice",
    entityId: invoiceId,
    after: {
      irn: result.irn,
      rail: result.rail,
      provider: result.provider ?? "simulator",
      environment: result.environment ?? "sandbox",
    },
  });
  // CORE-09: a stamped credit note / correction credits its original in the
  // same transaction, and downstream projections (reconciliation proposals,
  // stamp-verification cache, exposure) react via the lifecycle-changed event.
  if (
    (invoice.kind === "credit_note" || invoice.kind === "correction") &&
    invoice.relatedInvoiceId
  ) {
    await creditOriginal(invoice.relatedInvoiceId, invoiceId);
  }
}

interface PreparedInvoiceSubmit {
  invoice: InvoiceRow;
  canonical: Awaited<ReturnType<typeof buildCanonical>>;
  idempotencyKey: string;
  attemptNo: number;
}

interface InvoiceRailEffect {
  failover: FailoverResult;
  recovered: StampResult | null;
  recoveryError: string | null;
}

export async function prepareInvoiceSubmit(
  event: OutboxEvent,
): Promise<PreparedInvoiceSubmit | null> {
  const invoiceId = String(
    (event.payload as { invoiceId?: string }).invoiceId ?? "",
  );
  const [invoice] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, invoiceId))
    .limit(1);
  if (!invoice) return null;

  const canonical = await buildCanonical(invoiceId);
  return {
    invoice,
    canonical,
    idempotencyKey: `${invoiceId}:${invoice.invoiceNumber}`,
    attemptNo: event.attempts + 1,
  };
}

// The authority I/O stage deliberately owns no database context. A process
// crash after the rail accepts is recovered by the rail idempotency key and
// duplicate lookup; the durable outbox lease is reclaimed independently.
export async function performInvoiceRailCall(
  prepared: PreparedInvoiceSubmit,
): Promise<InvoiceRailEffect> {
  const failover = await submitWithFailover(
    prepared.canonical,
    prepared.idempotencyKey,
  );
  let recovered: StampResult | null = null;
  let recoveryError: string | null = null;
  if (
    failover.result.status === "rejected" &&
    failover.result.errorCode === "MBS_DUPLICATE"
  ) {
    try {
      recovered = await recoverExistingStamp(
        prepared.canonical,
        prepared.idempotencyKey,
        failover.result.rail,
      );
    } catch (err) {
      if (!(err instanceof RailLookupError)) throw err;
      recoveryError = `${err.code}: stamp lookup failed`;
    }
  }
  return { failover, recovered, recoveryError };
}

export async function finalizeInvoiceSubmit(
  event: OutboxEvent,
  prepared: PreparedInvoiceSubmit | null,
  effect: InvoiceRailEffect | null,
): Promise<HandlerOutcome> {
  if (!prepared || !effect) {
    const invoiceId = String(
      (event.payload as { invoiceId?: string }).invoiceId ?? "",
    );
    return { kind: "dead", error: `Invoice ${invoiceId} missing` };
  }
  const { invoice, canonical, idempotencyKey, attemptNo } = prepared;
  const invoiceId = invoice.id;
  const { result, sent, circuitOpen, retryAfter } = effect.failover;

  // Every breaker is open: nothing was sent, so there is no attempt to record
  // and none to burn — park until the earliest rail will take a probe (R96).
  if (circuitOpen) {
    return {
      kind: "park",
      until: retryAfter ?? new Date(Date.now() + railOpenCooldownMs()),
      error: "RAIL_UNAVAILABLE",
    };
  }

  // One row per rail actually CALLED this try, with the request sent and the
  // response received (CORE-02) — the record a dispute or an accreditation
  // review reads, so the invoice number alone was never enough. A failover
  // leaves the first rail's timeout or 5xx on the record too (R95); a breaker
  // refusal sent nothing and is not an attempt.
  for (const r of sent) {
    await getDb()
      .insert(submissionAttemptsTable)
      .values({
        invoiceId,
        rail: r.rail,
        attemptNo,
        idempotencyKey,
        correlationId: event.correlationId,
        status:
          r.status === "accepted"
            ? "accepted"
            : r.status === "rejected"
              ? "rejected"
              : "error",
        requestPayload: {
          invoiceNumber: invoice.invoiceNumber,
          idempotencyKey,
          canonical: canonical as unknown as Record<string, unknown>,
        },
        responsePayload: r.raw,
        errorCode: r.errorCode ?? null,
      });
  }

  if (result.status === "accepted") {
    await persistStamp(invoice, result, false);
    return { kind: "done" };
  }

  if (result.status === "rejected" && result.errorCode === "MBS_DUPLICATE") {
    if (effect.recoveryError) {
      return { kind: "retry", error: effect.recoveryError };
    }
    if (effect.recovered) {
      await getDb()
        .insert(submissionAttemptsTable)
        .values({
          invoiceId,
          rail: effect.recovered.rail,
          attemptNo,
          idempotencyKey,
          correlationId: event.correlationId,
          status: "accepted",
          requestPayload: { lookup: true, idempotencyKey },
          responsePayload: { ...effect.recovered.raw, recovered: true },
          errorCode: null,
        });
      await persistStamp(invoice, effect.recovered, true);
      return { kind: "done" };
    }
    // No rail knows the submission: keep the terminal rejection, but say so.
    await appendAudit({
      firmId: invoice.firmId,
      action: "invoice.stamp_recovery_failed",
      entityType: "invoice",
      entityId: invoiceId,
      after: { errorCode: result.errorCode, rail: result.rail },
    });
  }

  if (result.status === "rejected") {
    // Terminal business rejection: mark failed, do not retry.
    await markInvoiceFailed(invoiceId, invoice, result.errorCode ?? "rejected");
    await appendAudit({
      firmId: invoice.firmId,
      action: "invoice.rejected",
      entityType: "invoice",
      entityId: invoiceId,
      after: { errorCode: result.errorCode },
    });
    return { kind: "dead", error: result.errorCode ?? "UNKNOWN" };
  }

  // Transient error: re-queue so the outbox backoff logic runs.
  if (isRetriable(result.errorCode ?? "UNKNOWN")) {
    return {
      kind: "retry",
      error: result.errorCode ?? "RAIL_ERROR",
      notBefore: retryAfterFrom(result),
    };
  }
  // Non-retriable transport error: fail terminally.
  await markInvoiceFailed(invoiceId, invoice, result.errorCode ?? "error");
  return { kind: "dead", error: result.errorCode ?? "UNKNOWN" };
}

// CORE-09: transition a credited original when its credit note / correction is
// stamped. Runs inside the worker's bypass transaction so the credit-note stamp
// and the original's transition commit atomically. Idempotent: an original that
// already left the creditable set is recorded, never re-credited.
async function creditOriginal(
  originalId: string,
  adjustmentId: string,
): Promise<void> {
  const [original] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, originalId))
    .limit(1);
  if (!original) return;
  if (!canTransition(original.status, "credited")) {
    // Already terminal (e.g. double-processing) — leave an audit trace only.
    await appendAudit({
      firmId: original.firmId,
      action: "invoice.credit_skipped",
      entityType: "invoice",
      entityId: originalId,
      after: { adjustmentId, status: original.status },
    });
    return;
  }
  // Compare-and-set: a concurrent cancel between the read and this write must
  // not be overwritten (CORE-09: terminal states never resurrect).
  const [moved] = await getDb()
    .update(invoicesTable)
    .set({ status: "credited" })
    .where(
      and(
        eq(invoicesTable.id, originalId),
        eq(invoicesTable.status, original.status),
      ),
    )
    .returning({ id: invoicesTable.id });
  if (!moved) {
    await appendAudit({
      firmId: original.firmId,
      action: "invoice.credit_skipped",
      entityType: "invoice",
      entityId: originalId,
      after: { adjustmentId, reason: "concurrent transition" },
    });
    return;
  }
  await recordTransition({
    invoiceId: originalId,
    firmId: original.firmId,
    fromStatus: original.status,
    toStatus: "credited",
    actorRole: "system",
    reason: `credit_note:${adjustmentId}`,
  });
  await appendAudit({
    firmId: original.firmId,
    action: "invoice.credited",
    entityType: "invoice",
    entityId: originalId,
    after: { adjustmentId },
  });
  await getDb()
    .insert(outboxTable)
    .values({
      aggregateType: "invoice",
      aggregateId: originalId,
      type: "invoice.lifecycle_changed",
      payload: { invoiceId: originalId, toStatus: "credited" },
    });
}
