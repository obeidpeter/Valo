import { createHmac, randomBytes, createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { and, desc, eq, sql } from "drizzle-orm";
import { WEBHOOK_EVENTS } from "@workspace/api-zod/integrations";
import {
  getDb,
  runInBypassContext,
  firmWebhooksTable,
  firmWebhookDeliveriesTable,
  type FirmWebhookRow,
  type FirmWebhookDeliveryRow,
} from "@workspace/db";
import { registerSweep } from "../pipeline/sweeps";
import { DomainError } from "../errors";
import { logger } from "../../lib/logger";
import { webhookFanoutOldestAge } from "../../lib/metrics";

// Outbound firm webhooks (contract 0.41.0): a firm_admin registers an
// endpoint + event subscription; the platform fans domain events out into
// per-webhook delivery rows and a sweep-driven dispatcher POSTs them with
// outbox retry semantics. Payloads are POINTER-ONLY by design (SEC-12): an
// entity type + id the receiver resolves back through the authenticated API
// (e.g. with a firm API key) — never amounts, party names or document
// content, so a mis-registered or compromised receiver URL leaks nothing.

// The closed event catalog — derived from what the domain actually commits,
// not from aspiration:
// - invoice.stamped / invoice.settled ride the append-only
//   invoice_lifecycle_events ledger (recordTransition is the SINGLE writer
//   for every status transition — pipeline stamping, reconciliation
//   acceptance, bulk accept — so the fan-out can never miss an emit path or
//   disagree with the invoice's actual status history).
// - statement.reconciled rides the audit ledger's `statement.reconciled`
//   event (appended exactly once per completed reconcile pass in
//   modules/statements/service.ts, committed atomically with the proposals).
// Both sources are append-only and commit WITH the domain write, which makes
// this a post-commit fan-out by construction: a rolled-back stamp can never
// produce a delivery.
export { WEBHOOK_EVENTS };

const WEBHOOK_EVENT_SET: ReadonlySet<string> = new Set(WEBHOOK_EVENTS);

// Delivery keys are the durable progress ledger. Scan all missing eligible
// keys, oldest first; never use a timestamp watermark that can skip late commits.
const FAN_OUT_BATCH_SIZE = 250;

// Dispatch: outbox semantics (pipeline.ts precedent) — exponential backoff,
// dead after MAX_ATTEMPTS. The backoff is PRE-CHARGED at claim time (the
// claim bumps attempts and advances next_attempt_at before any network I/O),
// so a crashed instance mid-POST costs one counted attempt instead of a
// hot-loop, and a concurrent instance cannot double-send while the 5s HTTP
// call is in flight (the smallest backoff comfortably exceeds the timeout).
const MAX_DELIVERY_ATTEMPTS = 5;
const BASE_BACKOFF_SECONDS = 30;
const DELIVERY_TIMEOUT_MS = 5_000;
const DNS_TIMEOUT_MS = 3_000;
const CLAIM_BATCH = 10;
const LAST_ERROR_MAX = 300;

export const SIGNATURE_HEADER = "x-valo-signature";
const LEGACY_SIGNATURE_HEADER = "x-meridian-signature";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Delivery signing. Only the secret's sha256 is stored (shown-once posture),
// so the stored hash IS the HMAC key: signature =
// HMAC-SHA256(body, sha256hex(secret)), hex-encoded, in X-Valo-Signature.
// The same signature is also sent under the legacy name for existing receivers.
// The receiver derives the same key by hashing its stored secret once. This
// keeps the raw (possibly reused) secret unrecoverable platform-side while
// every delivery still authenticates; a DB leak could forge signatures — as
// with any stored signing key — but can never reveal the secret itself.
export function signDeliveryBody(secretHash: string, body: string): string {
  return createHmac("sha256", secretHash).update(body).digest("hex");
}

export function vetEvents(requested: string[]): string[] {
  const seen = new Set<string>();
  const vetted: string[] = [];
  for (const event of requested) {
    if (!WEBHOOK_EVENT_SET.has(event)) {
      throw new DomainError(
        "INVALID_EVENT",
        `Unknown webhook event ${event}; allowed: ${WEBHOOK_EVENTS.join(", ")}`,
        400,
      );
    }
    if (!seen.has(event)) {
      seen.add(event);
      vetted.push(event);
    }
  }
  return vetted;
}

// The delivery URL is TENANT-SUPPLIED, which makes the dispatcher an SSRF
// vector: in production require https and reject loopback/link-local/private
// literal hosts — the IPv4 ranges below, and for bracketed IPv6 literals the
// unspecified/loopback addresses, unique-local fc00::/7, link-local
// fe80::/10 and any v4-mapped ::ffff:… form whose embedded IPv4 falls in the
// same private ranges. Registration resolves every address, and delivery
// resolves again and pins the vetted address into the TLS connection, closing
// DNS-rebinding between validation and connect. Redirects are never followed.
// Outside production plain http/loopback is allowed for local receivers.
const PRIVATE_HOST_RE =
  /^(localhost|127\.(\d{1,3}\.){2}\d{1,3}|0\.0\.0\.0|10\.(\d{1,3}\.){2}\d{1,3}|192\.168\.(\d{1,3}\.)\d{1,3}|172\.(1[6-9]|2\d|3[01])\.(\d{1,3}\.)\d{1,3}|169\.254\.(\d{1,3}\.)\d{1,3}|\[?::1\]?)$/i;

// The embedded IPv4 of a v4-mapped literal, dotted-quad; null for anything
// else. WHATWG serializes ::ffff:a.b.c.d as pure hex groups (::ffff:hhhh:hhhh)
// before vetting sees it, but both spellings are handled.
function embeddedMappedIpv4(host: string): string | null {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

// Production vetting for bracketed IPv6 literal hostnames (PRIVATE_HOST_RE
// only knows the IPv4 ranges and exactly ::1): reject the unspecified and
// loopback addresses, fc00::/7, fe80::/10, and v4-mapped addresses whose
// embedded IPv4 the IPv4 vetting would itself reject.
function isPrivateIpv6Literal(hostname: string): boolean {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const host = hostname.slice(1, -1).toLowerCase();
  if (isIP(host) !== 6) return false;
  if (host === "::" || host === "::1") return true;
  // The first hextet decides both prefix ranges; a leading "::" compresses
  // zeros, so its empty first group parses to NaN and matches neither.
  const firstHextet = parseInt(host.split(":", 1)[0], 16);
  if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  const embedded = embeddedMappedIpv4(host);
  return embedded !== null && PRIVATE_HOST_RE.test(embedded);
}

export function vetWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DomainError(
      "INVALID_URL",
      "Webhook URL must be a valid URL",
      400,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DomainError("INVALID_URL", "Webhook URL must use http(s)", 400);
  }
  if (url.username || url.password || url.hash || raw.length > 2_048) {
    throw new DomainError(
      "INVALID_URL",
      "Webhook URL must not contain credentials or a fragment",
      400,
    );
  }
  if (process.env.NODE_ENV === "production") {
    if (url.protocol !== "https:") {
      throw new DomainError("INVALID_URL", "Webhook URL must use https", 400);
    }
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (
      PRIVATE_HOST_RE.test(url.hostname) ||
      isPrivateIpv6Literal(url.hostname) ||
      (isIP(literal) !== 0 && !isPublicWebhookAddress(literal))
    ) {
      throw new DomainError(
        "INVALID_URL",
        "Webhook URL must resolve to a public host",
        400,
      );
    }
  }
  return url.toString();
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 192 && b === 0 && octets[2] === 2) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0 && octets[2] === 113) return false;
  return true;
}

