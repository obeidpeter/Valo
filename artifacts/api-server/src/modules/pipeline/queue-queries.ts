import { and, asc, eq, gt, isNotNull, lt, or, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  outboxTable,
  stampVerificationsTable,
  type OutboxEvent,
} from "@workspace/db";
import { DomainError } from "../errors";
import { outboxEvents, outboxOldestPendingAgeSeconds } from "../../lib/metrics";

// Replay a dead-lettered event (operator action).
export async function replayDead(outboxId: string): Promise<void> {
  await runInBypassContext(async () => {
    await getDb()
      .update(outboxTable)
      .set({
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        // A replay starts a fresh retry horizon (R96).
        firstAttemptAt: null,
        parkedUntil: null,
        parkCount: 0,
        lockedAt: null,
        lockToken: null,
        lockExpiresAt: null,
      })
      .where(and(eq(outboxTable.id, outboxId), eq(outboxTable.status, "dead")));
  });
}

// The events still on their way (R102): pending rows that have already
// failed at least once, or are parked behind a breaker — the Desk's view of
// "what is retrying and why", bounded like every list.
export interface QueuePage {
  items: OutboxEvent[];
  nextCursor: string | null;
}

type QueueCursor = {
  kind: "dead" | "retrying";
  primary: string;
  createdAt: string;
  id: string;
};

const UUID_CURSOR_VALUE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeQueueCursor(cursor: QueueCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeQueueCursor(
  raw: string | undefined,
  kind: QueueCursor["kind"],
): QueueCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<QueueCursor>;
    if (
      parsed.kind !== kind ||
      typeof parsed.primary !== "string" ||
      Number.isNaN(Date.parse(parsed.primary)) ||
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== "string" ||
      !UUID_CURSOR_VALUE.test(parsed.id)
    ) {
      throw new Error("shape");
    }
    return parsed as QueueCursor;
  } catch {
    throw new DomainError(
      "INVALID_CURSOR",
      "The queue cursor is invalid or belongs to a different list",
      400,
    );
  }
}

