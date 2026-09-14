import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID, createHmac, createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { WEBHOOK_EVENTS as contractEvents } from "@workspace/api-zod/integrations";
import {
  getDb,
  runRequestContext,
  firmsTable,
  partiesTable,
  invoicesTable,
  invoiceLifecycleEventsTable,
  auditEventsTable,
  firmWebhooksTable,
  firmWebhookDeliveriesTable,
} from "@workspace/db";
import integrationsRouter from "../../routes/integrations.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  WEBHOOK_EVENTS,
  SIGNATURE_HEADER,
  createFirmWebhook,
  disableFirmWebhook,
  fanOutWebhookEvents,
  dispatchWebhookDeliveries,
  isPublicWebhookAddress,
  vetWebhookUrl,
  vetEvents,
} from "./webhooks.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import { firmPrincipal } from "../../test-helpers/principals.ts";

// Outbound firm webhooks: fan-out inserts pointer-only delivery rows for
// subscribed ACTIVE endpoints from the append-only domain ledgers
// (idempotent via the (webhook_id, event_key) unique index); the dispatcher
// POSTs with an HMAC signature and outbox retry semantics (failed → backoff
// → dead). Fixtures (firm/party/invoice/lifecycle/audit rows) are left
// behind like buyer.test.ts — the lifecycle and audit ledgers are
// append-only by design, so the invoice/firm spine they reference cannot be
// deleted; only the integration tables themselves are cleaned.

const SALT = makeRunSalt();

test("webhook validation uses the browser-safe contract and rejects unsupported events", () => {
  assert.equal(WEBHOOK_EVENTS, contractEvents);
  assert.equal(Object.isFrozen(WEBHOOK_EVENTS), true);
  assert.deepEqual(vetEvents([...contractEvents]), [...contractEvents]);
  assert.throws(() => vetEvents(["invoice.submit"]), { code: "INVALID_EVENT" });
});

test("fanout batch size rejects unbounded or malformed work", async () => {
  for (const size of [0, -1, 1.5, Infinity, NaN, 1_001]) {
    await assert.rejects(fanOutWebhookEvents(size), /batch size/);
  }
});
const firmA = randomUUID();
const firmB = randomUUID();
const partyA = randomUUID();
const invoiceA = randomUUID();
const statementId = randomUUID();

const admin: Principal = firmPrincipal(firmA);
const staff: Principal = { ...admin, userId: randomUUID(), role: "firm_staff" };
const adminB: Principal = { ...admin, userId: randomUUID(), firmId: firmB };

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Local receiver: /ok answers 200, /fail answers 500; every request's body,
// headers and path are captured.
interface Captured {
  path: string;
  body: string;
  headers: IncomingMessage["headers"];
}
const captured: Captured[] = [];
let receiver: Server;
let receiverBase = "";

