import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutboxEvent } from "@workspace/db";
import {
  backoffMs,
  databaseRetryBackoffMs,
  retryDisposition,
  transactionHoldBudgetMs,
} from "./pipeline.ts";
import { outboxLeaseMs } from "./policy.ts";
import { startLeaseHeartbeat } from "./leases.ts";

function environment(values: Record<string, string | undefined>): () => void {
  const previous = Object.keys(values).map(
    (key) => [key, process.env[key]] as const,
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("policy reads configuration at call time and preserves jitter bounds and the rail floor", (t) => {
  const restore = environment({
    OUTBOX_MAX_BACKOFF_MS: undefined,
    OUTBOX_RETRY_HORIZON_MS: "1000",
  });
  t.after(restore);
  const random = t.mock.method(Math, "random", () => 0);
  assert.equal(backoffMs(0), 1000);
  assert.equal(backoffMs(30), 450000);
  random.mock.mockImplementation(() => 1);
  assert.equal(backoffMs(30), 900000);
  process.env.OUTBOX_MAX_BACKOFF_MS = "100.9";
  assert.equal(backoffMs(30), 100);
  const now = new Date("2026-08-01T00:00:00Z");
  const firstAttemptAt = new Date(now.getTime() - 1000);
  const floor = new Date(now.getTime() + 60_000);
  assert.deepEqual(
    retryDisposition({ maxAttempts: 6, firstAttemptAt }, 5, now, floor),
    { dead: false, firstAttemptAt, nextAttemptAt: floor },
  );
  assert.deepEqual(
    retryDisposition({ maxAttempts: 6, firstAttemptAt }, 6, now, floor),
    { dead: true, firstAttemptAt, nextAttemptAt: now },
  );
  const fresh = retryDisposition(
    { maxAttempts: 6, firstAttemptAt: null },
    6,
    now,
  );
  assert.equal(fresh.dead, false);
  assert.equal(fresh.firstAttemptAt, now);
  process.env.OUTBOX_RETRY_HORIZON_MS = "0";
  assert.equal(
    retryDisposition({ maxAttempts: 6, firstAttemptAt: null }, 6, now).dead,
    true,
  );
});

test("database backoff and lease minimum retain their independent configuration", (t) => {
  const restore = environment({
    PIPELINE_DB_RETRY_BASE_MS: "250",
    RAIL_TIMEOUT_MS: "1",
    OUTBOX_LEASE_MS: "1",
  });
  t.after(restore);
  assert.deepEqual(
    [0, 1, 2, 20].map(databaseRetryBackoffMs),
    [250, 250, 500, 30000],
  );
  process.env.PIPELINE_DB_RETRY_BASE_MS = "invalid";
  assert.equal(databaseRetryBackoffMs(1), 1000);
  assert.equal(transactionHoldBudgetMs(), 30004);
  assert.equal(outboxLeaseMs(), 30004);
  process.env.OUTBOX_LEASE_MS = "90000.9";
  assert.equal(outboxLeaseMs(), 90000);
  process.env.RAIL_TIMEOUT_MS = "30000";
  assert.equal(outboxLeaseMs(), 150000);
});

test("heartbeat never overlaps renewals and stop waits for a failed in-flight renewal", async (t) => {
  const restore = environment({
    RAIL_TIMEOUT_MS: "1",
    OUTBOX_LEASE_MS: "30004",
  });
  t.after(restore);
  t.mock.timers.enable({ apis: ["setInterval"] });
  let reject!: (error: Error) => void;
  let renewals = 0;
  const renewal = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const stop = startLeaseHeartbeat(
    { id: "heartbeat-boundary", correlationId: null } as OutboxEvent,
    () => {
      renewals++;
      return renewal;
    },
  );
  try {
    t.mock.timers.tick(10001);
    t.mock.timers.tick(30003);
    assert.equal(renewals, 1);
    let settled = false;
    const stopping = stop().then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    reject(new Error("fixture renewal failure"));
    await stopping;
    t.mock.timers.tick(30003);
    assert.equal(renewals, 1);
  } finally {
    reject(new Error("fixture cleanup"));
    await stop();
  }
});
