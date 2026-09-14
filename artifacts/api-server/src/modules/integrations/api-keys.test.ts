import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { MACHINE_CAPABILITIES as contractCapabilities } from "@workspace/api-zod/integrations";
import {
  getDb,
  runRequestContext,
  firmsTable,
  firmApiKeysTable,
} from "@workspace/db";
import integrationsRouter from "../../routes/integrations.ts";
import invoicesRouter from "../../routes/invoices/index.ts";
import { can, type Principal } from "../auth/rbac.ts";
import {
  API_KEY_ROLE,
  MACHINE_CAPABILITIES,
  resolveApiKeyPrincipal,
} from "./api-keys.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import { firmPrincipal } from "../../test-helpers/principals.ts";

// Firm API keys: minted/listed/revoked by the firm's ADMIN only (explicit
// role gate), secret shown once / sha256 stored, and the resolved machine
// principal carries exactly the key's vetted capabilities — never a role
// matrix row. Firm-keyed RLS via migration 0022.

const SALT = makeRunSalt();
const firmA = randomUUID();
const firmB = randomUUID();

const admin: Principal = firmPrincipal(firmA);
const staff: Principal = { ...admin, userId: randomUUID(), role: "firm_staff" };
const adminB: Principal = { ...admin, userId: randomUUID(), firmId: firmB };

type CreatedKey = {
  id: string;
  name: string;
  capabilities: string[];
  keyPrefix: string;
  secret: string;
  createdAt: string;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

before(async () => {
  await getDb()
    .insert(firmsTable)
    .values([
      { id: firmA, name: `API Key Firm A ${SALT}` },
      { id: firmB, name: `API Key Firm B ${SALT}` },
    ]);
});

after(async () => {
  await closeAllServers();
  const db = getDb();
  await db.delete(firmApiKeysTable).where(eq(firmApiKeysTable.firmId, firmA));
  await db.delete(firmApiKeysTable).where(eq(firmApiKeysTable.firmId, firmB));
  await db.delete(firmsTable).where(eq(firmsTable.id, firmA));
  await db.delete(firmsTable).where(eq(firmsTable.id, firmB));
});

async function mint(
  base: string,
  name: string,
  capabilities: string[],
): Promise<{ status: number; body: CreatedKey }> {
  const res = await fetch(`${base}/firm-api-keys`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, capabilities }),
  });
  return { status: res.status, body: (await res.json()) as CreatedKey };
}

test("mint returns the secret once and stores only its sha256", async () => {
  const base = await listen(appFor(admin, integrationsRouter));
  const { status, body } = await mint(base, `Key one ${SALT}`, [
    "invoice.read",
    "invoice.write",
  ]);
  assert.equal(status, 201);
  assert.match(body.secret, /^mk_[0-9a-f]{6}_[A-Za-z0-9_-]{32}$/);
  assert.equal(body.keyPrefix, body.secret.slice(0, 9));
  assert.deepEqual(body.capabilities, ["invoice.read", "invoice.write"]);

  const [row] = await getDb()
    .select()
    .from(firmApiKeysTable)
    .where(eq(firmApiKeysTable.id, body.id))
    .limit(1);
  assert.ok(row);
  assert.equal(row.secretHash, sha256Hex(body.secret));
  assert.ok(!JSON.stringify(row).includes(body.secret.slice(10)));
  assert.equal(row.revokedAt, null);
});

test("mint rejects capabilities outside the machine allowlist", async () => {
  const base = await listen(appFor(admin, integrationsRouter));
  for (const forbidden of [
    "clerk.use",
    "identity.write",
    "billing.write",
    "invoice.submit",
    "nonsense",
  ]) {
    const { status } = await mint(base, `Bad ${SALT}`, [
      "invoice.read",
      forbidden,
    ]);
    assert.equal(status, 400, `capability ${forbidden} must be rejected`);
  }
});

test("management surface is firm_admin only (staff and machine principals are refused)", async () => {
  const staffBase = await listen(appFor(staff, integrationsRouter));
  const staffRes = await fetch(`${staffBase}/firm-api-keys`);
  assert.equal(staffRes.status, 403);

  // A machine principal (capabilities override, synthetic role) can never
  // mint more credentials — the explicit role gate excludes it.
  const adminBase = await listen(appFor(admin, integrationsRouter));
  const { body } = await mint(adminBase, `Self-mint probe ${SALT}`, [
    "invoice.read",
  ]);
  const machine = await resolveApiKeyPrincipal(body.secret);
  assert.ok(machine);
  const machineBase = await listen(appFor(machine, integrationsRouter));
  const machineMint = await fetch(`${machineBase}/firm-api-keys`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: "escalate", capabilities: ["invoice.read"] }),
  });
  assert.equal(machineMint.status, 403);
});

