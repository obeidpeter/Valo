import assert from "node:assert/strict";
import path from "node:path";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { digest, loadManifest } from "./build-manifest.mjs";
import {
  compareSecurityCatalog,
  readSecurityCatalog,
} from "./security-catalog.mjs";
import { loadMaintenancePlan } from "./recovery-plan.mjs";
import { loadActivationPermit } from "./activation-permit.mjs";
import {
  activationBindings,
  deploymentOrigin,
  maintenanceIdentity,
  maintenanceResponse,
  releaseProfile,
  runtimeState,
} from "./maintenance-server.mjs";

const HELD_EVIDENCE_MAX_AGE_MS = 3600_000;
const HELD_EVIDENCE_MAX_BYTES = 16 * 1024;
const SECURITY_CATALOG_CAPTURE_MAX_AGE_MS = 3600_000;
const SECURITY_CATALOG_CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
const HELD_CHECKS = [
  "maintenanceHealth",
  "businessRejected",
  "readinessRejected",
  "immutableAssets",
  "securityCatalog",
  "ciProvenance",
];

function requests(base, fetcher) {
  const origin = deploymentOrigin(base);
  return async (route, status = 200, method = "GET") => {
    assert.ok(
      typeof route === "string" &&
        route.startsWith("/") &&
        !route.startsWith("//") &&
        !route.includes("\\"),
      "invalid asset URL",
    );
    const url = new URL(route, origin);
    assert.equal(url.origin, origin, "asset URL escaped deployment origin");
    const response = await fetcher(url, {
      method,
      redirect: "error",
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(
      response.status,
      status,
      route + ": HTTP " + response.status + "; expected " + status,
    );
    return response;
  };
}

async function verifyAssets(manifest, request) {
  for (const asset of manifest.assets.filter((entry) => entry.url)) {
    const bytes = Buffer.from(await (await request(asset.url)).arrayBuffer());
    assert.equal(
      digest(bytes),
      asset.sha256,
      "deployed asset mismatch: " + asset.url,
    );
  }
}

export async function verifyDeployment(base, manifest, fetcher = fetch) {
  const request = requests(base, fetcher);
  const health = await (await request("/api/healthz")).json();
  assert.equal(health.status, "ok", "API liveness failed");
  assert.ok(
    health.maintenance !== true &&
      health.mode !== "hold" &&
      health.apiImported !== false,
    "maintenance health is not real API readiness",
  );
  assert.equal(
    health.buildRevision,
    manifest.source.revision,
    "deployed API source mismatch (full SHA required)",
  );
  assert.equal(
    health.contractVersion,
    manifest.contractVersion,
    "deployed API contract mismatch",
  );
  assert.equal(
    (await (await request("/api/readyz")).json()).status,
    "ready",
    "API is not ready",
  );
  await verifyAssets(manifest, request);
}

export async function verifyHeldDeployment(
  base,
  manifest,
  identity,
  fetcher = fetch,
) {
  assert.equal(
    deploymentOrigin(base),
    identity.target.origin,
    "held target origin mismatch",
  );
  const request = requests(base, fetcher);
  const expected = maintenanceResponse(identity);
  for (const [route, status, method] of [
    ["/api/healthz", 200, "GET"],
    ["/api/readyz", 503, "GET"],
    ["/api/invoices", 503, "GET"],
    ["/api/__maintenance_probe__", 503, "POST"],
  ]) {
    const response = await request(route, status, method);
    assert.match(
      response.headers.get("cache-control") ?? "",
      /(?:^|[,\s])no-store(?:$|[,\s])/i,
      "maintenance responses must not be cached",
    );
    assert.deepEqual(
      await response.json(),
      expected,
      route + ": held identity/state mismatch",
    );
  }
  // Static siblings remain public; the HOLD API listener itself serves no assets.
  await verifyAssets(manifest, request);
}

function fields(value, keys, label) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    label + " must be an object",
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    label + " has missing or unknown fields",
  );
}

function readBoundedJsonFile(file, expectedSha256, label, maxBytes) {
  assert.match(
    expectedSha256 ?? "",
    /^[a-f0-9]{64}$/,
    `independently trusted ${label} SHA256 required`,
  );
  assert.ok(
    typeof file === "string" && file.length > 0 && file.length <= 4096,
    `${label} file required`,
  );
  const entry = lstatSync(file);
  assert.ok(
    entry.isFile() && !entry.isSymbolicLink(),
    `${label} must be a regular non-symlink file`,
  );
  const fd = openSync(
    file,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  let bytes;
  try {
    const stat = fstatSync(fd);
    assert.ok(
      stat.isFile() && stat.size > 0 && stat.size <= maxBytes,
      `${label} size invalid`,
    );
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    assert.ok(size > 0 && size <= maxBytes, `${label} exceeds bounded size`);
    bytes = buffer.subarray(0, size);
  } finally {
    closeSync(fd);
  }
  assert.equal(digest(bytes), expectedSha256, `${label} checksum mismatch`);
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  } catch {
    throw new Error(`${label} must contain valid UTF-8 JSON`);
  }
}

