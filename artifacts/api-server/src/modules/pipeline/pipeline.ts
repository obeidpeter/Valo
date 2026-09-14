// Compatibility facade for the async submission pipeline. Scheduler state and
// built-in sweep registration have one owner; feature modules keep importing here.
export {
  drain,
  runDrainPassOnce,
  runReconcilePassOnce,
  runScheduledWorkOnce,
  runSweepPassOnce,
  startWorker,
  stopWorker,
  resumeWorker,
} from "./scheduler";
export { registerHandler, type HandlerOutcome } from "./handlers";
export { reconcile } from "./reconciliation";
export {
  listDeadLetters,
  listRetrying,
  replayDead,
  sweepPipelineRetention,
  sweepOutboxGauges,
  type QueuePage,
} from "./queue-queries";
export {
  backoffMs,
  databaseRetryBackoffMs,
  retryDisposition,
  transactionHoldBudgetMs,
} from "./policy";
export { startLeaseHeartbeat } from "./leases";
export {
  registerSweep,
  unregisterSweep,
  listSweeps,
  orderedSweeps,
  runSweepsOnce,
  defaultSweepTimeoutMs,
  sweepSettleCeilingMs,
  SWEEP_PASS_ABANDONED_ACTION,
  SweepTimeoutError,
  type RegisteredSweep,
  type SweepFailureReport,
} from "./sweeps";
export { awaitWorkerIdle, inFlightPasses } from "./in-flight";
