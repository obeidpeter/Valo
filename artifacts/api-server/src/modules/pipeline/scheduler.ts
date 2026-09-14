import { isDatabaseConnectionError } from "@workspace/db";
import { logger } from "../../lib/logger";
import {
  sweepErrorsTotal,
  workerDatabaseRecoveryTotal,
} from "../../lib/metrics";
import { processOne } from "./processing";
import {
  reconcile,
  reconcileDuplicateStamps,
  throwIfPassAborted,
} from "./reconciliation";
import { sweepPipelineRetention, sweepOutboxGauges } from "./queue-queries";
import { databaseRetryBackoffMs } from "./policy";
import {
  registerSweep,
  runRegisteredSweeps,
  settleOwnedWork,
  stopSweeps,
  resumeSweeps,
  type SweepFailureReport,
} from "./sweeps";
import { track } from "./in-flight";
import { withDistributedLock } from "./distributed-lock";
import {
  classifyPostgresFailure,
  withTransientDatabaseRetry,
  WorkerRetryStoppedError,
  type WorkerRetryOptions,
  type WorkerName,
} from "./db-retry";

// Set by stopWorker (R95): a drain pass finishes the event in flight and
// then stops CLAIMING, so a backlog against a slow rail cannot carry the
// process past its graceful-shutdown deadline one claim at a time.
let stopping = false;

// Drain until no more ready events (bounded to avoid a hot loop).
export async function drain(max = 50): Promise<number> {
  let processed = 0;
  for (let i = 0; i < max; i++) {
    if (stopping) break;
    const did = await processOne();
    if (!did) break;
    processed++;
  }
  return processed;
}

let timer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let workerRecoveryTimer: NodeJS.Timeout | null = null;
let workerRecoveryFailures = 0;
let workerStopped = false;
let workerRestartRequired = false;

// Reconciliation runs on a slower cadence than the drain loop.
const RECONCILE_INTERVAL_MS = 30_000;
// R2 compliance sweeps: B2C clocks are minute-sensitive (SME-08 pre-breach
// alerts must land >= 4h before the deadline), so the sweep runs every minute;
// buyer exposure snapshots refresh inside the same pass but self-limit to a
// 24-hour window (BR-01), so the frequent cadence costs nothing.
const SWEEP_INTERVAL_MS = 60_000;

registerSweep("pipeline.retention", sweepPipelineRetention, {
  critical: false,
});

registerSweep("pipeline.gauges", sweepOutboxGauges);

// Module-level reentrancy guards shared by the interval loops AND the external
// wake-up trigger (see runScheduledWorkOnce): a run that exceeds its period —
// or an external trigger landing mid-pass — must skip, not overlap, or the
// sweep/reconcile duplication races return (CON-M3).
let draining = false;
let reconciling = false;
let sweeping = false;

let workerAbortController = new AbortController();
let databaseRetryAt = 0;
let databaseFailures = 0;
const activePasses = new Set<Promise<unknown>>();

function databaseRetryActive(now = Date.now()): boolean {
  return databaseRetryAt > now;
}

function noteDatabaseFailure(
  lane: "drain" | "reconcile" | "sweeps",
  error: unknown,
): void {
  const now = Date.now();
  // Several lanes can observe the same outage in one event-loop turn. Count
  // that outage once, otherwise three loops would jump the backoff to its cap
  // before the first recovery probe had a chance to run.
  if (!databaseRetryActive(now)) databaseFailures += 1;
  const retryInMs = databaseRetryBackoffMs(databaseFailures);
  databaseRetryAt = Math.max(databaseRetryAt, now + retryInMs);
  logger.warn(
    {
      lane,
      retryInMs: databaseRetryAt - now,
      failureCount: databaseFailures,
      error: isDatabaseConnectionError(error) ? "connection_lost" : "database",
    },
    "background work paused after database connection failure",
  );
}

function noteDatabaseSuccess(): void {
  if (databaseFailures === 0) return;
  databaseFailures = 0;
  databaseRetryAt = 0;
  logger.info("background work resumed after database recovery");
}

