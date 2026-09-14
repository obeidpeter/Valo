import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { MACHINE_CAPABILITIES as machineCapabilities } from "@workspace/api-zod/integrations";
import {
  getDb,
  getSystemDb,
  pool,
  firmApiKeysTable,
  type FirmApiKeyRow,
  type Role,
} from "@workspace/db";
import type { Capability, Principal } from "../auth/rbac";
import { DomainError } from "../errors";

// Firm API keys (contract 0.41.0): a firm_admin mints a machine credential
// scoped to their own firm; the key authenticates server-to-server callers
// (ERP exports, statement pushers) via `Authorization: Bearer mk_...`
// (middleware/principal.ts). The full key is shown ONCE — only its sha256 is
// stored (the invitation/password-reset posture) — and the resolved machine
// principal carries EXACTLY the key's capability list, never a role's matrix
// row (rbac.ts `capabilities` override).

// The vetted machine-safe capability allowlist. Deliberately narrow:
// - invoice.read / invoice.write / statement.write are pure data-plane verbs
//   an integration legitimately automates (pull invoice data, push drafts,
//   push bank statements), each already firm-scoped by RLS + route guards.
// - NOT clerk.* — every Clerk surface spends model tokens against the firm's
//   budget and is designed around a human in the loop; a runaway machine
//   caller must not be able to drain the budget or flood the review queue.
// - NOT identity./invitation./billing. — account and financial control-plane:
//   a leaked data key must never be able to add users, mint credentials
//   (including more API keys — the routes additionally require the human
//   firm_admin role) or change what the firm pays.
// - NOT invoice.submit — filing to the government rails stays a human
//   decision; a machine can stage drafts, a person submits them.
export const MACHINE_CAPABILITIES =
  machineCapabilities satisfies readonly Capability[];

const MACHINE_CAPABILITY_SET: ReadonlySet<string> = new Set(
  MACHINE_CAPABILITIES,
);

// Key format: `mk_<6 hex chars>_<32 base64url chars>` (42 chars total).
// key_prefix ("mk_" + 6 hex) is the displayable identifier and the auth-time
// lookup key; the whole string is the secret that gets hashed. Hex for the
// prefix keeps "_" free to be the separator.
const KEY_TAG = "mk_";
const PREFIX_LEN = KEY_TAG.length + 6;
const FULL_KEY_RE = /^mk_[0-9a-f]{6}_[A-Za-z0-9_-]{32}$/;

// Synthetic role for machine principals. Not a member of the DB role enum on
// purpose: it must never match a human role switch (`role === "firm_admin"`
// style gates exclude machines automatically), it is not in app.ts
// BYPASS_ROLES (so tenantContext pins the request to the key's firm RLS), and
// rbac.can() never consults the matrix for it — the principal's explicit
// `capabilities` override is the whole grant.
export const API_KEY_ROLE = "api_key";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Constant-time hex-digest comparison (staff.ts digestEquals posture).
function digestEquals(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// A fixed dummy digest compared against when the prefix matches no live row,
// so "unknown prefix" and "wrong secret" cost the same compare (no timing
// oracle on key existence).
const DUMMY_HASH = sha256Hex("meridian-api-key-dummy");

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(KEY_TAG);
}

export interface MintedApiKey {
  row: FirmApiKeyRow;
  secret: string;
}

// Validate a requested capability list against the machine allowlist,
// preserving order and deduplicating. Rejects — never silently drops — an
// unknown or non-machine capability, so a caller learns exactly what a key
// can carry.
function vetCapabilities(requested: string[]): Capability[] {
  const seen = new Set<string>();
  const vetted: Capability[] = [];
  for (const cap of requested) {
    if (!MACHINE_CAPABILITY_SET.has(cap)) {
      throw new DomainError(
        "INVALID_CAPABILITY",
        `Capability ${cap} cannot be granted to an API key; allowed: ${MACHINE_CAPABILITIES.join(", ")}`,
        400,
      );
    }
    if (!seen.has(cap)) {
      seen.add(cap);
      vetted.push(cap as Capability);
    }
  }
  return vetted;
}

// Mint a key for the firm. The returned secret is the ONLY time the full key
// string exists outside the caller's hands; the row stores its sha256.
export async function mintFirmApiKey(
  firmId: string,
  name: string,
  capabilities: string[],
): Promise<MintedApiKey> {
  const vetted = vetCapabilities(capabilities);
  const prefix = randomBytes(3).toString("hex");
  const secret = `${KEY_TAG}${prefix}_${randomBytes(24).toString("base64url")}`;
  const [row] = await getDb()
    .insert(firmApiKeysTable)
    .values({
      firmId,
      name,
      capabilities: vetted,
      keyPrefix: `${KEY_TAG}${prefix}`,
      secretHash: sha256Hex(secret),
    })
    .returning();
  return { row, secret };
}

