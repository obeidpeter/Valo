import app from "./app";
import {
  pool,
  closeDatabasePools,
  applyMigrations,
  applyGuardrailMigrations,
  requireDatabaseUrl,
  ensureAppRoleAssumable,
} from "@workspace/db";
import { logger } from "./lib/logger";
import {
  awaitWorkerIdle,
  startWorker,
  stopWorker,
} from "./modules/pipeline/pipeline";
import { seedPlatform } from "./bootstrap/seed";
import { disableProductionDemoIdentities } from "./bootstrap/security";
import { provisionProductionPilotOperator } from "./bootstrap/pilot-operator";
import { assertEvidenceGuardrails } from "./bootstrap/evidence-guardrails";
import { PRODUCTION_RECOVERY_GUIDANCE } from "./bootstrap/recovery-guidance";
import { assertSessionSigningConfigured } from "./modules/auth/session";
import { assertPublicAppUrlConfigured } from "./lib/public-app-url";
import { markReady, markUnready } from "./lib/readiness";
import { installGracefulShutdown } from "./lib/shutdown";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Apply the hand-written guardrail migrations (RLS policies, append-only
// triggers) to the production database on boot. They are NOT part of the
// Drizzle schema, so Replit's Publish schema-diff never creates them — without
// this, guardrails added after initial provisioning would not reach production.
// Safety properties:
//   - every migration `up` is idempotent (re-runnable), and the whole apply is
//     serialized under a session advisory lock, so concurrent Autoscale
//     instances booting at once cannot race;
//   - a guardrail whose target table does not exist yet (Publish has not
//     shipped that feature's schema) is reported as a failed readiness check;
//   - it runs after app.listen(), so liveness remains available, while every
//     other route and the worker remain disabled until it succeeds.
async function applyProductionGuardrails(): Promise<void> {
  try {
    const { applied, skipped } = await applyGuardrailMigrations(pool);
    if (skipped.length > 0) {
      logger.warn(
        { skipped },
        "Guardrail migrations skipped (target relation/object missing — " +
          "expected when Publish has not yet created the table; they will " +
          "apply on a boot after that schema ships)",
      );
      throw new Error(
        `Production guardrail migrations were skipped: ${skipped
          .map((item) => `${item.version}:${item.name}`)
          .join(", ")}`,
      );
    }
    logger.info(
      { applied: applied.length, skipped: skipped.length },
      "Production guardrail migrations applied",
    );
  } catch (err) {
    logger.error(
      { err },
      "SECURITY: could not apply guardrail migrations to production; " +
        "RLS/append-only protections may be missing or stale. Readiness remains blocked. " +
        PRODUCTION_RECOVERY_GUIDANCE,
    );
    throw err;
  }
}

// Read-only check that the data-layer tenant-isolation guardrails are present in
// production. RLS policies (meridian_tenant_isolation) and append-only triggers
// (meridian_append_only) live in hand-written migrations (0001/0002), not the
// Drizzle schema, so Replit's Publish schema-diff does NOT create them; the boot
// step above (applyProductionGuardrails) is what applies them. This check never
// blocks the liveness port, but it blocks readiness and application traffic so
// tenant isolation is never silently absent.
async function verifyProductionGuardrails(): Promise<void> {
  try {
    await assertEvidenceGuardrails(pool);
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*) FROM pg_policies
            WHERE schemaname = 'public'
              AND policyname = 'meridian_tenant_isolation') AS policies,
         (SELECT count(*) FROM pg_trigger
            WHERE tgname = 'meridian_append_only' AND NOT tgisinternal) AS triggers`,
    );
    const policies = Number(rows[0]?.policies ?? 0);
    const triggers = Number(rows[0]?.triggers ?? 0);
    // Coverage sweep (read-only): any tenant-keyed table (firm_id /
    // client_party_id / party_id column) without forced RLS + a policy is a
    // gap the CI rls-coverage test would fail on — surface the specific
    // tables here so a production database that predates a guardrail
    // migration (e.g. 0013) reports exactly what is missing. audit_events is
    // the one documented exemption (global hash chain; migration 0013 header).
    const uncoveredRes = await pool.query(
      `SELECT c.table_name
       FROM (SELECT DISTINCT col.table_name
               FROM information_schema.columns col
               JOIN information_schema.tables t
                 ON t.table_name = col.table_name AND t.table_schema = 'public'
              WHERE col.table_schema = 'public'
                AND t.table_type = 'BASE TABLE'
                AND col.column_name IN ('firm_id', 'client_party_id', 'party_id')) c
       JOIN pg_class k ON k.relname = c.table_name
       JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = 'public'
       WHERE NOT (k.relrowsecurity AND k.relforcerowsecurity)
          OR NOT EXISTS (SELECT 1 FROM pg_policies p
                           WHERE p.schemaname = 'public'
                             AND p.tablename = c.table_name)
       ORDER BY c.table_name`,
    );
    const uncovered = (uncoveredRes.rows as { table_name: string }[])
      .map((r) => r.table_name)
      .filter((t) => t !== "audit_events");
    const requiredIndexesRes = await pool.query<{ index_name: string }>(
      `SELECT required.index_name
         FROM (VALUES
           ('settlement_events_external_reference_uq'),
           ('outbox_events_inbound_dedupe_idx'),
           ('clerk_cases_live_dedupe_uq'),
           ('collection_accounts_one_active_per_client'),
            ('payment_intents_provider_ref_uq'),
            ('password_resets_one_pending_per_user_uq'),
            ('consent_records_party_command_layer_uq'),
            ('outbox_events_processing_lease_idx')
         ) AS required(index_name)
        WHERE to_regclass('public.' || required.index_name) IS NULL
        ORDER BY required.index_name`,
    );
    const missingIndexes = requiredIndexesRes.rows.map((row) => row.index_name);
    // pgvector presence (round 45): migration 0038's tolerant DO block
    // downgrades a missing-extension error to a pg NOTICE nothing surfaces,
    // so THIS is the operator-visible signal. Not a security gap — the
    // memory rail feature-detects and stays dark — but a silently-absent
    // extension would otherwise read as "memory just never indexes".
    const extRes = await pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'vector' LIMIT 1",
    );
    if (extRes.rowCount === 0) {
      logger.warn(
        "pgvector extension is not installed on this database; the Clerk " +
          "firm-memory rail stays dark until the cluster provides it " +
          "(migration 0038 could not create it).",
      );
    }
    if (
      policies === 0 ||
      triggers === 0 ||
      uncovered.length > 0 ||
      missingIndexes.length > 0
    ) {
      logger.error(
        { policies, triggers, uncovered, missingIndexes },
        "SECURITY: production tenant-isolation guardrails are MISSING or " +
          "incomplete (RLS policies / append-only triggers / uncovered " +
          "tenant-keyed tables listed above). Tenant isolation is not fully " +
          "enforced and readiness remains blocked. " +
          PRODUCTION_RECOVERY_GUIDANCE,
      );
      throw new Error(
        `Production guardrails incomplete: ${policies} policies, ${triggers} triggers, uncovered=${uncovered.join(",")}, missingIndexes=${missingIndexes.join(",")}`,
      );
    } else {
      logger.info(
        { policies, triggers, requiredIndexes: 8 },
        "Production guardrails verified",
      );
    }
  } catch (err) {
    logger.error({ err }, "Could not verify production guardrails");
    throw err;
  }
}

// Repair the login role's ability to assume the restricted RLS role at startup.
// See ensureAppRoleAssumable() in @workspace/db for why this is required in a
// deployment (non-superuser login missing the PG16 SET membership option) and a
// no-op in development. A failure blocks readiness and is retried by the
// bootstrap loop, while the liveness endpoint remains available.
async function ensureRlsRoleAssumable(): Promise<void> {
  try {
    const status = await ensureAppRoleAssumable();
    if (status === "granted") {
      logger.warn(
        "Granted the login role the SET privilege on meridian_app; the RLS " +
          "role is now assumable (SET ROLE meridian_app will succeed).",
      );
    } else if (status === "already-assumable") {
      logger.info("RLS role meridian_app is assumable");
    } else if (status === "role-missing") {
      logger.error(
        "SECURITY: role meridian_app is MISSING, so SET ROLE will fail and no " +
          "tenant-scoped request can run. " +
          PRODUCTION_RECOVERY_GUIDANCE,
      );
      throw new Error("Database role meridian_app is missing");
    } else {
      logger.error(
        "SECURITY: could not obtain the SET privilege on meridian_app; SET ROLE " +
          "will keep failing. An authorized operator must review the login role's " +
          "membership and ADMIN/SET options. " +
          PRODUCTION_RECOVERY_GUIDANCE,
      );
      throw new Error("Database role meridian_app is not assumable");
    }
  } catch (err) {
    logger.error(
      { err },
      "Could not ensure the RLS role is assumable; SET ROLE meridian_app may fail",
    );
    throw err;
  }
}

async function bootstrapApplication(isProduction: boolean): Promise<void> {
  if (!isProduction) {
    const applied = await applyMigrations(pool);
    logger.info(
      { applied: applied.length },
      applied.length ? "Migrations applied" : "Migrations up to date",
    );
    await seedPlatform();
    return;
  }

  // Apply the guardrail migrations first (idempotent, advisory-locked), then
  // run the read-only verification so the deploy logs state the final truth.
  await assertSessionSigningConfigured();
  // R112: the links the platform sends (password recovery, Invoice Room) are
  // built on PUBLIC_APP_URL and on nothing else, so production holds
  // readiness until a safe origin is configured — the rollout's /api/readyz
  // probe fails rather than mailing links to a hostname in the code.
  assertPublicAppUrlConfigured();
  await ensureRlsRoleAssumable();
  await applyProductionGuardrails();
  await verifyProductionGuardrails();
  const disabled = await disableProductionDemoIdentities();
  if (disabled > 0) {
    logger.warn(
      { disabled },
      "Disabled copied demonstration identities in production",
    );
  }
  const pilotOperator = await provisionProductionPilotOperator();
  if (pilotOperator === "provisioned") {
    logger.warn(
      "Provisioned the first individual production operator; remove the pilot operator bootstrap settings and restart",
    );
  } else if (pilotOperator === "already-provisioned") {
    logger.info("Individual production operator already provisioned");
  } else if (pilotOperator === "rejected") {
    logger.error(
      "Pilot operator bootstrap settings were rejected; serving without a bootstrapped operator (R111: not retried)",
    );
  }
}

function bootstrapRetryDelay(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
}

async function main(): Promise<void> {
  // Fail fast on a missing database before serving anything (the pool itself
  // is lazy so that pure-function tests can import the schema without a DB).
  requireDatabaseUrl();

  // Open the port FIRST. Nothing before app.listen() may block on the database:
  // the liveness probe (/api/healthz) does not touch the DB, so the artifact can
  // promote even while the database is still warming up or briefly unreachable.
  // Previously app.listen() was gated behind applyMigrations()/seedPlatform(), so
  // a slow or hanging database connection at boot meant the port never opened and
  // the publish failed with "required port was never opened".
  const server = app.listen(port, (err?: Error) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
  });

  // Graceful shutdown (R101, lib/shutdown.ts): readiness off → worker timers
  // stopped → server drained → in-flight pass awaited → pool closed → exit.
  installGracefulShutdown({
    server,
    markUnready,
    stopWorker,
    awaitWorkerIdle,
    closePool: closeDatabasePools,
    exit: (code) => process.exit(code),
    log: logger,
  });

  const isProduction = process.env.NODE_ENV === "production";

  // Schema and seed data for PRODUCTION are owned by Replit's Publish flow (the
  // schema diff applied on publish) — NOT by the application, so demo seeding and
  // the full dev bootstrap only run outside production. The one exception is the
  // hand-written guardrail migrations (RLS, append-only triggers): Publish cannot
  // create those, so production applies them idempotently on boot below.
  // A transient database failure must not leave a healthy process permanently
  // wedged in an unready state. Keep liveness available, retry with bounded
  // backoff, and start traffic/workers exactly once after every prerequisite
  // succeeds.
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await bootstrapApplication(isProduction);
      startWorker();
      markReady();
      logger.info(
        { attempt },
        "Application bootstrap complete; instance is ready",
      );
      break;
    } catch (err) {
      markUnready("bootstrap_failed");
      const retryInMs = bootstrapRetryDelay(attempt);
      logger.error(
        { err, attempt, retryInMs },
        "Bootstrap failed; API traffic and workers remain disabled; retrying",
      );
      await new Promise((resolve) => setTimeout(resolve, retryInMs));
    }
  }
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