export function loadSecurityCatalogCapture(
  file,
  env,
  manifest,
  { now = Date.now() } = {},
) {
  const capture = readBoundedJsonFile(
    file,
    env.RELEASE_SECURITY_CATALOG_SHA256,
    "security catalog capture",
    SECURITY_CATALOG_CAPTURE_MAX_BYTES,
  );
  fields(
    capture,
    [
      "format",
      "kind",
      "capturedAt",
      "manifestSha256",
      "targetOrigin",
      "catalog",
    ],
    "security catalog capture",
  );
  assert.equal(
    capture.format,
    1,
    "unsupported security catalog capture format",
  );
  assert.equal(
    capture.kind,
    "security-catalog-capture",
    "not a security catalog capture",
  );
  assert.equal(
    capture.manifestSha256,
    env.RELEASE_MANIFEST_SHA256,
    "security catalog capture manifest mismatch",
  );
  assert.equal(
    capture.targetOrigin,
    deploymentOrigin(env.RELEASE_BASE_URL),
    "security catalog capture target mismatch",
  );
  const capturedAt = Date.parse(capture.capturedAt);
  assert.ok(
    Number.isSafeInteger(now) &&
      typeof capture.capturedAt === "string" &&
      Number.isFinite(capturedAt) &&
      new Date(capturedAt).toISOString() === capture.capturedAt &&
      capturedAt <= now &&
      now - capturedAt <= SECURITY_CATALOG_CAPTURE_MAX_AGE_MS,
    "security catalog capture is stale or future-dated",
  );
  fields(
    capture.catalog,
    Object.keys(manifest.database),
    "captured security catalog",
  );
  fields(
    capture.catalog.role,
    Object.keys(manifest.database.role),
    "captured security catalog role",
  );
  compareSecurityCatalog(manifest.database, capture.catalog);
  return {
    catalog: capture.catalog,
    sha256: env.RELEASE_SECURITY_CATALOG_SHA256,
  };
}

function validateCatalogSource(catalogSource) {
  assert.ok(
    catalogSource &&
      typeof catalogSource === "object" &&
      !Array.isArray(catalogSource),
    "held catalogSource must be an object",
  );
  if (catalogSource.kind === "direct-database") {
    fields(catalogSource, ["kind"], "held catalogSource");
    return catalogSource;
  }
  fields(catalogSource, ["kind", "captureSha256"], "held catalogSource");
  assert.equal(
    catalogSource.kind,
    "credentialless-capture",
    "unsupported held catalog source",
  );
  assert.match(
    catalogSource.captureSha256 ?? "",
    /^[a-f0-9]{64}$/,
    "credentialless held evidence requires approved capture SHA256",
  );
  return catalogSource;
}

export function catalogSourceReview(catalogSource) {
  validateCatalogSource(catalogSource);
  if (catalogSource.kind === "direct-database")
    return "catalog source: direct database";
  return `catalog source: credentialless capture; approved capture SHA-256: ${catalogSource.captureSha256}`;
}

export function validateHeldEvidence(
  evidence,
  identity,
  { now = Date.now(), notBefore = 0 } = {},
) {
  assert.equal(
    evidence?.format,
    2,
    "unsupported held evidence format; format 1 lacks catalog provenance",
  );
  fields(
    evidence,
    [
      "format",
      "kind",
      "revision",
      "manifestSha256",
      "target",
      "recoveryPlanSha256",
      "backupSha256",
      "verifiedAt",
      "checks",
      "apiReadinessVerified",
      "catalogSource",
    ],
    "held evidence",
  );
  assert.equal(
    evidence.kind,
    "held-verification",
    "not held verification evidence",
  );
  assert.equal(
    evidence.revision,
    identity.buildRevision,
    "held candidate mismatch",
  );
  for (const field of ["manifestSha256", "recoveryPlanSha256", "backupSha256"])
    assert.equal(
      evidence[field],
      identity[field],
      "held " + field + " mismatch",
    );
  assert.deepEqual(evidence.target, identity.target, "held target mismatch");
  validateCatalogSource(evidence.catalogSource);
  fields(evidence.checks, HELD_CHECKS, "held checks");
  for (const check of HELD_CHECKS)
    assert.equal(
      evidence.checks[check],
      true,
      "held " + check + " was not verified",
    );
  assert.equal(
    evidence.apiReadinessVerified,
    false,
    "HOLD cannot prove real API readiness",
  );
  const verifiedAt = Date.parse(evidence.verifiedAt);
  assert.ok(
    Number.isSafeInteger(now) &&
      Number.isFinite(notBefore) &&
      typeof evidence.verifiedAt === "string" &&
      Number.isFinite(verifiedAt) &&
      new Date(verifiedAt).toISOString() === evidence.verifiedAt,
    "invalid held verification timestamp",
  );
  assert.ok(
    verifiedAt >= notBefore &&
      verifiedAt <= now &&
      now - verifiedAt <= HELD_EVIDENCE_MAX_AGE_MS,
    "held evidence is stale, future-dated, or predates plan approval",
  );
  return evidence;
}