export async function listFirmApiKeys(
  firmId: string,
): Promise<FirmApiKeyRow[]> {
  return getDb()
    .select()
    .from(firmApiKeysTable)
    .where(eq(firmApiKeysTable.firmId, firmId))
    .orderBy(desc(firmApiKeysTable.createdAt));
}

// Revoke: compare-and-set on `revoked_at IS NULL`, so a concurrent revoke can
// never overwrite the first revocation's timestamp. Revoking an
// already-revoked key returns the row unchanged (idempotent); an id outside
// the firm is a 404 (RLS would hide it anyway — the explicit filter keeps the
// route honest even on the bypass-context test pool).
export async function revokeFirmApiKey(
  firmId: string,
  keyId: string,
): Promise<FirmApiKeyRow> {
  const [revoked] = await getDb()
    .update(firmApiKeysTable)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(firmApiKeysTable.id, keyId),
        eq(firmApiKeysTable.firmId, firmId),
        isNull(firmApiKeysTable.revokedAt),
      ),
    )
    .returning();
  if (revoked) return revoked;
  const [existing] = await getDb()
    .select()
    .from(firmApiKeysTable)
    .where(
      and(eq(firmApiKeysTable.id, keyId), eq(firmApiKeysTable.firmId, firmId)),
    )
    .limit(1);
  if (!existing) {
    throw new DomainError("NOT_FOUND", "API key not found", 404);
  }
  return existing;
}

// Best-effort lastUsedAt stamp: an in-process cache skips the write for a
// minute per key, and the SQL predicate enforces the same once-a-minute cap
// cluster-wide. Rides the RAW pool on purpose — resolution runs before
// tenantContext, and even where a transaction existed, a 4xx rollback must
// not erase the usage observation (throttle.ts posture). Fire-and-forget: a
// failed stamp must never fail authentication. The cache is bounded by the
// number of distinct live keys seen by this process.
const lastTouched = new Map<string, number>();
const TOUCH_INTERVAL_MS = 60_000;

function touchLastUsed(keyId: string): void {
  const now = Date.now();
  const prev = lastTouched.get(keyId) ?? 0;
  if (now - prev < TOUCH_INTERVAL_MS) return;
  lastTouched.set(keyId, now);
  void pool
    .query(
      `UPDATE firm_api_keys SET last_used_at = now()
        WHERE id = $1
          AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [keyId],
    )
    .catch(() => {});
}

// Resolve a presented `mk_...` bearer token to a machine principal, or null
// (=> 401; the middleware never falls through to the session paths for an
// mk_ token). Runs pre-context on the raw pool (context.ts documents that
// fallback for principal resolution). Unknown prefix, wrong secret and
// revoked key are all the same null — with a constant-time hash compare on
// every path so none of them is a timing oracle.
export async function resolveApiKeyPrincipal(
  token: string,
): Promise<Principal | null> {
  if (!FULL_KEY_RE.test(token)) return null;
  const keyPrefix = token.slice(0, PREFIX_LEN);
  // Prefix is a locator, not an identity: compare the presented hash against
  // every candidate (collisions are vanishingly rare; the bound keeps a
  // pathological table from turning auth into a scan).
  const candidates = await getSystemDb("authentication")
    .select()
    .from(firmApiKeysTable)
    .where(eq(firmApiKeysTable.keyPrefix, keyPrefix))
    .limit(5);
  const presentedHash = sha256Hex(token);
  let matched: FirmApiKeyRow | null = null;
  for (const row of candidates) {
    if (digestEquals(presentedHash, row.secretHash)) matched = row;
  }
  if (candidates.length === 0) digestEquals(presentedHash, DUMMY_HASH);
  if (!matched || matched.revokedAt) return null;

  touchLastUsed(matched.id);
  return {
    // Key-derived identity: the rate limiter buckets on userId, so every key
    // gets its own per-minute budget, and audit actor ids name the key.
    userId: `apikey:${matched.id}`,
    // Synthetic role — see API_KEY_ROLE. The cast is deliberate: the value is
    // intentionally NOT a member of the DB role enum so no role switch or
    // matrix row can ever match it; everything the principal may do comes
    // from the capabilities override below (rbac.can fails closed without it).
    role: API_KEY_ROLE as Role,
    firmId: matched.firmId,
    clientPartyId: null,
    buyerPartyId: null,
    // Re-vetted against the CURRENT allowlist at resolution time: a stored
    // grant that has since left the allowlist stops working immediately.
    capabilities: (matched.capabilities ?? []).filter((c): c is Capability =>
      MACHINE_CAPABILITY_SET.has(c),
    ),
  };
}