// A lost lock session pauses this worker's scheduling (distributed-lock.ts owns
// the lock mechanics; this module owns backoff/recovery). If the lock dies
// while its task is still running, this process cannot prove that the task will
// stop before another worker acquires the lock. It therefore fails closed and
// requires a process restart rather than resuming over an unfenced side effect.
function pauseWorkerForConnectionLoss(activeWork?: PromiseLike<unknown>): void {
  if (workerRestartRequired) return;
  if (activeWork || activePasses.size > 0 || draining) {
    stopping = true;
    workerRestartRequired = true;
    workerStopped = true;
    logger.error(
      "worker lock connection lost during an active pass; exiting without draining",
    );
    // Do not emit SIGTERM or abort callbacks: both can run stale work while a
    // replacement owns the lock. This also overrides an in-progress graceful
    // shutdown. Already-issued remote calls still need idempotency/fencing.
    process.exitCode = 1;
    process.exit(1);
    return;
  }
  if (workerStopped) return;
  stopping = true;
  stopSweeps();
  // Only an idle ownership loss may resume after a bounded recovery window.
  workerAbortController.abort();
  workerRecoveryFailures += 1;
  if (workerRecoveryTimer) return;
  const retryInMs = databaseRetryBackoffMs(workerRecoveryFailures);
  logger.warn(
    { retryInMs, failureCount: workerRecoveryFailures },
    "worker lock connection lost; pausing background scheduling",
  );
  workerRecoveryTimer = setTimeout(() => {
    workerRecoveryTimer = null;
    if (workerStopped || workerRestartRequired) return;
    workerAbortController = new AbortController();
    stopping = false;
    resumeSweeps();
    workerRecoveryFailures = 0;
    logger.info(
      "background scheduling resumed after worker connection recovery window",
    );
  }, retryInMs);
  workerRecoveryTimer.unref?.();
}

const withPassLock = <T>(
  lockId: number,
  task: (signal: AbortSignal) => Promise<T>,
) => {
  const controller = new AbortController();
  return withDistributedLock(
    lockId,
    async () => {
      const work = task(controller.signal);
      activePasses.add(work);
      try {
        return await work;
      } finally {
        activePasses.delete(work);
      }
    },
    (activeWork) => {
      pauseWorkerForConnectionLoss(activeWork);
      controller.abort(new Error("Worker lock connection lost"));
    },
  );
};

// The guarded pass bodies shared by the interval loops (startWorker) and the
// external wake-up trigger (runScheduledWorkOnce). Each skips — never overlaps
// — when its prior run is still in flight, isolates its own errors (logged,
// not silently swallowed), and reports whether it actually ran.

interface SweepPassResult {
  ran: boolean;
  failures: number;
  /** Names of the sweeps that failed (static identifiers, never tenant data). */
  failedSweeps: string[];
  /** How many of those are critical (absent `critical: false`). */
  criticalFailures: number;
}

const passResult = (
  ran: boolean,
  failures: number,
  report: SweepFailureReport,
): SweepPassResult => ({
  ran,
  failures,
  failedSweeps: [...report.failed],
  criticalFailures: report.critical,
});

async function guardedSweepPass(): Promise<SweepPassResult> {
  if (sweeping || stopping)
    return passResult(false, 0, { failed: [], critical: 0 });
  if (databaseRetryActive()) {
    return passResult(false, 1, { failed: ["database"], critical: 1 });
  }
  sweeping = true;
  let report!: (result: SweepPassResult) => void;
  const response = new Promise<SweepPassResult>((resolve) => {
    report = resolve;
  });
  track(
    (async () => {
      const failed: SweepFailureReport = { failed: [], critical: 0 };
      try {
        const result = await withPassLock(991_102, async (signal) => {
          const owned: Promise<unknown>[] = [];
          try {
            const failures = await runRegisteredSweeps(owned, failed, signal);
            // A timeout must report failure promptly while retaining ownership
            // until the underlying work settles. Healthy passes await unlock.
            if (failures > 0) report(passResult(true, failures, failed));
            return failures;
          } finally {
            // The caller may stop waiting, but another process must not acquire
            // our pass lock while a timed-out sweep still has side effects —
            // up to the settle ceiling, past which ownership is released and
            // the stuck sweep is alerted (R105).
            await settleOwnedWork(owned);
          }
        });
        if (failed.databaseFailure) {
          noteDatabaseFailure("sweeps", failed.databaseFailure);
        } else if (result.acquired) {
          noteDatabaseSuccess();
        }
        report(passResult(result.acquired, result.value ?? 0, failed));
      } catch (err) {
        if (err instanceof WorkerRetryStoppedError) {
          report(passResult(false, 0, { failed: [], critical: 0 }));
          return;
        }
        // The pass itself (lock acquisition / release) failed — the sweeps
        // inside never throw past runSweepsOnce. Count it under its own
        // label so an unhandled rejection never escapes the interval.
        sweepErrorsTotal.inc({ sweep: "pass", kind: "error" });
        const failure = classifyPostgresFailure(err);
        if (failure.transient) noteDatabaseFailure("sweeps", err);
        else logger.error({ err }, "compliance sweep pass failed");
        report(passResult(false, 1, { failed: ["pass"], critical: 1 }));
      } finally {
        sweeping = false;
      }
    })(),
  );
  return response;
}

