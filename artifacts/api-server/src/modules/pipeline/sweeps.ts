import { runInBypassContext } from "@workspace/db";
import { alertOnceViaAuditLedger } from "../clerk/watch-shared";
import { logger } from "../../lib/logger";
import {
  sweepRunsTotal,
  sweepErrorsTotal,
  sweepLastSuccess,
  sweepLastSuccessBySweep,
  sweepDurationSeconds,
} from "../../lib/metrics";
import { track } from "./in-flight";
import { classifyPostgresFailure } from "./db-retry";

// The compliance sweep registry and pass runner (R107: extracted from
// pipeline.ts, now a facade over scheduler.ts for the drain, reconciliation and
// guarded passes that hold the distributed locks). Transaction-neutral: it
// never opens a database context of its own except to scope the
// abandoned-pass alert.
//
// Registered by feature modules at import time so the worker core does not
// import them. Sweep hygiene (R101): every sweep is NAMED — the name labels
// its error counter, its last-success gauge and its duration histogram, and
// is the word in the log line — and runs under a per-sweep timeout so one
// hung sweep cannot pin the whole pass (and with it every later tick, which
// the reentrancy guard would skip forever). The pass moves on after a timeout,
// but owns the underlying work and its distributed lock until actual settlement.
export interface RegisteredSweep {
  name: string;
  run: (signal: AbortSignal) => Promise<unknown>;
  /** 0 = the deployment default (SWEEP_TIMEOUT_MS), read at run time. */
  timeoutMs: number;
  /** false = best-effort: its failure is reported (metrics, the trigger's
   *  `degraded` list) but never fails the pass heartbeat or the external
   *  trigger. Absent = critical (R105). */
  critical?: boolean;
}

/** Names and criticality of the sweeps that failed in one pass (R105). */
export interface SweepFailureReport {
  failed: string[];
  critical: number;
  databaseFailure?: unknown;
}

const SWEEPS: RegisteredSweep[] = [];
const activeSweeps = new Map<
  string,
  { work: Promise<unknown>; controller: AbortController; timeoutMs: number }
>();
const SWEEP_NAME = /^[a-z][a-z0-9_.-]{1,63}$/;
const DEFAULT_SWEEP_TIMEOUT_MS = 120_000;