before(async () => {
  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      captured.push({ path: req.url ?? "", body, headers: req.headers });
      res.statusCode = req.url === "/fail" ? 500 : 200;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => {
    receiver.listen(0, "127.0.0.1", resolve);
  });
  receiverBase = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `Webhook Firm A ${SALT}` },
    { id: firmB, name: `Webhook Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    {
      id: partyA,
      type: "client_business",
      legalName: `Webhook Party ${SALT}`,
    },
  ]);
  await db.insert(invoicesTable).values([
    {
      id: invoiceA,
      firmId: firmA,
      supplierPartyId: partyA,
      buyerPartyId: partyA,
      invoiceNumber: `WH-${SALT}`,
      issueDate: "2026-07-01",
    },
  ]);
});

after(async () => {
  await closeAllServers();
  await new Promise<void>((resolve, reject) =>
    receiver.close((err) => (err ? reject(err) : resolve())),
  );
  const db = getDb();
  for (const firm of [firmA, firmB]) {
    await db
      .delete(firmWebhookDeliveriesTable)
      .where(eq(firmWebhookDeliveriesTable.firmId, firm));
    await db
      .delete(firmWebhooksTable)
      .where(eq(firmWebhooksTable.firmId, firm));
  }
});

test("vetting: unknown events and bad URLs are rejected; production requires public https", () => {
  assert.throws(() => vetEvents(["invoice.stamped", "invoice.deleted"]));
  assert.deepEqual(vetEvents(["invoice.stamped", "invoice.stamped"]), [
    "invoice.stamped",
  ]);
  assert.throws(() => vetWebhookUrl("not a url"));
  assert.throws(() => vetWebhookUrl("ftp://example.com/hook"));
  assert.throws(() => vetWebhookUrl("https://user:pass@example.com/hook"));
  assert.throws(() => vetWebhookUrl("https://example.com/hook#secret"));
  assert.equal(
    vetWebhookUrl("https://hooks.example.com/x"),
    "https://hooks.example.com/x",
  );
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => vetWebhookUrl("http://hooks.example.com/x"), /https/);
    assert.throws(() => vetWebhookUrl("https://127.0.0.1/x"), /public/);
    assert.throws(() => vetWebhookUrl("https://localhost/x"), /public/);
    assert.throws(() => vetWebhookUrl("https://10.0.0.8/x"), /public/);
    assert.throws(() => vetWebhookUrl("https://169.254.169.254/x"), /public/);
    // IPv6 literals: WHATWG canonicalizes ::ffff:127.0.0.1 to its hex form
    // ([::ffff:7f00:1]) before vetting sees it — the v4-mapped loopback,
    // unspecified, unique-local and link-local literals must all refuse;
    // a genuinely public literal passes.
    assert.throws(
      () => vetWebhookUrl("https://[::ffff:127.0.0.1]/x"),
      /public/,
    );
    assert.throws(() => vetWebhookUrl("https://[::]/x"), /public/);
    assert.throws(() => vetWebhookUrl("https://[fd00::1]/x"), /public/);
    assert.throws(() => vetWebhookUrl("https://[fe80::1]/x"), /public/);
    assert.equal(
      vetWebhookUrl("https://[2606:4700::1111]/x"),
      "https://[2606:4700::1111]/x",
    );
  } finally {
    process.env.NODE_ENV = env;
  }
});

test("address vetting rejects private, reserved, mapped and tunnel ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "198.18.0.1",
    "203.0.113.10",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "fe80::1",
    "64:ff9b::a9fe:a9fe",
    "2001::1",
    "2001:20::1",
    "2001:db8::1",
    "2002:c0a8:101::1",
    "3fff::1",
  ]) {
    assert.equal(isPublicWebhookAddress(address), false, address);
  }
  assert.equal(isPublicWebhookAddress("8.8.8.8"), true);
  assert.equal(isPublicWebhookAddress("2606:4700:4700::1111"), true);
});

test("fan-out inserts pointer-only deliveries for subscribed active webhooks only, idempotently", async () => {
  // Register the webhooks FIRST (fan-out only picks up events newer than the
  // registration), then commit the domain events.
  const all = await createFirmWebhook(firmA, "https://a.example.test/all", [
    ...WEBHOOK_EVENTS,
  ]);
  const stampedOnly = await createFirmWebhook(
    firmA,
    "https://a.example.test/stamped",
    ["invoice.stamped"],
  );
  const inactive = await createFirmWebhook(
    firmA,
    "https://a.example.test/off",
    [...WEBHOOK_EVENTS],
  );
  await getDb()
    .update(firmWebhooksTable)
    .set({ active: false })
    .where(eq(firmWebhooksTable.id, inactive.row.id));
  const foreign = await createFirmWebhook(firmB, "https://b.example.test/all", [
    ...WEBHOOK_EVENTS,
  ]);

  await getDb()
    .insert(invoiceLifecycleEventsTable)
    .values([
      {
        invoiceId: invoiceA,
        firmId: firmA,
        fromStatus: "submitted",
        toStatus: "stamped",
        actorRole: "system",
      },
      {
        invoiceId: invoiceA,
        firmId: firmA,
        fromStatus: "stamped",
        toStatus: "settled",
        actorRole: "system",
      },
      // A non-catalog transition must never fan out.
      {
        invoiceId: invoiceA,
        firmId: firmA,
        fromStatus: "draft",
        toStatus: "validated",
        actorRole: "system",
      },
    ]);
  await getDb()
    .insert(auditEventsTable)
    .values({
      firmId: firmA,
      action: "statement.reconciled",
      entityType: "bank_statement",
      entityId: statementId,
      after: { proposals: 1 },
      hash: `wh-test-${SALT}`,
      prevHash: `wh-test-${SALT}`,
    });

  const inserted = await fanOutWebhookEvents();
  assert.equal(
    inserted,
    4,
    "3 events for the all-hook + 1 for the stamped-only hook",
  );

  const deliveries = await getDb()
    .select()
    .from(firmWebhookDeliveriesTable)
    .where(
      inArray(firmWebhookDeliveriesTable.webhookId, [
        all.row.id,
        stampedOnly.row.id,
        inactive.row.id,
        foreign.row.id,
      ]),
    );
  const byHook = (id: string) => deliveries.filter((d) => d.webhookId === id);
  assert.deepEqual(
    byHook(all.row.id)
      .map((d) => d.eventType)
      .sort(),
    ["invoice.settled", "invoice.stamped", "statement.reconciled"],
  );
  assert.deepEqual(
    byHook(stampedOnly.row.id).map((d) => d.eventType),
    ["invoice.stamped"],
  );
  assert.equal(
    byHook(inactive.row.id).length,
    0,
    "inactive hooks receive nothing",
  );
  assert.equal(
    byHook(foreign.row.id).length,
    0,
    "another firm's events never cross",
  );

  // SEC-12: payloads are pointer-only — entity type + id, nothing else.
  for (const d of deliveries) {
    assert.deepEqual(Object.keys(d.payload).sort(), ["entityId", "entityType"]);
    assert.equal(d.status, "pending");
    assert.equal(d.firmId, firmA);
  }
  const stampedDelivery = byHook(all.row.id).find(
    (d) => d.eventType === "invoice.stamped",
  );
  assert.deepEqual(stampedDelivery?.payload, {
    entityType: "invoice",
    entityId: invoiceA,
  });
  const reconciled = byHook(all.row.id).find(
    (d) => d.eventType === "statement.reconciled",
  );
  assert.deepEqual(reconciled?.payload, {
    entityType: "bank_statement",
    entityId: statementId,
  });

  // Idempotent: a second pass (concurrent sweep instance / window re-scan)
  // inserts nothing.
  assert.equal(await fanOutWebhookEvents(), 0);

  // A webhook registered AFTER the events never receives history.
  const late = await createFirmWebhook(firmA, "https://a.example.test/late", [
    ...WEBHOOK_EVENTS,
  ]);
  assert.equal(await fanOutWebhookEvents(), 0);
  const lateRows = await getDb()
    .select()
    .from(firmWebhookDeliveriesTable)
    .where(eq(firmWebhookDeliveriesTable.webhookId, late.row.id));
  assert.equal(lateRows.length, 0);

  // Park these deliveries so the dispatcher tests below never try to POST to
  // the unroutable example hosts.
  await getDb()
    .update(firmWebhookDeliveriesTable)
    .set({ status: "dead" })
    .where(eq(firmWebhookDeliveriesTable.firmId, firmA));
});

test("dispatch signs the body with the stored hash and marks delivered", async () => {
  const hook = await createFirmWebhook(firmA, `${receiverBase}/ok`, [
    "invoice.stamped",
  ]);
  assert.equal(
    hook.row.secretHash,
    sha256Hex(hook.secret),
    "stored hash is sha256(secret)",
  );
  const [delivery] = await getDb()
    .insert(firmWebhookDeliveriesTable)
    .values({
      webhookId: hook.row.id,
      firmId: firmA,
      eventType: "invoice.stamped",
      eventKey: `test:ok:${SALT}`,
      payload: { entityType: "invoice", entityId: invoiceA },
    })
    .returning();

  captured.length = 0;
  const dispatched = await dispatchWebhookDeliveries();
  assert.equal(dispatched, 1);
  assert.equal(captured.length, 1);

  const [row] = await getDb()
    .select()
    .from(firmWebhookDeliveriesTable)
    .where(eq(firmWebhookDeliveriesTable.id, delivery.id))
    .limit(1);
  assert.equal(row.status, "delivered");
  assert.equal(row.attempts, 1);
  assert.ok(row.deliveredAt);
  assert.equal(row.lastError, null);

  // Body: pointer-only, exactly the documented shape.
  const body = JSON.parse(captured[0].body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    "createdAt",
    "entityId",
    "entityType",
    "eventType",
    "id",
  ]);
  assert.equal(body.id, delivery.id);
  assert.equal(body.eventType, "invoice.stamped");
  assert.equal(body.entityType, "invoice");
  assert.equal(body.entityId, invoiceA);

  // Signature: HMAC-SHA256 of the exact body bytes, keyed by sha256(secret)
  // — the receiver derives the key by hashing its stored secret once.
  const expected = createHmac("sha256", sha256Hex(hook.secret))
    .update(captured[0].body)
    .digest("hex");
  assert.equal(captured[0].headers[SIGNATURE_HEADER], expected);
  assert.equal(captured[0].headers["x-meridian-event"], "invoice.stamped");
});

test("dispatch retries with backoff and dead-letters after max attempts; disabled hooks are never claimed", async () => {
  const hook = await createFirmWebhook(firmA, `${receiverBase}/fail`, [
    "invoice.settled",
  ]);
  const [delivery] = await getDb()
    .insert(firmWebhookDeliveriesTable)
    .values({
      webhookId: hook.row.id,
      firmId: firmA,
      eventType: "invoice.settled",
      eventKey: `test:fail:${SALT}`,
      payload: { entityType: "invoice", entityId: invoiceA },
    })
    .returning();

  // A pending delivery on a DISABLED hook is never claimed.
  const disabled = await createFirmWebhook(firmA, `${receiverBase}/ok`, [
    "invoice.settled",
  ]);
  await getDb()
    .update(firmWebhooksTable)
    .set({ active: false })
    .where(eq(firmWebhooksTable.id, disabled.row.id));
  await getDb()
    .insert(firmWebhookDeliveriesTable)
    .values({
      webhookId: disabled.row.id,
      firmId: firmA,
      eventType: "invoice.settled",
      eventKey: `test:disabled:${SALT}`,
      payload: { entityType: "invoice", entityId: invoiceA },
    });

  captured.length = 0;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await dispatchWebhookDeliveries();
    const [row] = await getDb()
      .select()
      .from(firmWebhookDeliveriesTable)
      .where(eq(firmWebhookDeliveriesTable.id, delivery.id))
      .limit(1);
    assert.equal(row.attempts, attempt);
    assert.equal(row.lastError, "HTTP 500");
    if (attempt < 5) {
      assert.equal(row.status, "failed", `attempt ${attempt} retries`);
      // The claim pre-charged exponential backoff; fast-forward for the test.
      assert.ok(row.nextAttemptAt.getTime() > Date.now(), "backoff scheduled");
      await getDb()
        .update(firmWebhookDeliveriesTable)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(firmWebhookDeliveriesTable.id, delivery.id));
    } else {
      assert.equal(row.status, "dead", "gives up after max attempts");
    }
  }
  assert.equal(captured.length, 5, "exactly one POST per attempt");
  assert.ok(
    captured.every((c) => c.path === "/fail"),
    "disabled hook never POSTed",
  );

  // Dead rows are out of the queue for good.
  await dispatchWebhookDeliveries();
  assert.equal(captured.length, 5);

  const [parked] = await getDb()
    .select()
    .from(firmWebhookDeliveriesTable)
    .where(eq(firmWebhookDeliveriesTable.webhookId, disabled.row.id))
    .limit(1);
  assert.equal(parked.status, "pending");
  assert.equal(parked.attempts, 0);
});

test("routes: create shows the secret once, disable is CAS, deliveries list newest first, firm_admin only", async () => {
  const base = await listen(appFor(admin, integrationsRouter));

  const created = await fetch(`${base}/firm-webhooks`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      url: "https://hooks.example.test/route",
      events: ["invoice.stamped", "statement.reconciled"],
    }),
  });
  assert.equal(created.status, 201);
  const hook = (await created.json()) as {
    id: string;
    url: string;
    events: string[];
    active: boolean;
    secretPrefix: string;
    secret: string;
  };
  assert.match(hook.secret, /^whsec_[A-Za-z0-9_-]{32}$/);
  assert.equal(hook.secretPrefix, hook.secret.slice(0, 12));
  assert.equal(hook.active, true);
  assert.deepEqual(hook.events, ["invoice.stamped", "statement.reconciled"]);
  const [row] = await getDb()
    .select()
    .from(firmWebhooksTable)
    .where(eq(firmWebhooksTable.id, hook.id))
    .limit(1);
  assert.equal(row.secretHash, sha256Hex(hook.secret));

  // Unknown event fails closed.
  const bad = await fetch(`${base}/firm-webhooks`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      url: "https://hooks.example.test/x",
      events: ["invoice.paid"],
    }),
  });
  assert.equal(bad.status, 400);

  // List: metadata only, never the secret or its hash.
  const list = await fetch(`${base}/firm-webhooks`);
  assert.equal(list.status, 200);
  const listBody = (await list.json()) as Record<string, unknown>[];
  assert.ok(listBody.some((w) => w.id === hook.id));
  assert.ok(!JSON.stringify(listBody).includes(hook.secret));
  assert.ok(!JSON.stringify(listBody).includes(row.secretHash));

  // Disable: CAS, idempotent, and 404 for a foreign firm.
  const disabled = await fetch(`${base}/firm-webhooks/${hook.id}/disable`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  assert.equal(disabled.status, 200);
  assert.equal(((await disabled.json()) as { active: boolean }).active, false);
  const again = await fetch(`${base}/firm-webhooks/${hook.id}/disable`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  assert.equal(again.status, 200);
  const foreignBase = await listen(appFor(adminB, integrationsRouter));
  const cross = await fetch(`${foreignBase}/firm-webhooks/${hook.id}/disable`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  assert.equal(cross.status, 404);
  const crossList = await fetch(
    `${foreignBase}/firm-webhooks/${hook.id}/deliveries`,
  );
  assert.equal(crossList.status, 404);

  // Deliveries list, newest first.
  const early = await getDb()
    .insert(firmWebhookDeliveriesTable)
    .values({
      webhookId: hook.id,
      firmId: firmA,
      eventType: "invoice.stamped",
      eventKey: `test:list1:${SALT}`,
      payload: { entityType: "invoice", entityId: invoiceA },
      status: "delivered",
      createdAt: new Date(Date.now() - 60_000),
    })
    .returning();
  await getDb()
    .insert(firmWebhookDeliveriesTable)
    .values({
      webhookId: hook.id,
      firmId: firmA,
      eventType: "statement.reconciled",
      eventKey: `test:list2:${SALT}`,
      payload: { entityType: "bank_statement", entityId: statementId },
    });
  const deliveries = await fetch(`${base}/firm-webhooks/${hook.id}/deliveries`);
  assert.equal(deliveries.status, 200);
  const items = (await deliveries.json()) as {
    id: string;
    eventType: string;
  }[];
  assert.equal(items.length, 2);
  assert.equal(items[0].eventType, "statement.reconciled");
  assert.equal(items[1].id, early[0].id);

  // Explicit role gate: staff (and any non-admin) is refused.
  const staffBase = await listen(appFor(staff, integrationsRouter));
  assert.equal((await fetch(`${staffBase}/firm-webhooks`)).status, 403);
});

test("retry: dead → pending requeue the dispatcher picks up; live rows, foreign firms and disabled hooks refuse", async () => {
  const base = await listen(appFor(admin, integrationsRouter));
  const hook = await createFirmWebhook(firmA, `${receiverBase}/ok`, [
    "invoice.stamped",
  ]);
  const [dead] = await getDb()
    .insert(firmWebhookDeliveriesTable)
    .values({
      webhookId: hook.row.id,
      firmId: firmA,
      eventType: "invoice.stamped",
      eventKey: `test:retry:${SALT}`,
      payload: { entityType: "invoice", entityId: invoiceA },
      status: "dead",
      attempts: 5,
      lastError: "HTTP 500",
      // Far-future backoff left over from the failed cycle — the retry must
      // reset it, or the requeued row would sit undue for hours.
      nextAttemptAt: new Date(Date.now() + 3_600_000),
    })
    .returning();

  // Cross-firm: another firm's admin sees 404, and the row is untouched.
  const foreignBase = await listen(appFor(adminB, integrationsRouter));
  const cross = await fetch(
    `${foreignBase}/firm-webhooks/${hook.row.id}/deliveries/${dead.id}/retry`,
    { method: "POST", headers: JSON_HEADERS },
  );
  assert.equal(cross.status, 404);

  // A delivery id that does not live under the addressed webhook is 404 too.
  const otherHook = await createFirmWebhook(firmA, `${receiverBase}/ok`, [
    "invoice.stamped",
  ]);
  const wrongHook = await fetch(
    `${base}/firm-webhooks/${otherHook.row.id}/deliveries/${dead.id}/retry`,
    { method: "POST", headers: JSON_HEADERS },
  );
  assert.equal(wrongHook.status, 404);

  // The retry itself: dead → pending, counters reset, due immediately.
  const retried = await fetch(
    `${base}/firm-webhooks/${hook.row.id}/deliveries/${dead.id}/retry`,
    { method: "POST", headers: JSON_HEADERS },
  );
  assert.equal(retried.status, 200);
  const body = (await retried.json()) as {
    id: string;
    status: string;
    attempts: number;
    lastError: string | null;
  };
  assert.equal(body.id, dead.id);
  assert.equal(body.status, "pending");
  assert.equal(body.attempts, 0);
  assert.equal(body.lastError, null);

  // The ordinary sweep dispatcher picks the requeued row up and delivers it.
  captured.length = 0;
  await dispatchWebhookDeliveries();
  assert.equal(captured.length, 1, "the requeued delivery was POSTed");
  assert.equal(captured[0].path, "/ok");
  const [after] = await getDb()
    .select()
    .from(firmWebhookDeliveriesTable)
    .where(eq(firmWebhookDeliveriesTable.id, dead.id))
    .limit(1);
  assert.equal(after.status, "delivered");
  assert.equal(after.attempts, 1, "the fresh cycle counts from zero");

  // Not dead any more: a second retry is refused with 409.
  const again = await fetch(
    `${base}/firm-webhooks/${hook.row.id}/deliveries/${dead.id}/retry`,
    { method: "POST", headers: JSON_HEADERS },
  );
  assert.equal(again.status, 409);
  assert.match(
    ((await again.json()) as { error: string }).error,
    /only dead deliveries can be retried/,
  );

  // A dead row on a DISABLED endpoint cannot be requeued — the dispatcher
  // would never drain it.
  const disabledHook = await createFirmWebhook(firmA, `${receiverBase}/ok`, [
    "invoice.stamped",
  ]);
  const [deadOnDisabled] = await getDb()
    .insert(firmWebhookDeliveriesTable)
    .values({
      webhookId: disabledHook.row.id,
      firmId: firmA,
      eventType: "invoice.stamped",
      eventKey: `test:retry-disabled:${SALT}`,
      payload: { entityType: "invoice", entityId: invoiceA },
      status: "dead",
      attempts: 5,
      lastError: "HTTP 500",
    })
    .returning();
  await disableFirmWebhook(firmA, disabledHook.row.id);
  const ontoDisabled = await fetch(
    `${base}/firm-webhooks/${disabledHook.row.id}/deliveries/${deadOnDisabled.id}/retry`,
    { method: "POST", headers: JSON_HEADERS },
  );
  assert.equal(ontoDisabled.status, 409);
  assert.match(
    ((await ontoDisabled.json()) as { error: string }).error,
    /disabled/,
  );
  const [still] = await getDb()
    .select()
    .from(firmWebhookDeliveriesTable)
    .where(eq(firmWebhookDeliveriesTable.id, deadOnDisabled.id))
    .limit(1);
  assert.equal(still.status, "dead", "refusals never touch the row");
});

test("RLS: webhook and delivery rows are firm-isolated at the data layer", async () => {
  const seenByB = await runRequestContext(
    { bypass: false, firmId: firmB },
    async () => ({
      hooks: await getDb()
        .select({ firmId: firmWebhooksTable.firmId })
        .from(firmWebhooksTable),
      deliveries: await getDb()
        .select({ firmId: firmWebhookDeliveriesTable.firmId })
        .from(firmWebhookDeliveriesTable),
    }),
  );
  assert.ok(seenByB.hooks.every((r) => r.firmId === firmB));
  assert.ok(seenByB.deliveries.every((r) => r.firmId === firmB));

  const seenByA = await runRequestContext(
    { bypass: false, firmId: firmA },
    () =>
      getDb()
        .select({ firmId: firmWebhooksTable.firmId })
        .from(firmWebhooksTable),
  );
  assert.ok(seenByA.length > 0, "firm A sees its own webhooks");
  assert.ok(seenByA.every((r) => r.firmId === firmA));

  // WITH CHECK: firm B cannot write a delivery into firm A.
  await assert.rejects(
    runRequestContext({ bypass: false, firmId: firmB }, async () => {
      const [hook] = await getDb()
        .select({ id: firmWebhooksTable.id })
        .from(firmWebhooksTable)
        .where(eq(firmWebhooksTable.firmId, firmB))
        .limit(1);
      await getDb()
        .insert(firmWebhookDeliveriesTable)
        .values({
          webhookId: hook?.id ?? randomUUID(),
          firmId: firmA,
          eventType: "invoice.stamped",
          eventKey: `test:cross:${SALT}`,
          payload: { entityType: "invoice", entityId: invoiceA },
        });
    }),
  );
});

test("fanout recovers an outage older than 24 hours in bounded unique-key batches, including late commits", async () => {
  const backlogFirm = randomUUID();
  const backlogInvoice = randomUUID();
  await getDb()
    .insert(firmsTable)
    .values({ id: backlogFirm, name: `Webhook backlog ${SALT}` });
  await getDb()
    .insert(invoicesTable)
    .values({
      id: backlogInvoice,
      firmId: backlogFirm,
      supplierPartyId: partyA,
      buyerPartyId: partyA,
      invoiceNumber: `WH-backlog-${SALT}`,
      issueDate: "2026-07-01",
    });
  const hook = await createFirmWebhook(backlogFirm, `${receiverBase}/ok`, [
    ...WEBHOOK_EVENTS,
  ]);
  const day = 86_400_000;
  const cutoff = new Date(Date.now() - 4 * day);
  const eventTime = new Date(cutoff.getTime() + day);
  await getDb()
    .update(firmWebhooksTable)
    .set({ createdAt: cutoff })
    .where(eq(firmWebhooksTable.id, hook.row.id));
  const lifecycle = await getDb()
    .insert(invoiceLifecycleEventsTable)
    .values(
      Array.from({ length: 3 }, () => ({
        invoiceId: backlogInvoice,
        firmId: backlogFirm,
        fromStatus: "submitted" as const,
        toStatus: "stamped" as const,
        actorRole: "system",
        createdAt: eventTime,
      })),
    )
    .returning();
  const audits = await getDb()
    .insert(auditEventsTable)
    .values(
      Array.from({ length: 3 }, () => ({
        firmId: backlogFirm,
        action: "statement.reconciled",
        entityType: "bank_statement",
        entityId: statementId,
        hash: `old-${SALT}`,
        prevHash: `old-${SALT}`,
        createdAt: eventTime,
      })),
    )
    .returning();
  const [beforeRegistration] = await getDb()
    .insert(invoiceLifecycleEventsTable)
    .values({
      invoiceId: backlogInvoice,
      firmId: backlogFirm,
      fromStatus: "submitted",
      toStatus: "stamped",
      actorRole: "system",
      createdAt: new Date(cutoff.getTime() - 1),
    })
    .returning();
  const read = () =>
    getDb()
      .select()
      .from(firmWebhookDeliveriesTable)
      .where(eq(firmWebhookDeliveriesTable.webhookId, hook.row.id));
  try {
    assert.equal(
      await fanOutWebhookEvents(2),
      4,
      "at most two per source, including old events",
    );
    const initial = await read();
    assert.equal(initial.length, 4);
    const retained = initial[0];
    await getDb()
      .update(firmWebhookDeliveriesTable)
      .set({ status: "dead", attempts: 5, lastError: "retained" })
      .where(eq(firmWebhookDeliveriesTable.id, retained.id));
    const passes = await Promise.all([
      fanOutWebhookEvents(2),
      fanOutWebhookEvents(2),
    ]);
    assert.equal(
      passes.reduce((a, b) => a + b, 0),
      2,
    );
    const rows = await read();
    assert.equal(rows.length, 6);
    assert.deepEqual(
      new Set(rows.map((r) => r.eventKey)),
      new Set([
        ...lifecycle.map((e) => `lce:${e.id}`),
        ...audits.map((a) => `aud:${a.seq}`),
      ]),
    );
    assert.ok(!rows.some((r) => r.eventKey === `lce:${beforeRegistration.id}`));
    assert.equal(rows.find((r) => r.id === retained.id)?.attempts, 5);
    assert.equal(rows.find((r) => r.id === retained.id)?.lastError, "retained");
    assert.equal(rows.find((r) => r.id === retained.id)?.status, "dead");
    assert.equal(await fanOutWebhookEvents(2), 0);
    // A transaction that commits after earlier scans with an older timestamp
    // must still be found; no timestamp or sequence watermark skips it.
    const [late] = await getDb()
      .insert(invoiceLifecycleEventsTable)
      .values({
        invoiceId: backlogInvoice,
        firmId: backlogFirm,
        fromStatus: "stamped",
        toStatus: "settled",
        actorRole: "system",
        createdAt: new Date(eventTime.getTime() - 1),
      })
      .returning();
    assert.equal(await fanOutWebhookEvents(2), 1);
    assert.ok((await read()).some((row) => row.eventKey === `lce:${late.id}`));
  } finally {
    await getDb()
      .delete(firmWebhookDeliveriesTable)
      .where(eq(firmWebhookDeliveriesTable.webhookId, hook.row.id));
    await getDb()
      .delete(firmWebhooksTable)
      .where(eq(firmWebhooksTable.id, hook.row.id));
  }
});
