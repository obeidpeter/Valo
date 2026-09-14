import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import * as pipeline from "./pipeline.ts";
import * as scheduler from "./scheduler.ts";
import * as handlers from "./handlers.ts";
import * as leases from "./leases.ts";
import * as policy from "./policy.ts";
import * as queue from "./queue-queries.ts";
import * as reconciliation from "./reconciliation.ts";
import * as sweeps from "./sweeps.ts";
import * as inFlight from "./in-flight.ts";

const source = (name: string) =>
  ts.createSourceFile(
    name,
    readFileSync(new URL(name, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

test("the facade retains exactly the public runtime exports and their singleton identity", () => {
  const expected = {
    ...scheduler,
    registerHandler: handlers.registerHandler,
    startLeaseHeartbeat: leases.startLeaseHeartbeat,
    backoffMs: policy.backoffMs,
    databaseRetryBackoffMs: policy.databaseRetryBackoffMs,
    retryDisposition: policy.retryDisposition,
    transactionHoldBudgetMs: policy.transactionHoldBudgetMs,
    ...queue,
    reconcile: reconciliation.reconcile,
    registerSweep: sweeps.registerSweep,
    unregisterSweep: sweeps.unregisterSweep,
    listSweeps: sweeps.listSweeps,
    orderedSweeps: sweeps.orderedSweeps,
    runSweepsOnce: sweeps.runSweepsOnce,
    defaultSweepTimeoutMs: sweeps.defaultSweepTimeoutMs,
    sweepSettleCeilingMs: sweeps.sweepSettleCeilingMs,
    SWEEP_PASS_ABANDONED_ACTION: sweeps.SWEEP_PASS_ABANDONED_ACTION,
    SweepTimeoutError: sweeps.SweepTimeoutError,
    awaitWorkerIdle: inFlight.awaitWorkerIdle,
    inFlightPasses: inFlight.inFlightPasses,
  };
  assert.deepEqual(Object.keys(pipeline).sort(), Object.keys(expected).sort());
  for (const name of Object.keys(expected) as (keyof typeof expected)[]) {
    assert.equal(pipeline[name], expected[name], name);
  }
  for (const statement of source("pipeline.ts").statements) {
    assert.ok(
      ts.isExportDeclaration(statement),
      "the facade owns no state or work",
    );
    assert.ok(
      statement.exportClause,
      "explicit exports avoid leaking internals",
    );
  }
});

test("the facade preserves public types, handler registration, and built-in sweep order", async () => {
  const outcome: pipeline.HandlerOutcome = { kind: "done" };
  const page: pipeline.QueuePage = { items: [], nextCursor: null };
  const report: pipeline.SweepFailureReport = { failed: [], critical: 0 };
  const sweep: pipeline.RegisteredSweep = {
    name: "test.facade-types",
    timeoutMs: 100,
    run: async () => outcome,
  };
  assert.deepEqual(await sweep.run(new AbortController().signal), outcome);
  assert.equal(page.nextCursor, null);
  assert.equal(report.critical, 0);
  const name = "test.facade-handler";
  const previous = handlers.HANDLERS[name];
  try {
    const handler = async () => outcome;
    pipeline.registerHandler(name, handler);
    assert.equal(handlers.HANDLERS[name], handler);
  } finally {
    if (previous) handlers.HANDLERS[name] = previous;
    else delete handlers.HANDLERS[name];
  }
  assert.deepEqual(
    pipeline
      .listSweeps()
      .filter((entry) => entry.name.startsWith("pipeline."))
      .map(({ name, critical }) => ({ name, critical })),
    [
      { name: "pipeline.retention", critical: false },
      { name: "pipeline.gauges", critical: true },
    ],
  );
});

test("extracted modules have one-way internal dependencies and never import the facade", () => {
  const dependencies: Record<string, string[]> = {
    "scheduler.ts": [
      "./processing",
      "./reconciliation",
      "./queue-queries",
      "./policy",
      "./sweeps",
      "./in-flight",
      "./distributed-lock",
      "./db-retry",
    ],
    "processing.ts": ["./submission", "./handlers", "./leases", "./policy"],
    "submission.ts": ["./handlers"],
    "reconciliation.ts": ["./db-retry", "./submission"],
    "leases.ts": ["./db-retry", "./policy"],
    "handlers.ts": [],
    "policy.ts": [],
    "queue-queries.ts": [],
    "sweeps.ts": ["./in-flight", "./db-retry"],
    "in-flight.ts": [],
    "distributed-lock.ts": [],
    "db-retry.ts": [],
  };
  for (const [file, expected] of Object.entries(dependencies)) {
    const actual = source(file).statements.flatMap((statement) => {
      if (!ts.isImportDeclaration(statement)) return [];
      const name = (statement.moduleSpecifier as ts.StringLiteral).text;
      return name.startsWith("./") ? [name] : [];
    });
    assert.deepEqual(actual.sort(), [...expected].sort(), file);
  }
  const visit = (file: string, ancestors: string[]) => {
    assert.ok(!ancestors.includes(file), [...ancestors, file].join(" -> "));
    for (const next of dependencies[file] ?? []) {
      visit(next.slice(2) + ".ts", [...ancestors, file]);
    }
  };
  for (const file of Object.keys(dependencies)) visit(file, []);
});

function transactionDepth(node: ts.Node): number {
  let depth = 0;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isCallExpression(parent) &&
      parent.expression.getText() === "runInBypassContext"
    )
      depth++;
  }
  return depth;
}

function calls(file: string, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === name) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source(file));
  return found;
}

test("submission and reconciliation keep authority I/O between short database stages", () => {
  for (const [file, name, depth] of [
    ["processing.ts", "prepareInvoiceSubmit", 1],
    ["processing.ts", "performInvoiceRailCall", 0],
    ["processing.ts", "finalizeInvoiceSubmit", 1],
    ["reconciliation.ts", "recoverExistingStamp", 0],
    ["reconciliation.ts", "persistStamp", 1],
  ] as const) {
    const found = calls(file, name);
    assert.equal(found.length, 1, name);
    assert.equal(transactionDepth(found[0]!), depth, name);
  }
  assert.equal(calls("submission.ts", "runInBypassContext").length, 0);
  assert.equal(calls("scheduler.ts", "runInBypassContext").length, 0);
  assert.equal(calls("processing.ts", "runInBypassContext").length, 5);
  assert.equal(calls("reconciliation.ts", "runInBypassContext").length, 4);
  assert.equal(calls("leases.ts", "runInBypassContext").length, 1);
});