function queuePage(
  rows: OutboxEvent[],
  limit: number,
  kind: QueueCursor["kind"],
  primary: (row: OutboxEvent) => Date,
): QueuePage {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeQueueCursor({
            kind,
            primary: primary(last).toISOString(),
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null,
  };
}

export async function listRetrying(bounds: {
  limit: number;
  cursor?: string | undefined;
}): Promise<QueuePage> {
  return runInBypassContext(async () => {
    const cursor = decodeQueueCursor(bounds.cursor, "retrying");
    // node-postgres materializes timestamps as millisecond-precision Dates.
    // Normalize PostgreSQL's microseconds in both ORDER BY and comparisons so
    // the boundary row cannot repeat on the next cursor page.
    const retryAt = sql<Date>`date_trunc('milliseconds', ${outboxTable.nextAttemptAt})`;
    const createdAt = sql<Date>`date_trunc('milliseconds', ${outboxTable.createdAt})`;
    const retrying = and(
      eq(outboxTable.status, "pending"),
      or(gt(outboxTable.attempts, 0), isNotNull(outboxTable.parkedUntil)),
    );
    const after = cursor
      ? or(
          gt(retryAt, new Date(cursor.primary)),
          and(
            eq(retryAt, new Date(cursor.primary)),
            or(
              gt(createdAt, new Date(cursor.createdAt)),
              and(
                eq(createdAt, new Date(cursor.createdAt)),
                gt(outboxTable.id, cursor.id),
              ),
            ),
          ),
        )
      : undefined;
    const rows = await getDb()
      .select()
      .from(outboxTable)
      .where(after ? and(retrying, after) : retrying)
      .orderBy(asc(retryAt), asc(createdAt), asc(outboxTable.id))
      .limit(bounds.limit + 1);
    const redacted = rows.map((row) =>
      row.type === "inbound.email" || row.type === "inbound.whatsapp"
        ? { ...row, payload: { redacted: true } }
        : row,
    );
    return queuePage(
      redacted,
      bounds.limit,
      "retrying",
      (row) => row.nextAttemptAt,
    );
  });
}

export async function listDeadLetters(bounds: {
  limit: number;
  cursor?: string | undefined;
}): Promise<QueuePage> {
  return runInBypassContext(async () => {
    const cursor = decodeQueueCursor(bounds.cursor, "dead");
    const createdAt = sql<Date>`date_trunc('milliseconds', ${outboxTable.createdAt})`;
    const after = cursor
      ? or(
          gt(createdAt, new Date(cursor.createdAt)),
          and(
            eq(createdAt, new Date(cursor.createdAt)),
            gt(outboxTable.id, cursor.id),
          ),
        )
      : undefined;
    const rows = await getDb()
      .select()
      .from(outboxTable)
      .where(
        after
          ? and(eq(outboxTable.status, "dead"), after)
          : eq(outboxTable.status, "dead"),
      )
      .orderBy(asc(createdAt), asc(outboxTable.id))
      .limit(bounds.limit + 1);
    const redacted = rows.map((row) =>
      row.type === "inbound.email" || row.type === "inbound.whatsapp"
        ? { ...row, payload: { redacted: true } }
        : row,
    );
    return queuePage(redacted, bounds.limit, "dead", (row) => row.createdAt);
  });
}

// Retention for the pipeline's own tables (this module already owns both).
//
// Outbox: a `done` row is pure history once processed — the audit ledger and
// submission_attempts carry the durable trail — but the drain poll's partial
// index only excludes them from the QUEUE scan; the table itself would still
// grow one row per submitted invoice forever. Keep 30 days for debugging,
// then delete. `dead` rows are deliberately kept: they ARE the dead-letter
// queue the operator replays.
//
// Stamp verifications: the public /verify-stamp endpoint inserts a cache row
// per (irn, csid) miss — including garbage pairs from unauthenticated
// traffic — and a fresh row per TTL expiry. Rows stale for 30 days can never
// serve a cache hit again; delete them.
const PIPELINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function sweepPipelineRetention(): Promise<void> {
  await runInBypassContext(async () => {
    const cutoff = new Date(Date.now() - PIPELINE_RETENTION_MS);
    await getDb()
      .delete(outboxTable)
      .where(
        and(eq(outboxTable.status, "done"), lt(outboxTable.updatedAt, cutoff)),
      );
    await getDb()
      .delete(stampVerificationsTable)
      .where(lt(stampVerificationsTable.freshUntil, cutoff));
  });
}

// Outbox gauges (R96): depth by state, the age of the oldest ready event and
// the dead-letter count — the series an alert on "the pipeline is stuck"
// reads. Set by a sweep (every minute; on Autoscale, every external ping)
// rather than at scrape time, so /api/metrics never touches the database.
export async function sweepOutboxGauges(): Promise<void> {
  const [row] = (
    await runInBypassContext(() =>
      getDb().execute(sql`
      SELECT
        count(*) FILTER (WHERE status = 'pending' AND (parked_until IS NULL OR parked_until <= now()))::int AS ready,
        count(*) FILTER (WHERE status = 'pending' AND parked_until > now())::int AS parked,
        count(*) FILTER (WHERE status = 'processing')::int AS processing,
        count(*) FILTER (WHERE status = 'dead')::int AS dead,
        coalesce(
          extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'pending')),
          0
        )::float AS oldest_pending_age_seconds
      FROM outbox_events
    `),
    )
  ).rows as {
    ready: number;
    parked: number;
    processing: number;
    dead: number;
    oldest_pending_age_seconds: number;
  }[];
  outboxEvents.set({ state: "pending" }, row?.ready ?? 0);
  outboxEvents.set({ state: "parked" }, row?.parked ?? 0);
  outboxEvents.set({ state: "processing" }, row?.processing ?? 0);
  outboxEvents.set({ state: "dead" }, row?.dead ?? 0);
  outboxOldestPendingAgeSeconds.set(
    Number(row?.oldest_pending_age_seconds ?? 0),
  );
}