test("resolveApiKeyPrincipal: accept, reject wrong secret, reject revoked", async () => {
  const base = await listen(appFor(admin, integrationsRouter));
  const { body } = await mint(base, `Resolver ${SALT}`, [
    "invoice.read",
    "statement.write",
  ]);

  const principal = await resolveApiKeyPrincipal(body.secret);
  assert.ok(principal, "valid key must resolve");
  assert.equal(principal.role, API_KEY_ROLE);
  assert.equal(principal.firmId, firmA);
  assert.equal(principal.clientPartyId, null);
  assert.equal(principal.userId, `apikey:${body.id}`);
  assert.deepEqual(principal.capabilities, ["invoice.read", "statement.write"]);

  // Wrong secret under a real prefix, and a structurally-valid unknown key.
  const tampered = `${body.secret.slice(0, 10)}${"A".repeat(32)}`;
  assert.equal(await resolveApiKeyPrincipal(tampered), null);
  assert.equal(
    await resolveApiKeyPrincipal(`mk_000000_${"B".repeat(32)}`),
    null,
  );
  assert.equal(await resolveApiKeyPrincipal("mk_garbage"), null);

  // lastUsedAt stamped best-effort on successful resolution (async raw-pool
  // write; poll briefly).
  let lastUsedAt: Date | null = null;
  for (let i = 0; i < 20 && !lastUsedAt; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const [row] = await getDb()
      .select({ lastUsedAt: firmApiKeysTable.lastUsedAt })
      .from(firmApiKeysTable)
      .where(eq(firmApiKeysTable.id, body.id))
      .limit(1);
    lastUsedAt = row?.lastUsedAt ?? null;
  }
  assert.ok(lastUsedAt, "lastUsedAt should be stamped after a successful auth");

  // Revoke stops authentication immediately.
  const revoke = await fetch(`${base}/firm-api-keys/${body.id}/revoke`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  assert.equal(revoke.status, 200);
  const revoked = (await revoke.json()) as { revokedAt: string | null };
  assert.ok(revoked.revokedAt);
  assert.equal(await resolveApiKeyPrincipal(body.secret), null);

  // Second revoke is idempotent: same timestamp, still 200. A foreign firm's
  // admin gets a 404, never a hit.
  const again = await fetch(`${base}/firm-api-keys/${body.id}/revoke`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  assert.equal(again.status, 200);
  assert.equal(
    ((await again.json()) as { revokedAt: string | null }).revokedAt,
    revoked.revokedAt,
  );
  const foreign = await listen(appFor(adminB, integrationsRouter));
  const cross = await fetch(`${foreign}/firm-api-keys/${body.id}/revoke`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  assert.equal(cross.status, 404);
});

test("capability narrowing: the key's list is the whole grant", async () => {
  const base = await listen(appFor(admin, integrationsRouter));
  const { body } = await mint(base, `Narrow ${SALT}`, ["invoice.read"]);
  const machine = await resolveApiKeyPrincipal(body.secret);
  assert.ok(machine);

  // rbac.can consults ONLY the override list for machine principals.
  assert.equal(can(machine, "invoice.read"), true);
  assert.equal(can(machine, "invoice.write"), false);
  assert.equal(can(machine, "invoice.submit"), false);
  assert.equal(can(machine, "clerk.capture"), false);

  // End-to-end on the real invoice routes: read passes, write 403s.
  const invBase = await listen(appFor(machine, invoicesRouter));
  const list = await fetch(`${invBase}/invoices`);
  assert.equal(list.status, 200);
  const write = await fetch(`${invBase}/invoices`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });
  assert.equal(write.status, 403);
});

test("machine allowlist stays data-plane only", () => {
  assert.equal(
    MACHINE_CAPABILITIES,
    contractCapabilities,
    "validation uses the browser-safe contract, not a copy",
  );
  assert.equal(Object.isFrozen(MACHINE_CAPABILITIES), true);
  assert.deepEqual(
    [...MACHINE_CAPABILITIES],
    ["invoice.read", "invoice.write", "statement.write"],
  );
});

test("list is firm-scoped and newest first", async () => {
  const baseB = await listen(appFor(adminB, integrationsRouter));
  await mint(baseB, `B first ${SALT}`, ["invoice.read"]);
  await mint(baseB, `B second ${SALT}`, ["statement.write"]);

  const res = await fetch(`${baseB}/firm-api-keys`);
  assert.equal(res.status, 200);
  const rows = (await res.json()) as { name: string; keyPrefix: string }[];
  const names = rows.map((r) => r.name);
  assert.ok(
    names.includes(`B first ${SALT}`) && names.includes(`B second ${SALT}`),
  );
  assert.ok(
    names.indexOf(`B second ${SALT}`) < names.indexOf(`B first ${SALT}`),
    "newest first",
  );
  // No firm-A key leaks into firm B's list (explicit filter + RLS).
  assert.ok(!names.some((n) => n.includes("Key one")));
  // The secret is never re-derivable from the list payload.
  assert.ok(!JSON.stringify(rows).includes("secretHash"));
});

test("RLS: a firm principal sees only its own keys at the data layer", async () => {
  // Real policy exercise (rls-isolation posture): meridian_app role + firm GUC.
  const seenByA = await runRequestContext(
    { bypass: false, firmId: firmA },
    () =>
      getDb()
        .select({ id: firmApiKeysTable.id, firmId: firmApiKeysTable.firmId })
        .from(firmApiKeysTable),
  );
  assert.ok(seenByA.length > 0, "firm A sees its own keys");
  assert.ok(seenByA.every((r) => r.firmId === firmA));

  const seenByB = await runRequestContext(
    { bypass: false, firmId: firmB },
    () =>
      getDb()
        .select({ firmId: firmApiKeysTable.firmId })
        .from(firmApiKeysTable),
  );
  assert.ok(
    seenByB.every((r) => r.firmId === firmB),
    "firm B never sees firm A rows",
  );

  // WITH CHECK: firm A cannot insert a key into firm B.
  await assert.rejects(
    runRequestContext({ bypass: false, firmId: firmA }, () =>
      getDb()
        .insert(firmApiKeysTable)
        .values({
          firmId: firmB,
          name: `cross-write ${SALT}`,
          capabilities: ["invoice.read"],
          keyPrefix: "mk_ffffff",
          secretHash: sha256Hex("nope"),
        }),
    ),
  );
});
