import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, type TestContext } from "node:test";
import { getTableColumns, type Table } from "drizzle-orm";
import {
  pool,
  hasDatabaseContext,
  invoicesTable,
  outboxTable,
  partiesTable,
  railStatesTable,
  type OutboxEvent,
} from "@workspace/db";
import { setRailTransport, type StampResult } from "../rails/adapter.ts";
import {
  drain,
  reconcile,
  registerHandler,
  resumeWorker,
  stopWorker,
  type HandlerOutcome,
} from "./pipeline.ts";

const id = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000002";
const now = new Date("2026-08-01T00:00:00Z");
const invoice = {
  id,
  firmId: id,
  supplierPartyId: id,
  buyerPartyId: id,
  invoiceNumber: "BOUNDARY-1",
  kind: "invoice",
  status: "submitted",
  currency: "NGN",
  issueDate: "2026-08-01",
  subtotal: "100",
  vatTotal: "7.5",
  grandTotal: "107.5",
  createdAt: now,
  updatedAt: now,
};
const event = (type: string) =>
  ({
    id: eventId,
    aggregateType: "test",
    aggregateId: id,
    type,
    payload: { invoiceId: id, private: "fixture" },
    correlationId: "boundary-request",
    status: "processing",
    attempts: 2,
    maxAttempts: 6,
    firstAttemptAt: now,
    parkCount: 3,
    parkedUntil: null,
    nextAttemptAt: now,
    lockedAt: now,
    lockToken: "00000000-0000-4000-8000-000000000003",
    lockExpiresAt: new Date(now.getTime() + 60000),
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }) as OutboxEvent;

function row(table: Table, values: Record<string, unknown>): unknown[] {
  return Object.keys(getTableColumns(table)).map((key) => {
    const value = values[key] ?? null;
    return value instanceof Date ? value.toISOString() : value;
  });
}

type Command = { text: string; values: unknown[]; transaction: number };
function database(
  t: TestContext,
  answer: (command: Command) => unknown[][] | object[],
) {
  const commands: Command[] = [];
  let active = 0;
  let transactions = 0;
  t.mock.method(pool, "query", async () =>
    assert.fail("unexpected unscoped database access"),
  );
  t.mock.method(pool, "connect", async () => {
    active++;
    const transaction = ++transactions;
    return Object.assign(new EventEmitter(), {
      query: async (
        config: string | { text: string; values?: unknown[] },
        values?: unknown[],
      ) => {
        const command = {
          text: typeof config === "string" ? config : config.text,
          values:
            values ?? (typeof config === "string" ? [] : (config.values ?? [])),
          transaction,
        };
        commands.push(command);
        const rows = answer(command);
        return { rows, rowCount: rows.length, fields: [] };
      },
      release: () => {
        active--;
      },
    });
  });
  return { commands, active: () => active };
}

function updateValue(command: Command, column: string): unknown {
  const match = command.text.match(
    new RegExp('"' + column + '" = \\$([0-9]+)'),
  );
  assert.ok(match, column);
  return command.values[Number(match[1]) - 1];
}

