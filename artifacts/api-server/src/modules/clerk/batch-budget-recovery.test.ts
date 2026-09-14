import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  getDb,
  pool,
  type PoolClient,
  clerkBatchesTable,
  clerkCasesTable,
  clerkInferenceCallsTable,
  firmsTable,
  usersTable,
} from "@workspace/db";
import {
  createClerkBatch,
  processBatch,
  sweepClerkBatches,
} from "./batch-async";
import { firmClerkUsage } from "./budget";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support";

before(saveAndEnableClerkFlag);
after(restoreClerkFlag);

async function fixture(t: TestContext) {
  const firmId = randomUUID();
  const userId = randomUUID();
  await getDb()
    .insert(firmsTable)
    .values({ id: firmId, name: `Budget recovery ${firmId}` });
  await getDb()
    .insert(usersTable)
    .values({ id: userId, email: `${userId}@test.example` });
  const source = `Bundle ${randomUUID()}`;
  const batch = await createClerkBatch(
    { sourceType: "text", text: source },
    userId,
    { firmId },
  );
  t.after(async () => {
    // Failed/retained fixtures must not become work for unrelated later sweeps.
    await getDb()
      .update(clerkBatchesTable)
      .set({
        status: "failed",
        failReason: "Synthetic recovery fixture completed",
        sourceText: null,
        segments: null,
        sourcePdfB64: null,
        scanSegments: null,
        claimedAt: null,
      })
      .where(
        and(
          eq(clerkBatchesTable.id, batch.id),
          inArray(clerkBatchesTable.status, ["queued", "processing"]),
        ),
      );
  });
  const read = async () => {
    const [row] = await getDb()
      .select()
      .from(clerkBatchesTable)
      .where(eq(clerkBatchesTable.id, batch.id));
    return row;
  };
  return { firmId, userId, source, batch, read };
}

// Fail the actual budget SQL, leaving transactions, claims and writes real.
async function failBudgetRead(t: TestContext, nth = 1) {
  const error = new Error("synthetic budget database unavailable");
  const client = await pool.connect();
  const prototype = Object.getPrototypeOf(client) as PoolClient;
  client.release();
  const query = prototype.query;
  let reads = 0;
  let enabled = true;
  t.mock.method(
    prototype,
    "query",
    function (this: PoolClient, ...args: unknown[]) {
      const config = args[0];
      const text =
        typeof config === "string"
          ? config
          : config && typeof config === "object" && "text" in config
            ? String(config.text)
            : "";
      if (
        enabled &&
        text.includes('from "firm_subscriptions"') &&
        ++reads === nth
      ) {
        return Promise.reject(error);
      }
      return Reflect.apply(query, this, args);
    },
  );
  return {
    stop: () => {
      enabled = false;
    },
  };
}

function assertBudgetFailure(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.ok(error.cause instanceof Error);
  assert.equal(error.cause.message, "synthetic budget database unavailable");
  return true;
}

const neverGateway = () =>
  fakeGateway(() =>
    assert.fail("provider must not run after a budget lookup failure"),
  );

test("budget lookup failure before segmentation retains source and the live claim", async (t) => {
  const f = await fixture(t);
  const fault = await failBudgetRead(t);
  await assert.rejects(
    processBatch(f.batch.id, neverGateway()),
    assertBudgetFailure,
  );
  fault.stop();
  const row = await f.read();
  assert.equal(row.status, "processing");
  assert.ok(row.claimedAt);
  assert.equal(row.failReason, null);
  assert.equal(row.sourceText, f.source);
  assert.equal(row.segments, null);
  assert.equal(row.processedSegments, 0);
  assert.equal(
    await processBatch(f.batch.id, neverGateway()),
    "noop",
    "a fresh claim cannot be stolen",
  );
});