export function isPublicWebhookAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return false;
  const mapped = embeddedMappedIpv4(normalized);
  if (mapped) return isPublicIpv4(mapped);
  const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  // Publicly routable IPv6 is allocated from 2000::/3. This conservative
  // boundary also rejects NAT64, 6to4, unique-local, link-local, multicast,
  // unspecified and IPv4-compatible forms that could tunnel private targets.
  if ((first & 0xe000) !== 0x2000) return false;
  const second = Number.parseInt(normalized.split(":")[1] || "0", 16);
  // Reject globally scoped-looking transition, protocol-assignment and
  // documentation prefixes. In particular, 6to4 can encode a private IPv4
  // destination inside 2002::/16 and must never pass an SSRF boundary.
  if (first === 0x2002) return false; // 6to4
  if (first === 0x2001 && second <= 0x01ff) return false; // IETF protocols/Teredo
  if (first === 0x2001 && (second & 0xfff0) === 0x0020) return false; // ORCHIDv2
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  if (first === 0x3fff && second <= 0x0fff) return false; // documentation
  return true;
}

interface ResolvedWebhookTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

async function resolvePublicWebhookTarget(
  raw: string,
): Promise<ResolvedWebhookTarget> {
  const url = new URL(vetWebhookUrl(raw));
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(literal);
  let addresses: Array<{ address: string; family: number }>;
  if (literalFamily) {
    addresses = [{ address: literal, family: literalFamily }];
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = await Promise.race([
        lookup(literal, { all: true, verbatim: true }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Webhook DNS lookup timed out")),
            DNS_TIMEOUT_MS,
          );
          timer.unref();
        }),
      ]);
    } catch {
      throw new DomainError(
        "INVALID_URL",
        "Webhook host could not be resolved",
        400,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (
    addresses.length === 0 ||
    addresses.some((entry) => !isPublicWebhookAddress(entry.address))
  ) {
    throw new DomainError(
      "INVALID_URL",
      "Webhook URL must resolve only to public addresses",
      400,
    );
  }
  const chosen = addresses[0];
  return {
    url,
    address: chosen.address,
    family: chosen.family as 4 | 6,
  };
}

export interface CreatedWebhook {
  row: FirmWebhookRow;
  secret: string;
}

// Register an endpoint. The signing secret (`whsec_<32 base64url chars>`) is
// shown ONCE; only its sha256 is stored (and doubles as the HMAC key — see
// signDeliveryBody). secret_prefix is the displayable identifier.
export async function createFirmWebhook(
  firmId: string,
  url: string,
  events: string[],
): Promise<CreatedWebhook> {
  const vettedUrl = vetWebhookUrl(url);
  if (process.env.NODE_ENV === "production") {
    await resolvePublicWebhookTarget(vettedUrl);
  }
  const vettedEvents = vetEvents(events);
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const [row] = await getDb()
    .insert(firmWebhooksTable)
    .values({
      firmId,
      url: vettedUrl,
      events: vettedEvents,
      secretHash: sha256Hex(secret),
      secretPrefix: secret.slice(0, 12),
    })
    .returning();
  return { row, secret };
}

export async function listFirmWebhooks(
  firmId: string,
): Promise<FirmWebhookRow[]> {
  return getDb()
    .select()
    .from(firmWebhooksTable)
    .where(eq(firmWebhooksTable.firmId, firmId))
    .orderBy(desc(firmWebhooksTable.createdAt));
}

// Disable: compare-and-set on `active` — deliveries stop (both fan-out and
// the dispatcher key on active), history is retained. Disabling an
// already-disabled webhook returns the row unchanged (idempotent); an id
// outside the firm is a 404.
export async function disableFirmWebhook(
  firmId: string,
  webhookId: string,
): Promise<FirmWebhookRow> {
  const [disabled] = await getDb()
    .update(firmWebhooksTable)
    .set({ active: false })
    .where(
      and(
        eq(firmWebhooksTable.id, webhookId),
        eq(firmWebhooksTable.firmId, firmId),
        eq(firmWebhooksTable.active, true),
      ),
    )
    .returning();
  if (disabled) return disabled;
  const [existing] = await getDb()
    .select()
    .from(firmWebhooksTable)
    .where(
      and(
        eq(firmWebhooksTable.id, webhookId),
        eq(firmWebhooksTable.firmId, firmId),
      ),
    )
    .limit(1);
  if (!existing) throw new DomainError("NOT_FOUND", "Webhook not found", 404);
  return existing;
}

// Delivery history for one webhook, newest first. The webhook itself must be
// the firm's (404 otherwise); capped — this is an operational tail, not an
// export surface.
const DELIVERY_LIST_CAP = 200;

export async function listWebhookDeliveries(
  firmId: string,
  webhookId: string,
): Promise<FirmWebhookDeliveryRow[]> {
  const [webhook] = await getDb()
    .select({ id: firmWebhooksTable.id })
    .from(firmWebhooksTable)
    .where(
      and(
        eq(firmWebhooksTable.id, webhookId),
        eq(firmWebhooksTable.firmId, firmId),
      ),
    )
    .limit(1);
  if (!webhook) throw new DomainError("NOT_FOUND", "Webhook not found", 404);
  return getDb()
    .select()
    .from(firmWebhookDeliveriesTable)
    .where(eq(firmWebhookDeliveriesTable.webhookId, webhookId))
    .orderBy(desc(firmWebhookDeliveriesTable.createdAt))
    .limit(DELIVERY_LIST_CAP);
}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? (result as T[]);
}

