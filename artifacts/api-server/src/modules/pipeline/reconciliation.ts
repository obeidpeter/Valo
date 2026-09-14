import { and, asc, eq, ne, notExists, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  invoicesTable,
  outboxTable,
  stampRecordsTable,
  submissionAttemptsTable,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { buildCanonical } from "../invoice/service";
import { recoverExistingStamp } from "../rails/adapter";
import { logger } from "../../lib/logger";
import { classifyPostgresFailure } from "./db-retry";
import { persistStamp, type InvoiceRow } from "./submission";

// Reconciliation (INT-09): re-enqueue invoices stuck in `submitted` with no
// stamp and no live outbox row (e.g. a crash mid-flight). Before resubmitting,
// ask the rail whether it already issued a stamp for that submission (R97): a
// crash between the rail's acceptance and our stamp write is exactly the case
// where a blind re-send would come back MBS_DUPLICATE against a live rail. A
// recovered stamp is persisted in place; only an unknown submission is
// re-queued. Returns the number of invoices re-queued (the operator counter);
// recoveries are logged.
// Each stuck invoice is prepared and finalized in short transactions, with the
// rail lookup between them while no pooled connection is held. A pass takes at
// most RECONCILE_BATCH invoices, oldest first; the next pass continues where
// it left off.
const RECONCILE_BATCH = 50;

type ReconcileOutcome = "skipped" | "dead" | "recovered" | "requeued";

export function throwIfPassAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
async function reconcileOne(
  invoice: InvoiceRow,
  signal?: AbortSignal,
): Promise<ReconcileOutcome> {
  throwIfPassAborted(signal);
  const idempotencyKey = `${invoice.id}:${invoice.invoiceNumber}`;
  const prepared = await runInBypassContext(async () => {
    const [stamp] = await getDb()
      .select({ id: stampRecordsTable.id })
      .from(stampRecordsTable)
      .where(eq(stampRecordsTable.invoiceId, invoice.id))
      .limit(1);
    if (stamp) return { outcome: "skipped" as const, canonical: null };
    const open = await getDb()
      .select({ status: outboxTable.status })
      .from(outboxTable)
      .where(
        and(
          eq(outboxTable.aggregateId, invoice.id),
          ne(outboxTable.status, "done"),
        ),
      );
    if (open.some((row) => row.status === "dead")) {
      return { outcome: "dead" as const, canonical: null };
    }
    if (open.length > 0) {
      return { outcome: "skipped" as const, canonical: null };
    }
    const canonical = await buildCanonical(invoice.id).catch((err: unknown) => {
      if (classifyPostgresFailure(err).transient) throw err;
      logger.warn(
        { invoiceId: invoice.id, err },
        "reconcile could not build the canonical invoice; re-queuing",
      );
      return null;
    });
    return { outcome: null, canonical };
  });
  throwIfPassAborted(signal);
  if (prepared.outcome) return prepared.outcome;

  // No database transaction is open across the authority lookup.
  const existing = prepared.canonical
    ? await recoverExistingStamp(prepared.canonical, idempotencyKey).catch(
        (err: unknown) => {
          if (classifyPostgresFailure(err).transient) throw err;
          logger.warn(
            { invoiceId: invoice.id, err },
            "reconcile could not ask the rail for an existing stamp; re-queuing",
          );
          return null;
        },
      )
    : null;

  throwIfPassAborted(signal);
  return runInBypassContext(async () => {
    throwIfPassAborted(signal);
    // Re-check after I/O: another worker may have stamped or queued the invoice
    // while this lookup was in flight.
    const [stamp] = await getDb()
      .select({ id: stampRecordsTable.id })
      .from(stampRecordsTable)
      .where(eq(stampRecordsTable.invoiceId, invoice.id))
      .limit(1);
    if (stamp) return "skipped";
    const open = await getDb()
      .select({ status: outboxTable.status })
      .from(outboxTable)
      .where(
        and(
          eq(outboxTable.aggregateId, invoice.id),
          ne(outboxTable.status, "done"),
        ),
      );
    if (open.some((row) => row.status === "dead")) return "dead";
    if (open.length > 0) return "skipped";
    if (existing) {
      await getDb()
        .insert(submissionAttemptsTable)
        .values({
          invoiceId: invoice.id,
          rail: existing.rail,
          attemptNo: 0,
          idempotencyKey,
          status: "accepted",
          requestPayload: { lookup: true, idempotencyKey, source: "reconcile" },
          responsePayload: { ...existing.raw, recovered: true },
          errorCode: null,
        });
      await persistStamp(invoice, existing, true);
      return "recovered";
    }
    await getDb()
      .insert(outboxTable)
      .values({
        aggregateType: "invoice",
        aggregateId: invoice.id,
        type: "invoice.submit",
        payload: { invoiceId: invoice.id },
      });
    return "requeued";
  });
}

export async function reconcile(signal?: AbortSignal): Promise<number> {
  // Only invoices a pass can ACT on fill the batch: no stamp row yet and no
  // outbox row still live or dead-lettered (a dead row waits for an operator
  // replay, R96). Otherwise fifty permanently-stuck invoices would starve
  // every newer one. reconcileOne re-checks inside its own transaction.
  const stuck = await runInBypassContext(() =>
    getDb()
      .select()
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.status, "submitted"),
          notExists(
            getDb()
              .select({ one: sql`1` })
              .from(stampRecordsTable)
              .where(eq(stampRecordsTable.invoiceId, invoicesTable.id)),
          ),
          notExists(
            getDb()
              .select({ one: sql`1` })
              .from(outboxTable)
              .where(
                and(
                  // aggregate_id is text (any aggregate), invoices.id a uuid.
                  eq(outboxTable.aggregateId, sql`${invoicesTable.id}::text`),
                  ne(outboxTable.status, "done"),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(invoicesTable.createdAt))
      .limit(RECONCILE_BATCH),
  );
  let requeued = 0;
  let recovered = 0;
  let deadLettered = 0;
  for (const invoice of stuck) {
    throwIfPassAborted(signal);
    const outcome = await reconcileOne(invoice, signal);
    if (outcome === "dead") deadLettered++;
    else if (outcome === "recovered") recovered++;
    else if (outcome === "requeued") requeued++;
  }
  if (stuck.length === RECONCILE_BATCH) {
    logger.info(
      { batch: RECONCILE_BATCH },
      "reconcile pass hit its batch size; the next pass continues",
    );
  }
  if (recovered > 0 || deadLettered > 0) {
    logger.info(
      { requeued, recovered, deadLettered },
      "reconcile pass: dead-lettered invoices wait for an operator replay",
    );
  }
  return requeued;
}

// Duplicate-stamp reconciliation (INT-09), append-only (CORE-02). Duplicates are
// prevented at write by the unique(invoiceId) constraint + idempotent insert, so
// this sweep is a defensive detector for any historical/anomalous duplicate. It
// NEVER deletes a stamp: stamps are immutable post-submission. Instead it names
// the canonical (earliest) stamp and records the superseded ones in an audit
// event, so every reader resolves deterministically to the same canonical stamp.
export async function reconcileDuplicateStamps(): Promise<number> {
  return runInBypassContext(async () => {
    const dupes = await getDb().execute<{ invoice_id: string }>(sql`
      SELECT invoice_id FROM stamp_records
      GROUP BY invoice_id HAVING count(*) > 1
    `);
    const list =
      (dupes as unknown as { rows?: { invoice_id: string }[] }).rows ??
      (dupes as unknown as { invoice_id: string }[]);
    let flagged = 0;
    for (const { invoice_id: invoiceId } of list) {
      const stamps = await getDb()
        .select()
        .from(stampRecordsTable)
        .where(eq(stampRecordsTable.invoiceId, invoiceId))
        .orderBy(asc(stampRecordsTable.createdAt));
      const [canonical, ...superseded] = stamps;
      if (!canonical || superseded.length === 0) continue;
      await appendAudit({
        action: "invoice.stamp_duplicate_detected",
        entityType: "invoice",
        entityId: invoiceId,
        after: {
          canonicalStampId: canonical.id,
          supersededStampIds: superseded.map((s) => s.id),
        },
      });
      flagged += superseded.length;
    }
    return flagged;
  });
}