export function loadHeldEvidence(env, manifest, options) {
  const file = env.RELEASE_HELD_EVIDENCE;
  const evidence = readBoundedJsonFile(
    file,
    env.RELEASE_HELD_EVIDENCE_SHA256,
    "held evidence",
    HELD_EVIDENCE_MAX_BYTES,
  );
  return validateHeldEvidence(
    evidence,
    maintenanceIdentity(manifest, env),
    options,
  );
}

export async function postdeploy(
  args = process.argv.slice(2),
  env = process.env,
  dependencies = {},
) {
  const held = args[0] === "--held";
  const catalogFile =
    held && args.length === 5 && args[3] === "--catalog-file"
      ? args[4]
      : !held && args.length === 2 && args[0] === "--catalog-file"
        ? args[1]
        : undefined;
  assert.ok(
    args.length === 0 ||
      (!held && args.length === 2 && args[0] === "--catalog-file" && args[1]) ||
      (held &&
        (args.length === 3 || args.length === 5) &&
        args[1] === "--evidence-out" &&
        args[2] &&
        (args.length === 3 || (args[3] === "--catalog-file" && args[4]))),
    "use postdeploy [--catalog-file <capture>] or postdeploy --held --evidence-out <new-file> [--catalog-file <capture>]",
  );
  const manifest = loadManifest(
    env.RELEASE_MANIFEST,
    env.RELEASE_MANIFEST_SHA256,
  );
  const profile = releaseProfile(env);
  assert.ok(
    (env.DATABASE_URL || catalogFile) && env.RELEASE_BASE_URL,
    "DATABASE_URL or --catalog-file, and RELEASE_BASE_URL required",
  );
  let identity;
  let plan;
  if (held) {
    assert.equal(
      profile,
      "governed",
      "held evidence is governed-only; pilot HOLD does not authorize activation",
    );
    assert.equal(runtimeState(env), "HOLD", "held verification requires HOLD");
    identity = maintenanceIdentity(manifest, env);
    plan = loadMaintenancePlan(env, {
      revision: identity.buildRevision,
      backupSha256: identity.backupSha256,
    });
    assert.match(
      String(manifest.ci.runId),
      /^[1-9][0-9]*$/,
      "invalid CI run identity",
    );
    assert.match(
      manifest.ci.repository,
      /^[\w.-]+\/[\w.-]+$/,
      "invalid CI repository",
    );
  } else {
    assert.equal(
      runtimeState(env),
      "RUN",
      "real API verification requires RUN; HOLD is not API readiness",
    );
    if (profile === "governed") {
      loadActivationPermit(env, activationBindings(manifest, env), {
        phase: "runtime",
      });
    } else {
      assert.ok(
        manifest.mobile?.domain,
        "CI mobile production target is required",
      );
      assert.equal(
        deploymentOrigin(env.RELEASE_BASE_URL),
        deploymentOrigin(`https://${manifest.mobile.domain}`),
        "release origin differs from the CI mobile production target",
      );
    }
  }
  let catalogSource;
  if (catalogFile) {
    const capture = loadSecurityCatalogCapture(
      catalogFile,
      env,
      manifest,
      dependencies,
    );
    catalogSource = {
      kind: "credentialless-capture",
      captureSha256: capture.sha256,
    };
  } else {
    compareSecurityCatalog(
      manifest.database,
      (dependencies.catalog ?? readSecurityCatalog)(env.DATABASE_URL),
    );
    catalogSource = { kind: "direct-database" };
  }
  if (!held) {
    await verifyDeployment(
      env.RELEASE_BASE_URL,
      manifest,
      dependencies.fetcher,
    );
    console.log(
      `postdeploy (${profile}): real API readiness, source, contract, assets, schema and security match ` +
        manifest.source.revision +
        "; this does not reopen external ingress or schedules",
    );
    return;
  }
  await verifyHeldDeployment(
    env.RELEASE_BASE_URL,
    manifest,
    identity,
    dependencies.fetcher,
  );
  const evidence = validateHeldEvidence(
    {
      format: 2,
      kind: "held-verification",
      revision: identity.buildRevision,
      manifestSha256: identity.manifestSha256,
      target: identity.target,
      recoveryPlanSha256: identity.recoveryPlanSha256,
      backupSha256: identity.backupSha256,
      verifiedAt: new Date().toISOString(),
      checks: Object.fromEntries(HELD_CHECKS.map((check) => [check, true])),
      apiReadinessVerified: false,
      catalogSource,
    },
    identity,
    { notBefore: Date.parse(plan.approvedAt) },
  );
  const bytes = JSON.stringify(evidence, null, 2) + "\n";
  // Never replace earlier evidence. Operators independently approve this digest.
  writeFileSync(args[2], bytes, { flag: "wx", mode: 0o600 });
  console.log(
    "postdeploy: HOLD/catalog/immutable CI assets verified; real API readiness NOT verified; evidence SHA256 " +
      digest(bytes) +
      ". Keep writers stopped pending explicit activation.",
  );
  return evidence;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await postdeploy();
  } catch (error) {
    console.error("postdeploy: FAILED: " + error.message);
    process.exitCode = 1;
  }
}
