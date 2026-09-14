// In-flight worker passes and sweeps, so a graceful shutdown (lib/shutdown.ts)
// can wait for the work that is running rather than cut it off
// mid-transaction. Shared by the worker loops (scheduler.ts) and the sweep
// runner (sweeps.ts); R107 moved it out of pipeline.ts.
const inFlight = new Set<Promise<unknown>>();
export function track<T>(pass: Promise<T>): Promise<T> {
  inFlight.add(pass);
  void pass.finally(() => inFlight.delete(pass)).catch(() => {});
  return pass;
}

/** Resolve true once every in-flight pass has settled, false on timeout. */
export async function awaitWorkerIdle(timeoutMs: number): Promise<boolean> {
  if (inFlight.size === 0) return true;
  const settled = (async () => {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    return true;
  })();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function inFlightPasses(): number {
  return inFlight.size;
}