// Operator-triggered second life for a dead delivery (contract 0.42.0): a
// firm_admin re-queues one DEAD row for a fresh attempt cycle. Compare-and-set
// on status='dead' — a delivery still live in the retry queue (pending/failed)
// or already delivered is refused with 409, so a double-click or a concurrent
// dispatcher pass can never reset an in-flight row's backoff. The webhook must
// be the caller's own (404 otherwise, indistinguishable from absent) and still
// enabled: the dispatcher only claims ACTIVE webhooks' rows, so re-queueing
// onto a disabled endpoint would park a pending row nothing ever drains.
export async function retryDelivery(
  firmId: string,
  webhookId: string,
  deliveryId: string,
): Promise<FirmWebhookDeliveryRow> {
  const [webhook] = await getDb()
    .select({ id: firmWebhooksTable.id, active: firmWebhooksTable.active })
    .from(firmWebhooksTable)
    .where(
      and(
        eq(firmWebhooksTable.id, webhookId),
        eq(firmWebhooksTable.firmId, firmId),
      ),
    )
    .limit(1);
  if (!webhook) throw new DomainError("NOT_FOUND", "Webhook not found", 404);
  if (!webhook.active) {
    throw new DomainError(
      "WEBHOOK_DISABLED",
      "Webhook endpoint is disabled; deliveries cannot be re-queued",
      409,
    );
  }
  const [requeued] = await getDb()
    .update(firmWebhookDeliveriesTable)
    .set({
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
      lastError: null,
    })
    .where(
      and(
        eq(firmWebhookDeliveriesTable.id, deliveryId),
        eq(firmWebhookDeliveriesTable.webhookId, webhookId),
        eq(firmWebhookDeliveriesTable.status, "dead"),
      ),
    )
    .returning();
  if (requeued) return requeued;
  // The CAS missed: distinguish "no such delivery under this webhook" (404)
  // from "delivery exists but is not dead" (409).
  const [existing] = await getDb()
    .select({ status: firmWebhookDeliveriesTable.status })
    .from(firmWebhookDeliveriesTable)
    .where(
      and(
        eq(firmWebhookDeliveriesTable.id, deliveryId),
        eq(firmWebhookDeliveriesTable.webhookId, webhookId),
      ),
    )
    .limit(1);
  if (!existing) throw new DomainError("NOT_FOUND", "Delivery not found", 404);
  throw new DomainError(
    "DELIVERY_NOT_DEAD",
    `Delivery is ${existing.status}; only dead deliveries can be retried`,
    409,
  );
}