for (const outcome of [
  { kind: "done" },
  {
    kind: "retry",
    error: "RAIL_TIMEOUT",
    notBefore: new Date("2099-01-01T00:00:00Z"),
  },
  { kind: "dead", error: "terminal fixture" },
  {
    kind: "park",
    error: "RAIL_UNAVAILABLE",
    until: new Date("2099-01-01T00:00:00Z"),
  },
] satisfies HandlerOutcome[]) {
  test(
    "registered handler outcome keeps atomic bookkeeping: " + outcome.kind,
    async (t) => {
      const claimed = event("inbound.boundary." + outcome.kind);
      const db = database(t, ({ text }) => {
        if (text.includes("FOR UPDATE SKIP LOCKED"))
          return [row(outboxTable, claimed)];
        if (text.includes("SELECT id FROM outbox_events"))
          return [{ id: eventId }];
        if (text.startsWith('update "outbox_events"')) return [[eventId]];
        return [];
      });
      registerHandler(claimed.type, async (actual) => {
        assert.equal(actual.maxAttempts, 6);
        assert.equal(actual.parkCount, 3);
        assert.equal(hasDatabaseContext(), true);
        assert.equal(
          db.commands.filter((command) => command.text === "COMMIT").length,
          1,
        );
        return outcome;
      });
      resumeWorker();
      assert.equal(await drain(1), 1);
      const updates = db.commands.filter((command) =>
        command.text.startsWith('update "outbox_events"'),
      );
      assert.equal(updates.length, 2);
      const finalized = updates[1]!;
      const fence = db.commands.find((command) =>
        command.text.trimStart().startsWith("SELECT id FROM outbox_events"),
      )!;
      assert.equal(finalized.transaction, fence.transaction);
      assert.notEqual(finalized.transaction, updates[0]!.transaction);
      assert.ok(
        finalized.values.includes(claimed.lockToken),
        "final update checks the lease token",
      );
      for (const column of ["locked_at", "lock_token", "lock_expires_at"]) {
        assert.equal(updateValue(finalized, column), null);
      }
      assert.equal(
        updateValue(finalized, "status"),
        outcome.kind === "done"
          ? "done"
          : outcome.kind === "dead"
            ? "dead"
            : "pending",
      );
      if (outcome.kind === "park") {
        assert.doesNotMatch(
          finalized.text,
          /"attempts" =|"first_attempt_at" =/,
        );
        assert.equal(updateValue(finalized, "park_count"), 4);
        assert.match(
          String(updateValue(finalized, "last_error")),
          /^RAIL_UNAVAILABLE: parked until /,
        );
      } else {
        assert.equal(updateValue(finalized, "attempts"), 3);
        assert.equal(
          updateValue(finalized, "first_attempt_at"),
          now.toISOString(),
        );
        if (outcome.kind === "done") {
          assert.deepEqual(
            JSON.parse(String(updateValue(finalized, "payload"))),
            { redacted: true },
          );
        } else if (outcome.kind === "retry") {
          assert.equal(
            updateValue(finalized, "next_attempt_at"),
            outcome.notBefore.toISOString(),
          );
        }
      }
      assert.equal(db.commands.at(-1)?.text, "COMMIT");
      assert.equal(db.active(), 0);
    },
  );
}

function invoiceRows(command: Command): unknown[][] | object[] {
  if (command.text.includes('from "invoices"'))
    return [row(invoicesTable, invoice)];
  if (command.text.includes('from "parties"')) {
    return [row(partiesTable, { id, legalName: "Fixture", countryCode: "NG" })];
  }
  if (command.text.includes('from "rail_states"')) {
    return [
      row(railStatesTable, {
        rail: "rail_primary",
        state: "closed",
        failureCount: 0,
        updatedAt: now,
      }),
    ];
  }
  return [];
}

const stamp: StampResult = {
  status: "accepted",
  rail: "rail_primary",
  irn: "IRN-boundary",
  csid: "CSID-boundary",
  qrPayload: "qr",
  signedArtifactRef: "signed",
  raw: { fixture: true },
};

