import { and, eq } from "drizzle-orm";
import {
  getDb,
  matchProposalsTable,
  stampRecordsTable,
  stampVerificationsTable,
  type OutboxEvent,
} from "@workspace/db";

// A handler reports its result rather than throwing, so the outbox status update
// and the domain writes (attempt/stamp/status/lifecycle) commit atomically in the
// single bypass transaction opened by processOne. `retry` re-queues with backoff;
// `dead` dead-letters immediately (terminal business rejection or non-retriable);
// `park` (R96) holds the event until the rail's breaker allows a probe — no
// attempt is burned, because nothing was sent.
type HandlerOutcome =
  | { kind: "done" }
  | { kind: "retry"; error: string; notBefore?: Date }
  | { kind: "dead"; error: string }
  | { kind: "park"; until: Date; error: string };

// CORE-09 propagation: when an invoice leaves the eligible set (cancelled or
// credited), downstream projections must react — open reconciliation proposals
// are superseded so an accepted match can never settle a dead invoice, and the
// stamp-verification freshness cache is staled so `verify-stamp` re-reads the
// lifecycle immediately rather than serving a cached "eligible".
async function handleLifecycleChanged(
  event: OutboxEvent,
): Promise<HandlerOutcome> {
  const invoiceId = String(
    (event.payload as { invoiceId?: string }).invoiceId ?? "",
  );
  if (!invoiceId) return { kind: "dead", error: "Missing invoiceId" };

  await getDb()
    .update(matchProposalsTable)
    .set({ status: "superseded" })
    .where(
      and(
        eq(matchProposalsTable.invoiceId, invoiceId),
        eq(matchProposalsTable.status, "proposed"),
      ),
    );

  const [stamp] = await getDb()
    .select({ irn: stampRecordsTable.irn, csid: stampRecordsTable.csid })
    .from(stampRecordsTable)
    .where(eq(stampRecordsTable.invoiceId, invoiceId))
    .limit(1);
  if (stamp) {
    await getDb()
      .update(stampVerificationsTable)
      .set({ freshUntil: new Date() })
      .where(
        and(
          eq(stampVerificationsTable.irn, stamp.irn),
          eq(stampVerificationsTable.csid, stamp.csid),
        ),
      );
  }
  return { kind: "done" };
}

export const HANDLERS: Record<
  string,
  (e: OutboxEvent) => Promise<HandlerOutcome>
> = {
  "invoice.lifecycle_changed": handleLifecycleChanged,
};

// Later modules (reconciliation, B2C, connectors) contribute their own outbox
// handlers without touching the worker core.
export function registerHandler(
  type: string,
  handler: (e: OutboxEvent) => Promise<HandlerOutcome>,
): void {
  HANDLERS[type] = handler;
}

export type { HandlerOutcome };
