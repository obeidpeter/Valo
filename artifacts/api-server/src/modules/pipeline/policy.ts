import type { OutboxEvent } from "@workspace/db";
import { railTimeoutMs } from "../rails/transports/http";

// Outage policy (R96). A retriable failure is retried on a capped, jittered
// exponential backoff for as long as a WALL-CLOCK horizon allows — measured
// from the event's first attempt, so a 24-hour rail outage is survived
// rather than dead-lettered after the six tries the old attempt count
// allowed (about two minutes). `maxAttempts` remains the minimum number of
// tries an event gets even when its horizon was spent parked. Jitter keeps
// a backlog that wakes together from hitting the rail in one wave.
const BASE_BACKOFF_MS = 2_000;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60 * 1000;
const DEFAULT_RETRY_HORIZON_MS = 24 * 60 * 60 * 1000;
export const PARK_JITTER_MS = 2_000;
const DEFAULT_DATABASE_RETRY_BASE_MS = 1_000;
const MAX_DATABASE_RETRY_MS = 30_000;

function outboxMaxBackoffMs(): number {
  const configured = Number(process.env.OUTBOX_MAX_BACKOFF_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MAX_BACKOFF_MS;
}

function outboxRetryHorizonMs(): number {
  const configured = Number(process.env.OUTBOX_RETRY_HORIZON_MS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : DEFAULT_RETRY_HORIZON_MS;
}

/**
 * Background work must yield when PostgreSQL is unavailable. A fixed interval
 * would turn an outage into a connection-attempt storm, while a retry of the
 * handler itself could repeat an external side effect whose durable result was
 * lost with the transaction. The scheduler uses this delay only after the
 * failed pass has settled; it never wraps a handler or authority call.
 */
export function databaseRetryBackoffMs(failures: number): number {
  const configured = Number(process.env.PIPELINE_DB_RETRY_BASE_MS);
  const base =
    Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : DEFAULT_DATABASE_RETRY_BASE_MS;
  const exponent = Math.max(0, Math.min(10, Math.floor(failures) - 1));
  return Math.min(MAX_DATABASE_RETRY_MS, base * 2 ** exponent);
}

/** Capped exponential backoff with half-range jitter: [cap/2, cap] of 2s·2^n. */
export function backoffMs(attempts: number): number {
  const raw = Math.min(
    outboxMaxBackoffMs(),
    BASE_BACKOFF_MS * Math.pow(2, attempts),
  );
  return Math.floor(raw / 2 + Math.random() * (raw / 2));
}

/**
 * Where a failed attempt leaves the event: dead once BOTH the minimum tries
 * and the wall-clock horizon (from the first attempt) are spent, otherwise
 * pending again after the jittered backoff.
 */
export function retryDisposition(
  event: Pick<OutboxEvent, "maxAttempts" | "firstAttemptAt">,
  attempts: number,
  now = new Date(),
  notBefore?: Date | null,
): { dead: boolean; nextAttemptAt: Date; firstAttemptAt: Date } {
  const firstAttemptAt = event.firstAttemptAt ?? now;
  const elapsed = now.getTime() - firstAttemptAt.getTime();
  const dead =
    attempts >= event.maxAttempts && elapsed >= outboxRetryHorizonMs();
  const backoffAt = new Date(now.getTime() + backoffMs(attempts));
  // A rail's Retry-After (R95) is a FLOOR under the backoff, never a ceiling.
  const retryAt =
    notBefore && notBefore.getTime() > backoffAt.getTime()
      ? notBefore
      : backoffAt;
  return {
    dead,
    firstAttemptAt,
    nextAttemptAt: dead ? now : retryAt,
  };
}

// Compatibility export for the former in-transaction rail budget. It now
// defines the minimum durable lease around the transaction-free I/O stage.
export function transactionHoldBudgetMs(): number {
  return 4 * railTimeoutMs() + 30_000;
}

export function outboxLeaseMs(): number {
  const configured = Number(process.env.OUTBOX_LEASE_MS);
  const minimum = transactionHoldBudgetMs();
  return Number.isFinite(configured) && configured >= minimum
    ? Math.floor(configured)
    : minimum;
}
