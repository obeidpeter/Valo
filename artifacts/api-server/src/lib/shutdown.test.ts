import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGracefulShutdown, type ShutdownDeps } from "./shutdown.ts";

// Graceful shutdown (R101): the sequence, its order, its one-shot guard and
// its deadline — driven with fakes, plus a real child-process signal check.

function fakeDeps(over: Partial<ShutdownDeps> = {}) {
  const order: string[] = [];
  const exits: number[] = [];
  const deps: ShutdownDeps = {
    server: {
      close: (cb?: (err?: Error) => void) => {
        order.push("server.close");
        cb?.();
        return deps.server as never;
      },
      closeIdleConnections: () => order.push("server.closeIdleConnections"),
    },
    markUnready: (reason) => order.push(`markUnready:${reason}`),
    stopWorker: () => order.push("stopWorker"),
    awaitWorkerIdle: async () => {
      order.push("awaitWorkerIdle");
      return true;
    },
    closePool: async () => {
      order.push("closePool");
    },
    exit: (code) => {
      order.push(`exit:${code}`);
      exits.push(code);
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    timeoutMs: 1_000,
    ...over,
  };
  return { deps, order, exits };
}

function runSignalShutdownChild(fatal: boolean): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}> {
  const script = `
    import { writeSync } from "node:fs";
    import { installGracefulShutdown } from "./src/lib/shutdown.ts";
    if (${String(fatal)}) {
      process.env.PIPELINE_HARD_STOP_ON_LOCK_LOSS = "0";
      process.exitCode = 1;
    }
    const server = {
      close(callback) { callback?.(); },
      closeIdleConnections() {},
    };
    installGracefulShutdown({
      server,
      markUnready() { writeSync(1, "shutdown-handler-entered\\n"); },
      stopWorker() {},
      awaitWorkerIdle: async () => true,
      closePool: async () => {},
      exit: (code) => process.exit(code),
      log: { info() {}, warn() {}, error() {} },
      timeoutMs: 1_000,
    });
    // The mock server holds no socket. Keep the child alive until the OS
    // delivers SIGTERM instead of allowing a natural exit with exitCode.
    setInterval(() => {}, 1_000);
    // Windows cannot deliver a catchable POSIX SIGTERM. Exercise the installed
    // handler there; Unix still verifies the actual OS signal path.
    setTimeout(() => {
      if (process.platform === "win32") process.emit("SIGTERM");
      else process.kill(process.pid, "SIGTERM");
    }, 20);
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e", script],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      killSignal: "SIGKILL",
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, output }));
  });
}

test("readiness flips first, then the worker stops, the server drains, the pass settles, the pool closes, exit 0", async () => {
  const { deps, order, exits } = fakeDeps();
  const shutdown = createGracefulShutdown(deps);
  await shutdown("SIGTERM");
  assert.deepEqual(order, [
    "markUnready:shutting_down",
    "stopWorker",
    "server.close",
    "server.closeIdleConnections",
    "awaitWorkerIdle",
    "closePool",
    "exit:0",
  ]);
  assert.deepEqual(exits, [0]);
});

test("a second signal during shutdown is ignored; a pool-close failure still exits 0", async () => {
  const { deps, order, exits } = fakeDeps({
    closePool: async () => {
      throw new Error("pool already ended");
    },
  });
  const shutdown = createGracefulShutdown(deps);
  await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
  assert.equal(order.filter((o) => o === "stopWorker").length, 1, "one-shot");
  assert.deepEqual(exits, [0]);
});

test("the deadline forces exit 1 when a step hangs", async () => {
  const { deps, exits } = fakeDeps({
    timeoutMs: 40,
    awaitWorkerIdle: () => new Promise(() => {}),
  });
  const shutdown = createGracefulShutdown(deps);
  void shutdown("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(exits, [1], "the deadline fired");
});

test("ordinary shutdown waits for active work before closing the pool", async () => {
  let finish!: () => void;
  let entered!: () => void;
  const active = new Promise<boolean>((resolve) => {
    finish = () => resolve(true);
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { deps, order, exits } = fakeDeps({
    awaitWorkerIdle: () => {
      entered();
      return active;
    },
  });
  const shutdown = createGracefulShutdown(deps)("SIGTERM");
  await waiting;
  assert.deepEqual(exits, []);
  assert.ok(!order.includes("closePool"));
  finish();
  await shutdown;
  assert.deepEqual(exits, [0]);
  assert.ok(order.includes("closePool"));
});

test("a fatal SIGTERM keeps its nonzero exit, ordinary SIGTERM stays zero, and the old opt-out is gone", async () => {
  const pipelineSource = readFileSync(
    new URL("../modules/pipeline/scheduler.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    pipelineSource,
    /PIPELINE_HARD_STOP_ON_LOCK_LOSS/,
    "lock-loss termination cannot be disabled by the former environment flag",
  );
  for (const fatal of [true, false]) {
    const result = await runSignalShutdownChild(fatal);
    assert.equal(result.code, fatal ? 1 : 0, result.output);
    assert.equal(result.signal, null, result.output);
    assert.match(result.output, /shutdown-handler-entered/);
  }
});