test("submission commits its claim before rail I/O and finalizes recovered evidence in one transaction", async (t) => {
  const claimed = event("invoice.submit");
  const db = database(t, (command) => {
    if (command.text.includes("FOR UPDATE SKIP LOCKED"))
      return [row(outboxTable, claimed)];
    if (command.text.includes("SELECT id FROM outbox_events"))
      return [{ id: eventId }];
    if (command.text.startsWith('update "outbox_events"')) return [[eventId]];
    return invoiceRows(command);
  });
  t.mock.method(pool, "query", async (text: string) => {
    assert.ok(text.includes("UPDATE rail_states"));
    assert.equal(db.active(), 0);
    return { rows: [], rowCount: 1 };
  });
  const calls: string[] = [];
  const previous = setRailTransport({
    name: "boundary",
    environment: "sandbox",
    rails: ["rail_primary"],
    submit: async (rail, canonical, key) => {
      assert.equal(hasDatabaseContext(), false);
      assert.equal(db.active(), 0);
      assert.equal(canonical.invoiceNumber, invoice.invoiceNumber);
      assert.equal(key, id + ":" + invoice.invoiceNumber);
      assert.ok(
        db.commands.some(
          (command) => command.transaction === 1 && command.text === "COMMIT",
        ),
      );
      calls.push("submit");
      return { status: "rejected", rail, errorCode: "MBS_DUPLICATE", raw: {} };
    },
    lookup: async (_rail, _canonical, key) => {
      assert.equal(hasDatabaseContext(), false);
      assert.equal(db.active(), 0);
      assert.equal(key, id + ":" + invoice.invoiceNumber);
      calls.push("lookup");
      return stamp;
    },
  });
  t.after(() => setRailTransport(previous));
  resumeWorker();
  assert.equal(await drain(1), 1);
  assert.deepEqual(calls, ["submit", "lookup"]);
  const writes = db.commands.filter((command) =>
    /^insert into "(submission_attempts|stamp_records|invoice_lifecycle_events|audit_events)"/.test(
      command.text,
    ),
  );
  assert.equal(
    writes.filter((command) => command.text.includes('"submission_attempts"'))
      .length,
    2,
  );
  assert.equal(writes.length, 5);
  const final = db.commands
    .filter((command) => command.text.startsWith('update "outbox_events"'))
    .at(-1)!;
  assert.equal(updateValue(final, "status"), "done");
  assert.ok(
    writes.every((command) => command.transaction === final.transaction),
  );
  assert.ok(
    writes.some((command) =>
      command.values.includes("invoice.stamp_recovered"),
    ),
  );
  assert.equal(db.commands.at(-1)?.text, "COMMIT");
  assert.equal(db.active(), 0);
});

test("reconciliation rechecks live work after transaction-free lookup before persisting a held stamp", async (t) => {
  let lookedUp = false;
  let openChecks = 0;
  const db = database(t, (command) => {
    if (command.text.startsWith('select "status" from "outbox_events"')) {
      openChecks++;
      return lookedUp ? [["processing"]] : [];
    }
    return invoiceRows(command);
  });
  const previous = setRailTransport({
    name: "boundary",
    environment: "sandbox",
    rails: ["rail_primary"],
    submit: async () => assert.fail("reconciliation must not submit"),
    lookup: async (_rail, _canonical, key) => {
      assert.equal(hasDatabaseContext(), false);
      assert.equal(db.active(), 0);
      assert.equal(key, id + ":" + invoice.invoiceNumber);
      lookedUp = true;
      return stamp;
    },
  });
  t.mock.method(pool, "query", async (text: string) => {
    assert.ok(text.includes("UPDATE rail_states"));
    assert.equal(db.active(), 0);
    return { rows: [], rowCount: 1 };
  });
  t.after(() => setRailTransport(previous));
  assert.equal(
    await reconcile(),
    0,
    "recoveries and skipped work are not requeued count",
  );
  assert.equal(openChecks, 2);
  assert.ok(lookedUp);
  assert.ok(
    !db.commands.some((command) => command.text.startsWith("insert into")),
  );
  assert.equal(db.active(), 0);
});

test("stopping through the facade finishes the claimed handler and prevents the next claim", async (t) => {
  const claimed = event("test.shutdown-boundary");
  let claims = 0;
  const db = database(t, ({ text }) => {
    if (text.includes("FOR UPDATE SKIP LOCKED")) {
      claims++;
      return claims <= 2 ? [row(outboxTable, claimed)] : [];
    }
    if (text.includes("SELECT id FROM outbox_events")) return [{ id: eventId }];
    if (text.startsWith('update "outbox_events"')) return [[eventId]];
    return [];
  });
  registerHandler(claimed.type, async () => {
    if (claims === 1) stopWorker();
    return { kind: "done" };
  });
  resumeWorker();
  t.after(resumeWorker);
  assert.equal(await drain(50), 1);
  assert.equal(db.commands.at(-1)?.text, "COMMIT");
  assert.equal(await drain(50), 0);
  assert.equal(claims, 1);
  resumeWorker();
  assert.equal(await drain(1), 1);
  assert.equal(claims, 2);
});