test("a mid-slice budget outage preserves cursor and duplicate counts, then stale-claim recovery resumes once", async (t) => {
  const f = await fixture(t);
  const first = `Invoice A ${randomUUID()}`;
  const second = `Invoice B ${randomUUID()}`;
  let segmentationCalls = 0;
  let extractionCalls = 0;
  const gateway = fakeGateway((request) => {
    if (request.schemaName === "invoice_segmentation") {
      segmentationCalls++;
      return JSON.stringify({
        invoices: [first, first, second].map((text) => ({ text, label: text })),
      });
    }
    extractionCalls++;
    return JSON.stringify({
      fields: [
        {
          field: "invoiceNumber",
          value: randomUUID(),
          confidence: 0.9,
          sourceSnippet: null,
        },
      ],
      lines: [],
    });
  });
  const fault = await failBudgetRead(t, 4);
  await assert.rejects(processBatch(f.batch.id, gateway), assertBudgetFailure);
  fault.stop();
  const mid = await f.read();
  assert.equal(mid.status, "processing");
  assert.equal(mid.failReason, null);
  assert.equal(mid.processedSegments, 2);
  assert.equal(mid.createdCases, 1);
  assert.equal(mid.skippedDuplicates, 1);
  assert.deepEqual(
    mid.segments?.map((segment) => segment.text),
    [first, first, second],
  );
  assert.equal(segmentationCalls, 1);
  assert.equal(extractionCalls, 1);
  assert.equal(await processBatch(f.batch.id, gateway), "noop");
  await getDb()
    .update(clerkBatchesTable)
    .set({ claimedAt: new Date(Date.now() - 11 * 60_000) })
    .where(eq(clerkBatchesTable.id, f.batch.id));
  const outcomes = await Promise.all([
    processBatch(f.batch.id, gateway),
    processBatch(f.batch.id, gateway),
  ]);
  assert.deepEqual(outcomes.sort(), ["noop", "terminal"]);
  const done = await f.read();
  assert.equal(done.status, "done");
  assert.equal(done.processedSegments, 3);
  assert.equal(done.createdCases, 2);
  assert.equal(done.skippedDuplicates, 1);
  assert.equal(done.segments, null);
  assert.equal(segmentationCalls, 1, "recovery does not segment again");
  assert.equal(
    extractionCalls,
    2,
    "recovery only extracts the remaining invoice",
  );
  const cases = await getDb()
    .select()
    .from(clerkCasesTable)
    .where(eq(clerkCasesTable.batchId, f.batch.id));
  assert.equal(cases.length, 2);
});

test("budget outage preserves retained scan bytes and page ranges before extraction", async (t) => {
  const f = await fixture(t);
  const sourcePdfB64 = Buffer.from(
    "synthetic scan bytes; must never be rasterized in this test",
  ).toString("base64");
  const scanSegments = [
    { startPage: 1, endPage: 1, label: "Retained invoice" },
  ];
  await getDb()
    .update(clerkBatchesTable)
    .set({
      sourceKind: "scan",
      sourceText: null,
      sourcePdfB64,
      scanSegments,
      totalSegments: 1,
    })
    .where(eq(clerkBatchesTable.id, f.batch.id));
  const fault = await failBudgetRead(t);
  await assert.rejects(
    processBatch(f.batch.id, neverGateway()),
    assertBudgetFailure,
  );
  fault.stop();
  const row = await f.read();
  assert.equal(row.status, "processing");
  assert.equal(row.failReason, null);
  assert.equal(row.sourcePdfB64, sourcePdfB64);
  assert.deepEqual(row.scanSegments, scanSegments);
  assert.equal(row.processedSegments, 0);
});

async function exhaustBudget(firmId: string) {
  const usage = await firmClerkUsage(firmId);
  await getDb().insert(clerkInferenceCallsTable).values({
    firmId,
    purpose: "extract_invoice",
    model: "budget-recovery-test",
    promptVersion: "test",
    inputRef: randomUUID(),
    schemaValid: true,
    outcome: "ok",
    promptTokens: usage.budgetTokens,
    completionTokens: 0,
  });
}

test("actual exhaustion still parks an unsegmented batch and terminally fails segmented work", async (t) => {
  const f = await fixture(t);
  await exhaustBudget(f.firmId);
  assert.equal(await processBatch(f.batch.id, neverGateway()), "parked");
  const parked = await f.read();
  assert.equal(parked.status, "queued");
  assert.equal(parked.sourceText, f.source);
  assert.equal(parked.failReason, null);
  await getDb()
    .update(clerkBatchesTable)
    .set({
      segments: [
        { label: "first", text: "first" },
        { label: "next", text: "next" },
      ],
      totalSegments: 2,
      processedSegments: 1,
      createdCases: 1,
    })
    .where(eq(clerkBatchesTable.id, f.batch.id));
  assert.equal(await processBatch(f.batch.id, neverGateway()), "terminal");
  const failed = await f.read();
  assert.equal(failed.status, "failed");
  assert.match(failed.failReason ?? "", /allowance ran out after 1 invoice/);
  assert.equal(failed.createdCases, 1);
  assert.equal(failed.processedSegments, 1);
  assert.equal(failed.sourceText, null);
  assert.equal(failed.segments, null);
});

test("sweep budget lookup failures propagate without claiming or rewriting the candidate", async (t) => {
  const f = await fixture(t);
  await getDb()
    .update(clerkBatchesTable)
    .set({ createdAt: new Date(0) })
    .where(eq(clerkBatchesTable.id, f.batch.id));
  const before = await f.read();
  const fault = await failBudgetRead(t);
  await assert.rejects(sweepClerkBatches(), assertBudgetFailure);
  fault.stop();
  assert.deepEqual(await f.read(), before);
  // The real exhausted-budget peek also leaves retention timestamps untouched.
  await exhaustBudget(f.firmId);
  await sweepClerkBatches();
  assert.deepEqual(await f.read(), before);
});