export function defaultSweepTimeoutMs(): number {
  const configured = Number(process.env.SWEEP_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_SWEEP_TIMEOUT_MS;
}

export function registerSweep(
  name: string,
  sweep: () => Promise<unknown>,
  opts?: { timeoutMs?: number; acceptsSignal?: false; critical?: boolean },
): void;
export function registerSweep(
  name: string,
  sweep: (signal: AbortSignal) => Promise<unknown>,
  opts: { timeoutMs?: number; acceptsSignal: true; critical?: boolean },
): void;
export function registerSweep(
  name: string,
  sweep: (() => Promise<unknown>) | ((signal: AbortSignal) => Promise<unknown>),
  opts: {
    timeoutMs?: number;
    acceptsSignal?: boolean;
    critical?: boolean;
  } = {},
): void {
  if (!SWEEP_NAME.test(name)) {
    throw new Error(`Sweep name "${name}" must match ${SWEEP_NAME}`);
  }
  if (SWEEPS.some((s) => s.name === name)) {
    throw new Error(`Sweep "${name}" is already registered`);
  }
  // Legacy sweeps may accept optional dependency objects. Never pass a signal
  // as that argument unless registration explicitly opts into cancellation.
  const run = opts.acceptsSignal
    ? (sweep as (signal: AbortSignal) => Promise<unknown>)
    : () => (sweep as () => Promise<unknown>)();
  SWEEPS.push({
    name,
    run,
    timeoutMs: opts.timeoutMs ?? 0,
    critical: opts.critical ?? true,
  });
}

/** Remove a sweep by name (tests register salted sweeps and take them out). */
export function unregisterSweep(name: string): boolean {
  const at = SWEEPS.findIndex((s) => s.name === name);
  if (at === -1) return false;
  SWEEPS.splice(at, 1);
  return true;
}

export function listSweeps(): {
  name: string;
  timeoutMs: number;
  critical: boolean;
}[] {
  return SWEEPS.map((s) => ({
    name: s.name,
    timeoutMs: s.timeoutMs || defaultSweepTimeoutMs(),
    critical: s.critical !== false,
  }));
}

// R105: how long a pass keeps its ownership (the in-process guard and the
// distributed lock) waiting for a timed-out sweep to settle. Past this ceiling
// the pass counts, alerts once per stuck sweep and releases ownership, so a
// sweep that ignores its abort signal can no longer stall every later pass
// until a restart. The abandoned work stays tracked for shutdown, and a later
// pass skips a sweep that is still in flight (the in_flight failure kind).
// Unset = twice the stuck sweep's own timeout — a sweep gets three budgets in
// total before it is abandoned — so a sweep registered with a long timeout is
// never abandoned early by a fleet-wide constant.
export function sweepSettleCeilingMs(stuckTimeouts: number[] = []): number {
  const configured = Number(process.env.SWEEP_SETTLE_CEILING_MS);
  if (Number.isFinite(configured) && configured >= 1_000)
    return Math.floor(configured);
  const longest = Math.max(defaultSweepTimeoutMs(), ...stuckTimeouts);
  return 2 * longest;
}

export const SWEEP_PASS_ABANDONED_ACTION = "ops.sweep.pass_abandoned";
const alertPassAbandoned = alertOnceViaAuditLedger({
  action: SWEEP_PASS_ABANDONED_ACTION,
  entityType: "sweep",
  actorId: "pipeline",
});

/** Wait for a pass's sweeps to settle, up to the ceiling; false = abandoned. */
export async function settleOwnedWork(
  owned: Promise<unknown>[],
): Promise<boolean> {
  if (owned.length === 0) return true;
  const ceilingMs = sweepSettleCeilingMs(
    [...activeSweeps.values()].map((active) => active.timeoutMs),
  );
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ceilingMs);
  });
  const settled = await Promise.race([
    Promise.allSettled(owned).then(() => true),
    deadline,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (settled) return true;
  const stuck = [...activeSweeps.keys()];
  sweepErrorsTotal.inc({ sweep: "pass", kind: "abandoned" });
  logger.error(
    { stuck, ceilingMs },
    "compliance sweep pass abandoned: ownership released while a sweep is still unsettled",
  );
  for (const name of stuck) {
    try {
      // The pass may be HTTP-triggered (no ambient context): scope the alert.
      await runInBypassContext(() =>
        alertPassAbandoned(
          name,
          {
            ceilingMs,
            reason:
              "A sweep ignored its timeout and abort signal past the settle ceiling; the pass released its lock so later passes can run. Investigate the sweep's external calls.",
          },
          "compliance sweep abandoned past the settle ceiling",
        ),
      );
    } catch (err) {
      logger.error(
        { err, sweep: name },
        "could not record the abandoned-sweep alert",
      );
    }
  }
  return false;
}

export class SweepTimeoutError extends Error {
  constructor(
    readonly sweep: string,
    readonly timeoutMs: number,
  ) {
    super(`Sweep "${sweep}" exceeded ${timeoutMs}ms`);
    this.name = "SweepTimeoutError";
  }
}

function withSweepTimeout<T>(
  name: string,
  work: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new SweepTimeoutError(name, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Set by stopWorker (scheduler.ts): a stopping pass fails its remaining sweeps
// instead of starting them, and every sweep in flight is asked to stop
// through its abort signal.
let stopping = false;

export function stopSweeps(): void {
  stopping = true;
  for (const { controller } of activeSweeps.values()) {
    controller.abort(new Error("Worker is stopping"));
  }
}

export function resumeSweeps(): void {
  stopping = false;
}

// Run sweeps sequentially so one guard covers the whole pass and they don't
// contend for pool connections; a failing or timed-out sweep is counted under
// its NAME and logged, not silently dropped, and does not abort its siblings.
// A sweep may cross external boundaries or have a cadence gate that skips a
// repeated call. Surface database failures without replaying the whole sweep;
// the normal schedule owns its next attempt.
// Exported over an explicit list so a test can drive it without touching the
// registry.
export async function runSweepsOnce(
  sweeps: RegisteredSweep[],
  owned: Promise<unknown>[] = [],
  report?: SweepFailureReport,
  passSignal?: AbortSignal,
): Promise<number> {
  let failures = 0;
  const note = (sweep: RegisteredSweep) => {
    if (!report) return;
    report.failed.push(sweep.name);
    if (sweep.critical !== false) report.critical += 1;
  };
  for (const sweep of sweeps) {
    if (stopping || passSignal?.aborted) {
      failures += 1;
      if (report) report.critical += 1;
      break;
    }
    if (activeSweeps.has(sweep.name)) {
      failures += 1;
      note(sweep);
      sweepErrorsTotal.inc({ sweep: sweep.name, kind: "in_flight" });
      continue;
    }
    const timeoutMs = sweep.timeoutMs || defaultSweepTimeoutMs();
    const stop = sweepDurationSeconds.startTimer({ sweep: sweep.name });
    const controller = new AbortController();
    const abortForPass = () => controller.abort(passSignal?.reason);
    passSignal?.addEventListener("abort", abortForPass, { once: true });
    if (passSignal?.aborted) abortForPass();
    const work = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return sweep.run(controller.signal);
    });
    activeSweeps.set(sweep.name, { work, controller, timeoutMs });
    owned.push(work);
    track(work);
    void work
      .finally(() => {
        activeSweeps.delete(sweep.name);
        passSignal?.removeEventListener("abort", abortForPass);
      })
      .catch(() => {});
    try {
      await withSweepTimeout(sweep.name, work, timeoutMs, controller);
      sweepLastSuccessBySweep.setToCurrentTime({ sweep: sweep.name });
      stop({ outcome: "ok" });
    } catch (err) {
      failures += 1;
      note(sweep);
      const kind =
        err instanceof SweepTimeoutError
          ? "timeout"
          : controller.signal.aborted && err === controller.signal.reason
            ? "stopped"
            : "error";
      sweepErrorsTotal.inc({ sweep: sweep.name, kind });
      stop({ outcome: kind });
      const failure = classifyPostgresFailure(err);
      if (failure.transient && report) report.databaseFailure = err;
      if (failure.transient) {
        logger.warn(
          { sweep: sweep.name, code: failure.code },
          "database failure in compliance sweep; waiting for the next scheduled pass",
        );
      } else if (kind !== "stopped") {
        logger.error(
          { err, sweep: sweep.name, timeoutMs },
          "compliance sweep failed",
        );
      }
    }
  }
  return failures;
}

/** R106: the order a pass runs the registry in — every critical sweep first
 *  (registration order), then the best-effort ones, so statutory work never
 *  queues behind a best-effort model-calling sweep such as the Clerk
 *  generation sweeps. `listSweeps()` keeps registration order. */
export function orderedSweeps<T extends { critical?: boolean }>(
  sweeps: readonly T[],
): T[] {
  return [
    ...sweeps.filter((s) => s.critical !== false),
    ...sweeps.filter((s) => s.critical === false),
  ];
}

/** One pass over the registry — critical sweeps first — recording the
 *  pass-health gauges. Called by the guarded pass in scheduler.ts. */
export async function runRegisteredSweeps(
  owned: Promise<unknown>[],
  report: SweepFailureReport,
  passSignal?: AbortSignal,
): Promise<number> {
  const failures = await runSweepsOnce(
    orderedSweeps(SWEEPS),
    owned,
    report,
    passSignal,
  );
  // Record pass health for scraping: the run counter advances every pass (the
  // loop-liveness signal — a stalled minute loop, e.g. an Autoscale instance
  // frozen overnight, stops it — OBS-01), while last_success only advances
  // when every sweep in the pass succeeded, so a pass that runs but fails is
  // an alertable condition rather than a green gauge.
  sweepRunsTotal.inc();
  if (failures === 0) sweepLastSuccess.setToCurrentTime();
  return failures;
}