// Fan domain events out into delivery rows. Set-based INSERT..SELECT per
// source ledger; the unique (webhook_id, event_key) index + ON CONFLICT DO
// NOTHING makes concurrent sweep instances and backlog re-scans idempotent.
// The missing delivery keys form the durable cursor, with bounded ordered
// batches and no OFFSET or retention cutoff. Each insert requires the event to be newer
// than the webhook (`created_at >= w.created_at`) so a fresh registration
// starts from "now", never from history. Early-exits before touching the
// ledgers when no firm has an active webhook — the common case must cost one
// cheap probe.
export async function fanOutWebhookEvents(
  batchSize = FAN_OUT_BATCH_SIZE,
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error(
      "Webhook fanout batch size must be an integer between 1 and 1000",
    );
  }
  return runInBypassContext(async () => {
    const active = rowsOf<{ n: number }>(
      await getDb().execute(
        sql`SELECT count(*)::int AS n FROM firm_webhooks WHERE active`,
      ),
    );
    if (!active[0] || Number(active[0].n) === 0) return 0;

    let inserted = 0;

    // invoice.stamped / invoice.settled from the lifecycle ledger. Payload is
    // pointer-only (SEC-12): entity type + id, nothing else.
    const invoiceRes = rowsOf<{ inserted: number; oldest_age: number }>(
      await getDb().execute(sql`
        WITH candidates AS MATERIALIZED (
        SELECT
          w.id AS webhook_id,
          w.firm_id,
          CASE e.to_status WHEN 'stamped' THEN 'invoice.stamped' ELSE 'invoice.settled' END AS event_type,
          'lce:' || e.id AS event_key,
          jsonb_build_object('entityType', 'invoice', 'entityId', e.invoice_id) AS payload,
          e.created_at
        FROM invoice_lifecycle_events e
        JOIN firm_webhooks w
          ON w.firm_id = e.firm_id
         AND w.active
         AND w.events ? (CASE e.to_status WHEN 'stamped' THEN 'invoice.stamped' ELSE 'invoice.settled' END)
        WHERE e.to_status IN ('stamped', 'settled')
          AND e.created_at >= w.created_at
          AND NOT EXISTS (SELECT 1 FROM firm_webhook_deliveries d
            WHERE d.webhook_id = w.id AND d.event_key = 'lce:' || e.id)
        ORDER BY e.created_at, e.id, w.id
        LIMIT ${batchSize}
        ), inserted AS (
        INSERT INTO firm_webhook_deliveries
          (webhook_id, firm_id, event_type, event_key, payload, status)
        SELECT webhook_id, firm_id, event_type, event_key, payload, 'pending' FROM candidates
        ON CONFLICT (webhook_id, event_key) DO NOTHING
        RETURNING id
        ) SELECT (SELECT count(*)::int FROM inserted) AS inserted,
          coalesce(extract(epoch FROM now() - min(created_at)), 0)::float AS oldest_age FROM candidates
      `),
    );
    inserted += Number(invoiceRes[0]?.inserted ?? 0);
    webhookFanoutOldestAge.set(
      { source: "lifecycle" },
      Math.max(0, Number(invoiceRes[0]?.oldest_age ?? 0)),
    );

    // statement.reconciled from the audit ledger (audit_events.firm_id is
    // text; compare on the webhook side cast so a malformed historical value
    // can never abort the sweep).
    const statementRes = rowsOf<{ inserted: number; oldest_age: number }>(
      await getDb().execute(sql`
        WITH candidates AS MATERIALIZED (
        SELECT
          w.id AS webhook_id,
          w.firm_id,
          'aud:' || a.seq AS event_key,
          jsonb_build_object('entityType', 'bank_statement', 'entityId', a.entity_id) AS payload,
          a.created_at
        FROM audit_events a
        JOIN firm_webhooks w
          ON w.firm_id::text = a.firm_id
         AND w.active
         AND w.events ? 'statement.reconciled'
        WHERE a.action = 'statement.reconciled'
          AND a.created_at >= w.created_at
          AND NOT EXISTS (SELECT 1 FROM firm_webhook_deliveries d
            WHERE d.webhook_id = w.id AND d.event_key = 'aud:' || a.seq)
        ORDER BY a.created_at, a.seq, w.id
        LIMIT ${batchSize}
        ), inserted AS (
        INSERT INTO firm_webhook_deliveries
          (webhook_id, firm_id, event_type, event_key, payload, status)
        SELECT webhook_id, firm_id, 'statement.reconciled', event_key, payload, 'pending' FROM candidates
        ON CONFLICT (webhook_id, event_key) DO NOTHING
        RETURNING id
        ) SELECT (SELECT count(*)::int FROM inserted) AS inserted,
          coalesce(extract(epoch FROM now() - min(created_at)), 0)::float AS oldest_age FROM candidates
      `),
    );
    inserted += Number(statementRes[0]?.inserted ?? 0);
    webhookFanoutOldestAge.set(
      { source: "audit" },
      Math.max(0, Number(statementRes[0]?.oldest_age ?? 0)),
    );

    return inserted;
  });
}

