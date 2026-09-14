import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  getDb,
  runInBypassContext,
  outboxTable,
  type OutboxEvent,
} from "@workspace/db";
import { logger } from "../../lib/logger";
import { outboxClaimFailuresTotal } from "../../lib/metrics";
import { classifyPostgresFailure } from "./db-retry";
import { outboxLeaseMs } from "./policy";

// Claim one pending event atomically (SKIP LOCKED so multiple workers are safe).
// The locking subquery is raw SQL (the builder cannot express FOR UPDATE SKIP
// LOCKED inside an UPDATE), but the UPDATE itself goes through the builder so
// the returned row is mapped to the schema's camelCase shape. A raw
// `RETURNING *` handed back snake_case columns, which left `maxAttempts`
// (and now `firstAttemptAt`/`parkCount`) undefined on the claimed event and
// silently disabled attempt-count dead-lettering (R96).
async function claimnext(): Promise<OutboxEvent | null> {
  const lockToken = randomUUID();
  const lockExpiresAt = new Date(Date.now() + outboxLeaseMs());
  const [event] = await getDb()
    .update(outboxTable)
    .set({
      status: "processing",
      lockedAt: sql`now()`,
      lockToken,
      lockExpiresAt,
    })
    .where(
      eq(
        outboxTable.id,
        sql`(
          SELECT id FROM outbox_events
          WHERE (status = 'pending' AND next_attempt_at <= now())
             OR (status = 'processing' AND (
                  lock_expires_at <= now()
                  OR (lock_expires_at IS NULL AND locked_at < now() - interval '5 minutes')
                ))
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )`,
      ),
    )
    .returning();
  return event ?? null;
}

export class OutboxLeaseLost extends Error {}

export function ownedEventWhere(event: OutboxEvent) {
  if (!event.lockToken) throw new OutboxLeaseLost("Claim has no lease token");
  return and(
    eq(outboxTable.id, event.id),
    eq(outboxTable.status, "processing"),
    eq(outboxTable.lockToken, event.lockToken),
  );
}

export function assertOwnedUpdate(
  event: OutboxEvent,
  updated: { id: string } | undefined,
): void {
  if (!updated)
    throw new OutboxLeaseLost(`Lease lost for outbox event ${event.id}`);
}

export async function lockActiveLease(event: OutboxEvent): Promise<void> {
  if (!event.lockToken) throw new OutboxLeaseLost("Claim has no lease token");
  const result = await getDb().execute<{ id: string }>(sql`
    SELECT id FROM outbox_events
    WHERE id = ${event.id}
      AND status = 'processing'
      AND lock_token = ${event.lockToken}
    FOR UPDATE
  `);
  const rows =
    (result as unknown as { rows?: { id: string }[] }).rows ??
    (result as unknown as { id: string }[]);
  if (rows.length !== 1) {
    throw new OutboxLeaseLost(`Lease lost for outbox event ${event.id}`);
  }
}

async function renewActiveLease(event: OutboxEvent): Promise<void> {
  if (!event.lockToken) throw new OutboxLeaseLost("Claim has no lease token");
  const lockExpiresAt = new Date(Date.now() + outboxLeaseMs());
  const [renewed] = await getDb()
    .update(outboxTable)
    .set({ lockExpiresAt })
    .where(
      and(
        eq(outboxTable.id, event.id),
        eq(outboxTable.status, "processing"),
        eq(outboxTable.lockToken, event.lockToken),
      ),
    )
    .returning({ id: outboxTable.id });
  if (!renewed)
    throw new OutboxLeaseLost(`Lease lost for outbox event ${event.id}`);
}

/**
 * Keep a claimed event fenced while a connector/rail/provider call is in
 * flight. The heartbeat deliberately runs in short, independent transactions:
 * no pooled connection is held around external I/O, and a failed heartbeat is
 * observed by the final lease check rather than triggering a second handler.
 */
export function startLeaseHeartbeat(
  event: OutboxEvent,
  renewLease: () => Promise<void> = () =>
    runInBypassContext(() => renewActiveLease(event)),
): () => Promise<void> {
  const intervalMs = Math.max(1_000, Math.floor(outboxLeaseMs() / 3));
  let stopped = false;
  let renewal: Promise<void> | null = null;
  const renew = () => {
    if (stopped || renewal) return;
    renewal = renewLease()
      .catch((error) => {
        logger.warn(
          { eventId: event.id, correlationId: event.correlationId },
          "outbox lease heartbeat failed; keeping the original lease fence",
        );
        throw error;
      })
      .finally(() => {
        renewal = null;
      });
    void renewal.catch(() => {});
  };
  const timer = setInterval(renew, intervalMs);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (renewal) await renewal.catch(() => {});
  };
}

// A claim failure must not be confused with an empty queue: a persistent
// one (permissions regression, schema drift) would
// otherwise make the pipeline process nothing while every dashboard stays
// green. Log/count it, then let the guarded pass report failure without
// killing the interval loop. The short claim transaction rolls back.
export async function claimnextSafe(): Promise<OutboxEvent | null> {
  try {
    return await claimnext();
  } catch (err) {
    outboxClaimFailuresTotal.inc();
    const failure = classifyPostgresFailure(err);
    if (!failure.transient) logger.error({ err }, "outbox claim failed");
    throw err;
  }
}