/** One guarded sweep pass on demand (the external trigger and tests). */
export async function runSweepPassOnce(): Promise<boolean> {
  return (await guardedSweepPass()).ran;
}

async function guardedDrainPass(
  retryDependencies: PassRetryDependencies = {},
): Promise<{
  ran: boolean;
  drained: number;
  failed: boolean;
}> {
  if (draining || stopping) return { ran: false, drained: 0, failed: false };
  if (databaseRetryActive()) return { ran: false, drained: 0, failed: true };
  draining = true;
  return track(
    (async () => {
      try {
        const drained = await retryDatabasePass(
          "drain",
          drain,
          retryDependencies,
        );
        return { ran: true, drained, failed: false };
      } catch (err) {
        if (err instanceof WorkerRetryStoppedError)
          return { ran: false, drained: 0, failed: false };
        const failure = classifyPostgresFailure(err);
        if (failure.transient) noteDatabaseFailure("drain", err);
        else logger.error({ err }, "outbox drain failed");
        return { ran: false, drained: 0, failed: true };
      } finally {
        draining = false;
      }
    })(),
  );
}

/** One guarded outbox pass on demand; dependencies are for deterministic tests. */
export function runDrainPassOnce(
  retryDependencies: PassRetryDependencies = {},
): Promise<{ ran: boolean; drained: number; failed: boolean }> {
  return guardedDrainPass(retryDependencies);
}
const DUPLICATE_STAMP_INTERVAL_MS = 60 * 60 * 1000;
let lastDuplicateStampSweep = 0;

async function guardedReconcilePass(
  retryDependencies: PassRetryDependencies = {},
): Promise<{
  ran: boolean;
  failed: boolean;
}> {
  if (reconciling || stopping) return { ran: false, failed: false };
  if (databaseRetryActive()) return { ran: false, failed: true };
  reconciling = true;
  return track(
    (async () => {
      try {
        const result = await retryDatabasePass(
          "reconcile",
          () =>
            withPassLock(991_103, async (signal) => {
              await reconcile(signal);
              throwIfPassAborted(signal);
              if (
                Date.now() - lastDuplicateStampSweep >=
                DUPLICATE_STAMP_INTERVAL_MS
              ) {
                lastDuplicateStampSweep = Date.now();
                await reconcileDuplicateStamps();
              }
            }),
          retryDependencies,
        );
        return { ran: result.acquired, failed: false };
      } catch (err) {
        if (err instanceof WorkerRetryStoppedError)
          return { ran: false, failed: false };
        const failure = classifyPostgresFailure(err);
        if (failure.transient) noteDatabaseFailure("reconcile", err);
        else logger.error({ err }, "pipeline reconcile sweep failed");
        return { ran: false, failed: true };
      } finally {
        reconciling = false;
      }
    })(),
  );
}