interface ClaimedDelivery {
  id: string;
  webhook_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: Date;
  url: string;
  secret_hash: string;
}

// Claim a batch of due deliveries: bump attempts and advance next_attempt_at
// (pre-charged backoff) in one committed statement BEFORE any network I/O —
// FOR UPDATE SKIP LOCKED keeps concurrent instances off the same rows, and
// only active webhooks' deliveries are ever claimed (disable stops the queue
// mid-flight, rows simply stay pending history).
async function claimDeliveries(): Promise<ClaimedDelivery[]> {
  return runInBypassContext(async () =>
    rowsOf<ClaimedDelivery>(
      await getDb().execute(sql`
        UPDATE firm_webhook_deliveries d
        SET attempts = d.attempts + 1,
            next_attempt_at = now()
              + (interval '${sql.raw(String(BASE_BACKOFF_SECONDS))} seconds' * power(2, d.attempts))
        FROM firm_webhooks w
        WHERE d.id IN (
          SELECT d2.id
          FROM firm_webhook_deliveries d2
          JOIN firm_webhooks w2 ON w2.id = d2.webhook_id AND w2.active
          WHERE d2.status IN ('pending', 'failed')
            AND d2.next_attempt_at <= now()
          ORDER BY d2.created_at ASC
          LIMIT ${CLAIM_BATCH}
          FOR UPDATE OF d2 SKIP LOCKED
        )
        AND w.id = d.webhook_id
        RETURNING d.id, d.webhook_id, d.event_type, d.payload, d.attempts,
                  d.created_at, w.url, w.secret_hash
      `),
    ),
  );
}

async function recordOutcome(
  delivery: ClaimedDelivery,
  ok: boolean,
  error: string | null,
): Promise<void> {
  await runInBypassContext(async () => {
    if (ok) {
      await getDb()
        .update(firmWebhookDeliveriesTable)
        .set({ status: "delivered", deliveredAt: new Date(), lastError: null })
        .where(eq(firmWebhookDeliveriesTable.id, delivery.id));
      return;
    }
    const dead = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
    await getDb()
      .update(firmWebhookDeliveriesTable)
      .set({
        status: dead ? "dead" : "failed",
        lastError: (error ?? "delivery failed").slice(0, LAST_ERROR_MAX),
      })
      .where(eq(firmWebhookDeliveriesTable.id, delivery.id));
  });
}

// POST one claimed delivery. The body repeats the pointer-only payload plus
// delivery identity; the response BODY is never read or stored (only the
// status), so a webhook target cannot use lastError as an exfiltration or
// probe channel. Redirects are not followed (SSRF: a public URL must not
// bounce the POST somewhere private).
async function postDelivery(delivery: ClaimedDelivery): Promise<{
  ok: boolean;
  error: string | null;
}> {
  const body = JSON.stringify({
    id: delivery.id,
    eventType: delivery.event_type,
    entityType: delivery.payload.entityType ?? null,
    entityId: delivery.payload.entityId ?? null,
    createdAt: new Date(delivery.created_at).toISOString(),
  });
  try {
    if (process.env.NODE_ENV === "production") {
      const target = await resolvePublicWebhookTarget(delivery.url);
      const status = await postPinnedHttps(target, body, {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signDeliveryBody(delivery.secret_hash, body),
        [LEGACY_SIGNATURE_HEADER]: signDeliveryBody(delivery.secret_hash, body),
        "x-valo-event": delivery.event_type,
        "x-meridian-event": delivery.event_type,
      });
      return status >= 200 && status < 300
        ? { ok: true, error: null }
        : { ok: false, error: `HTTP ${status}` };
    }
    const res = await fetch(delivery.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signDeliveryBody(delivery.secret_hash, body),
        [LEGACY_SIGNATURE_HEADER]: signDeliveryBody(delivery.secret_hash, body),
        "x-valo-event": delivery.event_type,
        "x-meridian-event": delivery.event_type,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true, error: null };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function postPinnedHttps(
  target: ResolvedWebhookTarget,
  body: string,
  headers: Record<string, string>,
): Promise<number> {
  const hostname = target.url.hostname.replace(/^\[|\]$/g, "");
  const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, target.address, target.family);
  };
  return new Promise<number>((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname,
        port: target.url.port || 443,
        method: "POST",
        path: `${target.url.pathname}${target.url.search}`,
        headers: {
          ...headers,
          "content-length": Buffer.byteLength(body).toString(),
        },
        servername: hostname,
        family: target.family,
        lookup: pinnedLookup,
        timeout: DELIVERY_TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 502);
      },
    );
    request.once("timeout", () =>
      request.destroy(new Error("Webhook delivery timed out")),
    );
    request.once("error", reject);
    request.end(body);
  });
}

// Drain due deliveries. Claim (committed) → POST (no transaction held across
// the network call) → record outcome (own transaction) — the pipeline
// worker's posture for slow external I/O. Bounded per pass; the sweep runs
// every minute, and the claim's ORDER BY keeps it fair.
export async function dispatchWebhookDeliveries(): Promise<number> {
  const claimed = await claimDeliveries();
  for (const delivery of claimed) {
    const { ok, error } = await postDelivery(delivery);
    await recordOutcome(delivery, ok, error);
    if (!ok) {
      logger.warn(
        { deliveryId: delivery.id, attempts: delivery.attempts, error },
        "webhook delivery failed",
      );
    }
  }
  return claimed.length;
}

// Registered with the pipeline worker at import time (routes/integrations.ts
// imports this module), like the other feature sweeps. Both halves are
// idempotent/claim-guarded, so multi-instance passes are safe no-ops.
registerSweep("integrations.webhooks", async () => {
  await fanOutWebhookEvents();
  await dispatchWebhookDeliveries();
});