/** One guarded reconciliation pass; dependencies are for deterministic tests. */
export function runReconcilePassOnce(
  retryDependencies: PassRetryDependencies = {},
): Promise<{ ran: boolean; failed: boolean }> {
  return guardedReconcilePass(retryDependencies);
}
export async function runScheduledWorkOnce(): Promise<{
  ran: { drain: boolean; reconcile: boolean; sweeps: boolean };
  drained: number;
  failed: {
    drain: boolean;
    reconcile: boolean;
    sweeps: number;
    /** Static sweep names (R105) — safe to return to the external trigger. */
    sweepNames: string[];
    criticalSweeps: number;
  };
}> {
  const sweeps = await guardedSweepPass();
  const drain = await guardedDrainPass();
  const reconcile = await guardedReconcilePass();
  return {
    ran: { drain: drain.ran, reconcile: reconcile.ran, sweeps: sweeps.ran },
    drained: drain.drained,
    failed: {
      drain: drain.failed,
      reconcile: reconcile.failed,
      sweeps: sweeps.failures,
      sweepNames: sweeps.failedSweeps,
      criticalSweeps: sweeps.criticalFailures,
    },
  };
}

// In-process polling worker (modular monolith). Guarded against double-start.
// A fast loop drains the outbox; a slower loop runs the scheduled
// reconciliation sweeps (stuck-submission re-enqueue + duplicate-stamp
// collapse) so INT-09 recovery does not depend on a manual operator trigger;
// a third loop runs the registered R2 compliance sweeps.
export function startWorker(intervalMs = 1_500): void {
  if (workerRestartRequired) {
    logger.error("worker restart required after distributed lock loss");
    return;
  }
  workerStopped = false;
  stopping = false;
  if (workerAbortController.signal.aborted)
    workerAbortController = new AbortController();
  resumeSweeps();
  if (timer) return;

  // Reentrancy guards are module-level (shared with runScheduledWorkOnce):
  // each interval fires on a fixed clock regardless of whether the previous
  // run finished. Without a guard, a run that exceeds its period overlaps the
  // next tick and double-processes (which drives the sweep/reconcile
  // duplication races). The guarded*Pass helpers skip a tick while its prior
  // run is still in flight, and log — rather than silently swallow — errors so
  // a persistently failing loop is visible.

  timer = setInterval(() => {
    void guardedDrainPass();
  }, intervalMs);
  // Do not keep the event loop alive solely for the worker.
  timer.unref?.();

  reconcileTimer = setInterval(() => {
    void guardedReconcilePass();
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();

  sweepTimer = setInterval(() => {
    void guardedSweepPass();
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

/**
 * Clear the stop flag without arming timers — for a test that drained after
 * stopWorker(), or an instance resumed by hand. startWorker clears it too.
 */
export function resumeWorker(): void {
  if (workerRestartRequired) {
    logger.error("worker restart required after distributed lock loss");
    return;
  }
  workerStopped = false;
  stopping = false;
  if (workerAbortController.signal.aborted)
    workerAbortController = new AbortController();
  resumeSweeps();
}

export function stopWorker(): void {
  workerStopped = true;
  stopping = true;
  workerAbortController.abort();
  stopSweeps();
  if (workerRecoveryTimer) {
    clearTimeout(workerRecoveryTimer);
    workerRecoveryTimer = null;
  }
  workerRecoveryFailures = 0;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

type PassRetryDependencies = Pick<WorkerRetryOptions, "random" | "sleep">;

function retryDatabasePass<T>(
  worker: WorkerName,
  operation: () => Promise<T>,
  dependencies: PassRetryDependencies = {},
): Promise<T> {
  return withTransientDatabaseRetry(operation, {
    ...DATABASE_RETRY,
    ...dependencies,
    signal: workerAbortController.signal,
    onRetry: ({ attempt, delayMs, code }) => {
      workerDatabaseRecoveryTotal.inc({ worker, outcome: "retry" });
      logger.warn(
        { worker, attempt, delayMs, code },
        "transient database failure; worker pass will retry",
      );
    },
    onExhausted: ({ attempts, code }) => {
      workerDatabaseRecoveryTotal.inc({ worker, outcome: "exhausted" });
      logger.error(
        { worker, attempts, code },
        "transient database failure exhausted worker pass retries",
      );
    },
    onRecovered: ({ attempts }) => {
      workerDatabaseRecoveryTotal.inc({ worker, outcome: "recovered" });
      logger.info(
        { worker, attempts },
        "worker pass recovered after database retry",
      );
    },
  });
}

const DATABASE_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
} as const;
