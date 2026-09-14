# Operations and Rollback

## Environments

Development, staging, and production must use separate databases, secrets,
provider credentials, web origins, and backup destinations. Staging is the
promotion gate; it is not a production alias.

## Release Path (pilot profile)

A merge to `main` is deployed by one Replit Publish. There is no rebuild, no
install and no manual evidence file in this profile (ADR 0004); what the
Publish trusts is the immutable artifact CI produced for that exact commit.

1. Wait for CI on `main` to be green. Its last steps stamp
   `release/build-manifest.json` (source tree and byte hashes, the seven-app
   asset inventory, the contract version, the CI run identity) and its
   `.sha256` sidecar, and upload them with all seven `artifacts/<app>/dist`
   trees as `meridian-release-<sha>`.
2. Stage that artifact into the clean Replit checkout of the same commit:
   `release/build-manifest.json`, `release/build-manifest.json.sha256` and the
   seven `dist` trees. Do not rebuild, rename or merge older output into it.
3. Before Publish, rotate the single Publishing-scoped
   `RELEASE_MANIFEST_SHA256` value to the checksum printed by the selected CI
   artifact. In Replit Publishing settings, verify the displayed value matches
   the staged `release/build-manifest.json.sha256`, and verify there is no
   duplicate key across Publishing secrets and environment variables. Use the
   Publishing secret entry as the sole source of truth; a secret takes
   precedence over an environment variable with the same name.
   Release preparation checks secret and environment-variable key names first
   when a read-only metadata reader is available, and refuses before artifact
   download if both sources contain `RELEASE_MANIFEST_SHA256`. It never
   requests, records, or prints secret values. Replit currently exposes no
   documented authenticated metadata-only API for this configuration. The
   optional key-name snapshot (`{"secretKeys":[...],"environmentVariableKeys":[...]}`)
   can therefore catch duplicate settings before preparation, but is not an
   attestation. Do not pass arbitrary JSON or a workflow-dispatch value as
   Publishing provenance.
   The protected release handoff uses its existing trusted reviewer and
   `release-production-handoff` environment for explicit manual verification:
   the reviewer must bind the exact candidate/checklist and manifest checksum
   to the displayed production Publishing secret and confirm no
   environment-variable duplicate. If metadata is unavailable, this manual
   review is mandatory; a checked key-name snapshot does not replace it. The
   handoff receipt records this as manual verification, not authenticated
   platform provenance, and still refuses ordinary environment variables or
   workspace secrets as the checksum source. The reviewer must still verify
   the value in the production Publishing UI.
4. Publish. Every service's production build runs
   `node scripts/src/ops/replit-promote.mjs build <app>`, which refuses unless
   the checkout is clean, the local source tree, tracked-source hash and
   schema hash equal the manifest, and the packaged assets match the inventory
   byte for byte. These artifact builds perform no database mutation. Replit's
   native Publish flow compares development and production, surfaces any schema
   changes or rename decisions, and applies only the confirmed diff.
5. The API runs `replit-promote.mjs start api-server`: it re-verifies the
   packaged bytes without Git, sets `BUILD_REVISION` and
   `EXPECTED_BUILD_REVISION` to the tested revision, and imports the unchanged
   `artifacts/api-server/dist/index.mjs`. Boot re-asserts the guardrail
   migrations under an advisory lock and holds readiness until they verify.
6. Verify: `/api/healthz` reports the manifest's revision and contract version
   (the web apps' stale-build banner clears), `/api/readyz` answers `ready`,
   and `DATABASE_URL=… RELEASE_BASE_URL=https://… pnpm --filter
   @workspace/scripts run ops:postdeploy` confirms source, contract, public
   asset bytes and database catalog parity after the fact. When production
   database credentials are intentionally unavailable, use the credentialless
   catalog procedure below instead.

### Credentialless production catalog verification

A separately approved capture channel can supply the complete catalog without
exposing `DATABASE_URL` to the verifier, but its transaction guarantees must
first be verified. Run the exact `CATALOG_SQL` exported by
`scripts/src/ops/security-catalog.mjs` in one read-only, repeatable-read
transaction with the documented 30-second statement timeout. Do not edit the
query or copy individual sections.

The Replit production `executeSql` channel inspected on 2026-09-11 does not
currently meet these requirements: its wrapper uses read-committed isolation
with no statement timeout, rejects explicit transaction-control statements,
and exposes no options to request the required settings. Do not use that
channel to claim verification under this procedure. Use the direct
`DATABASE_URL` procedure with separately authorized connection access, or
another approved capture channel whose transaction guarantees can be verified.
The capture CLI validates catalog content and checksum bindings; it cannot
attest the transaction settings used by the external capture channel.

Save the single complete JSON object returned by `CATALOG_SQL` as a private raw
input file; do not copy individual sections or encode the object as a string.
Create the checksum-bound envelope in one command:

```bash
RELEASE_MANIFEST=release/build-manifest.json \
RELEASE_MANIFEST_SHA256="<trusted manifest digest>" \
RELEASE_BASE_URL="https://<production-origin>" \
  pnpm --filter @workspace/scripts run ops:capture-security-catalog -- \
  --input /private/path/raw-production-security-catalog.json \
  --output /private/path/production-security-catalog.json
```

The command validates the complete raw catalog against the trusted manifest and
security invariants before exclusively creating a `0600` output file. It refuses
malformed UTF-8/JSON, partial or unknown fields, unsafe state, non-regular or
symlink input, oversized input/output, an invalid origin, and an existing output
rather than overwriting evidence. It writes a format-1 envelope with the current
UTC capture time and prints the SHA-256 of the exact canonical bytes.

On Windows, use an owner-only directory with restrictive ACLs for both input
and output; POSIX mode `0600` does not establish Windows file permissions.

Obtain or approve the printed digest through the independent approved channel,
then run:

```bash
RELEASE_MANIFEST=release/build-manifest.json \
RELEASE_MANIFEST_SHA256="<trusted manifest digest>" \
RELEASE_BASE_URL="https://<production-origin>" \
RELEASE_SECURITY_CATALOG_SHA256="<independently captured envelope digest>" \
  pnpm --filter @workspace/scripts run ops:postdeploy -- \
  --catalog-file /private/path/production-security-catalog.json
```

Keep all other release-profile variables required by the selected HOLD/RUN flow.
For governed HOLD, append `--catalog-file <path>` after
`--held --evidence-out <new-file>`. The capture expires after one hour. Missing
or mismatched digests, stale or future timestamps, malformed UTF-8/JSON,
symlinks, oversized files, wrong manifest/origin bindings, incomplete catalogs,
unknown sections, unsafe catalog state, or any difference from the immutable CI
manifest fails closed. Omitting `--catalog-file` retains the direct
`DATABASE_URL` path.

Governed held evidence uses format 2. Its strict `catalogSource` field is
`{"kind":"direct-database"}` for the `DATABASE_URL` path, or
`{"kind":"credentialless-capture","captureSha256":"<approved digest>"}` for the
credentialless path. The latter digest is the independently approved SHA-256 of
the exact capture envelope bytes. It is retained inside the independently
hashed held-evidence record, so later review can identify and verify the catalog
provenance without external inference. Validation rejects missing or unknown
source fields, omitted or malformed capture digests, source tampering, and
format-1 held evidence. Format 1 is intentionally not accepted because it cannot
prove which catalog path supplied the successful check; regenerate held
evidence under format 2 rather than converting an old record.

The activation permit is the permanent activation audit record. When approving
RUN, copy the validated held evidence `catalogSource` into the permit exactly.
For a direct database check this remains only `{"kind":"direct-database"}`. For
a credentialless check retain only `kind` and the approved `captureSha256`;
never copy database credentials or catalog contents into the permit. Promotion
rejects any source that differs from the checksum-verified held evidence.

`RELEASE_RUNTIME_STATE=HOLD` is the maintenance switch in this profile: the API
serves `/api/healthz` only and answers 503 to everything else without
connecting to the database. Set it, Publish, do the maintenance, unset it,
Publish again.

Rollback in this profile is a Publish of the previous green commit's artifact:
the same steps with the earlier staged manifest and `dist` trees. Additive
schema changes are forward-compatible; a change that removed or retyped a
column needs a forward corrective migration instead (see Rollback below).

## Governed profile (HOLD/RUN)

`RELEASE_PROFILE=governed` keeps the R198–R200 ceremony for when a live tenant
base justifies it: the API boots in HOLD by default; `ops:release -- --yes` is a
read-only preflight that requires the trusted manifest checksum, a rollback
revision or an approved maintenance-forward plan, fresh backup and restore-drill
evidence and semantic catalog parity; RUN needs `RELEASE_RECOVERY_MODE=
maintenance-forward`, `RELEASE_TRAFFIC_DRAINED=1`, an activation permit bound
to the candidate, manifest, target, backup, plan and held evidence, and the
held-verification output of `postdeploy --held`. The evidence contracts,
identity bindings (`RELEASE_BASE_URL`, `RELEASE_TARGET_REPL_ID`, the three
independently trusted checksums) and the staging drills are recorded in
[the R198 records](history/2026-09-r198/README.md); `docs/environment.md`
lists every variable. Nothing in that path was removed — it is selected by
configuration, and its tests still run in CI.

Governed rollback mode also requires a retained, candidate-bound approval record:

```json
{
  "format": 1,
  "mode": "rollback",
  "revision": "<full candidate SHA>",
  "rollbackRevision": "<full qualified fallback SHA>",
  "approved": true,
  "approvedBy": "<reviewer identity>",
  "approvedAt": "<UTC timestamp>",
  "expiresAt": "<later UTC timestamp>",
  "qualificationEvidence": "<retained staging/CI evidence reference>"
}
```

Set `RELEASE_ROLLBACK_APPROVAL` to the private immutable record and
`RELEASE_ROLLBACK_APPROVAL_SHA256` to its independently captured digest.
Promotion preflight and governed API startup hash the exact bytes and bind both
full revisions before accepting rollback mode. Unknown fields, self-fallback,
unapproved records, future approval, expiry, tampering, or either revision
mismatch fail closed. A maintenance-forward RUN still requires its separate
plan, held evidence, writer drain, and fresh activation permit; rollback
approval never grants maintenance-forward authorization.

## Production Readiness Recovery

A healthy liveness endpoint is not proof that production can safely serve
requests. Bootstrap keeps application traffic and workers blocked until its
security checks pass. Do not bypass readiness to clear a deployment warning.

1. Read the failing readiness check and the restricted deployment logs. Compare
   the deployed revision and contract with the selected CI manifest. Check the
   production `PUBLIC_APP_URL`, runtime state and manifest checksum without
   exposing database, login or provider credentials.
2. Keep development-data copying **OFF**. Never use Publish's overwrite-data
   option to repair production, and do not run schema push against production.
   Preserve the current workspace and stop development watchers before staging
   all seven CI-built `dist` trees, the manifest and its sidecar for the exact
   reviewed commit. Do not mix a local rebuild with an immutable CI artifact.
3. Before a database repair, obtain explicit approval, a fresh private production
   backup and a successful restore drill in a separate disposable database.
   Confirm the recovery plan accounts for every writer and the candidate's
   compatibility with the retained fallback. A backup alone is not verification.
4. For supported structural changes, use the reviewed release path above and
   inspect Replit's native Publish schema diff. Startup then applies the reviewed
   guardrail migrations under an advisory lock and verifies them before opening
   traffic. A missing constraint or role is not permission to copy development
   data, grant broader privileges or run an arbitrary migration command online.
5. Missing historical baseline tables, unsupported role repairs or changes that
   cannot use the supported Publish flow require a separately approved offline
   maintenance plan. Stop every API instance, worker, schedule and external
   writer first. Follow the selected release profile's recovery requirements;
   `--offline-bootstrap` is only the governed profile's documented escape hatch,
   not a command to run against a live database. Keep writers stopped after a
   failed repair or verification and use the approved recovery plan.
6. Before restoring traffic, verify the expected revision and contract, readiness,
   public asset integrity and the complete production security catalog using the
   selected profile's verification procedure. Confirm the affected tenant-scoped
   flows work and retain the verification evidence privately. Restore traffic
   only after these checks succeed; keep development-data copying **OFF**.

## Database Safety

- Migrations are additive and ordered. Never edit an applied migration.
- Schema and guardrail migrations are both required.
- The post-merge hook is frozen-install plus reviewed versioned migrations only.
  Missing historical baseline tables require explicit offline maintenance;
  never repair that failure using an online schema push or non-frozen install.
- Neither release profile runs schema push or migrations from an artifact build.
  Replit's native Publish diff owns normal production schema changes. The
  governed profile's `--offline-bootstrap` is its explicit maintenance-only escape
  hatch requiring `RELEASE_TRAFFIC_DRAINED=1`, existing recovery evidence and
  the trusted manifest, with every API instance, worker, schedule and external
  writer stopped first. A crash or verification failure there means traffic
  remains stopped; the script cannot establish or release maintenance mode and
  never claims that it has.
- Long-running work and external calls must not hold request transactions.
- Consequential operations reserve idempotency before provider side effects.
- Rollback tests and restore drills use disposable databases only.
- A guardrail migration may assert an integrity constraint the Publish diff
  missed (0056 re-asserts the two `clerk_reservations` UNIQUE constraints by
  column, R113). Such a migration fails loudly on duplicate rows and boot then
  holds readiness, so before publishing a build that carries one, run its
  pre-check read-only against production and resolve any rows it reports:

  ```sql
  SELECT 'inference_call_id' AS col, inference_call_id AS value, count(*)
    FROM clerk_reservations WHERE inference_call_id IS NOT NULL
   GROUP BY 2 HAVING count(*) > 1
  UNION ALL
  SELECT 'provider_call_id', provider_call_id, count(*)
    FROM clerk_reservations WHERE provider_call_id IS NOT NULL
   GROUP BY 2 HAVING count(*) > 1;
  ```

  An empty result means the boot-time re-assertion adds the constraints and
  the catalogue comparison passes without manual DDL.

## Backup and Restore

These commands require separate operator approval; documenting them does not
authorize production reads, backup creation, maintenance or deployment. Use
Node plus `psql`, `pg_dump` and `pg_restore`; no npm database dependency is used.
Freeze migrations, extension changes, schema/ACL changes and role administration during backup.
Normal committed DML can continue: a held read-only REPEATABLE READ transaction
exports the snapshot used by both `pg_dump --snapshot` and the catalog, role
prerequisites and all public-table row counts. The source is not queried later
for replacement counts or a post-migration baseline. See PostgreSQL's
[snapshot synchronization](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION)
and [pg_dump snapshot option](https://www.postgresql.org/docs/16/app-pgdump.html).

Create a retained logical backup in an absolute, private directory dedicated to
one source database/environment, outside the checkout and deployment directory.
Do not share a retention directory across sources. POSIX permissions must be
0700; protect the
Windows directory with equivalent ACLs. UUID-suffixed archives use exclusively
opened 0600 descriptors rather than truncating a timestamp-based path:

```bash
BACKUP_DIR=/secure/meridian-backups \
BACKUP_RUNTIME_ROLE="<verified-application-login>" \
  pnpm --filter @workspace/scripts run ops:backup
```

The destination's parent must already exist. Before publishing a heartbeat or
pruning, the producer fsyncs the archive, manifest and checksum files, then the
destination directory and its parent. Any sync failure refuses publication.
The filesystem must support directory fsync; the current Windows runtime refuses
this operation rather than claiming durable success. Use the approved compatible
host/filesystem. No environment flag bypasses durability checks.

The producer prints the manifest checksum and writes a format-2 manifest containing the
archive hash, backup-time security catalog, row counts and referenced role
attributes. Obtain `BACKUP_MANIFEST_SHA256` independently from the approved
producer log or authenticated CI step output. A checksum sidecar supplied with
an untrusted archive is not a trust source. The manifest must be at most 24 hours
old, not future-dated, and the archive must match its hash and size.
Format-1 manifests are refused; they lack the stronger recovery evidence.

After approval, validate that specific retained archive. Supply the existing
source connection only for identity validation and recording the successful
drill heartbeat; it is not dumped again. Choose a fresh target name and explicitly
confirm it (connection values below are placeholders, not credentials):

```bash
BACKUP_MANIFEST="/secure/meridian-backups/<archive>.dump.manifest.json" \
BACKUP_MANIFEST_SHA256="<independently-approved-manifest-sha256>" \
DRILL_DATABASE_DISPOSABLE=1 \
DRILL_CONFIRM_TARGET="meridian_drill_<unique>" \
DRILL_DATABASE_URL="postgresql://.../meridian_drill_<unique>" \
  pnpm --filter @workspace/scripts run ops:restore-drill
```

The drill never drops or reuses a database and never uses `pg_restore --clean`.
It rejects the source database name regardless of hostname aliases, requires
the admin host/port to exactly match the target, and verifies a newly created
database marker before restoring. An existing name refuses. The target remains
for inspection on both success and failure; cleanup is a separately approved
operator action (CI discards its entire disposable PostgreSQL service).

`pg_dump` does not include cluster roles. `BACKUP_RUNTIME_ROLE` must explicitly
identify the intended non-superuser application login; it is not inferred from
an inspection/admin connection. The snapshot records recursive incoming and
outgoing memberships, their grantors and ADMIN/INHERIT/SET options, plus all
required role attributes. Database ACL/settings roles are included as roots.
The login must have a SET-enabled path to the restricted `meridian_app` role;
its BYPASSRLS attribute is recorded, not silently removed or inferred safe.
The target cluster must already have these exact prerequisites. Missing,
extra or different membership/role prerequisites refuse
before database creation; the drill never creates roles or grants privileges.
Provision a reviewed isolated cluster separately, including needed extensions
and matching PostgreSQL major. No production credentials are copied to do so.

Installed extension names, versions and schemas are captured in the same
snapshot and hash. The target must offer each exact version as its default;
for example, vector 0.8.6 cannot stand in for 0.8.0. A different default refuses
even if the old version is available, because ordinary dump extension creation
uses the target default. Installed versions/schemas are compared again after
restore. Provision the correct extension package separately, never silently
upgrade or downgrade while restoring.

After restore, the drill rechecks role memberships and probes actual
`SET ROLE meridian_app` under the intended login via transaction-local
`SET SESSION AUTHORIZATION`. The isolated target connection must be an admin
permitted to impersonate that login, or that login itself. This does not copy
passwords or verify password/HBA authentication. See PostgreSQL's
[membership options](https://www.postgresql.org/docs/16/catalog-pg-auth-members.html)
and [session authorization](https://www.postgresql.org/docs/16/sql-set-session-authorization.html).

Restore runs from a private checksum-verified copy of the retained archive.
The same snapshot captures `databaseProperties`: database owner, explicit
semantic ACLs (including PUBLIC CONNECT/TEMP), database and role-in-database
settings, encoding, locale provider/collation/ctype, ICU options and both recorded
and actual collation versions. Those properties are part of the snapshot hash.
The target is created explicitly under its guarded scratch name with
`TEMPLATE template0` and the captured owner/encoding/locale, never
`pg_restore --create`. Creation properties are checked before data restore.
After restore, the helper applies only the scratch database's ACL/settings and
compares the complete database baseline before publishing evidence. It does not
alter global role settings or cluster configuration. Database ACL/settings role
dependencies must already exist and match the role prerequisites.

Collation/provider or extension-version differences between Neon and the isolated
container may block restoration even on the same PostgreSQL major. Obtain a
matching target; never forge or refresh a collation version to satisfy the check.

Success requires full semantic catalog parity (migration ledger, role posture,
RLS policies/grants, constraints, indexes, functions and triggers) and every
recorded public-table count against the backup-time baseline. A migration-49
backup is compared with its migration-49 baseline even after source upgrade;
release preflight separately checks the candidate's expected migration-54 catalog.

Backup heartbeat metadata has `evidenceVersion: 2`, `sha256`, `snapshotSha256`,
`manifestSha256`, `file`, `manifestFile`, `bytes`, `tocEntries` and `createdAt`.
The snapshot hash covers the exact JSON object
`{catalog,rowCounts,roles,roleRoots,memberships,runtimeLogin,extensions,databaseProperties}`.
Drill metadata has `evidenceVersion: 2`, matching `backupSha256`,
`snapshotSha256`, `backupManifestSha256`, `backupCreatedAt`, `targetDatabase`,
`durationSeconds`, `securityCatalogVerified: true` and
`allTableCountsVerified: true`. Completion timestamps remain database-recorded
`last_succeeded_at` values. No success heartbeat is written for failed verification.

CI passes the retained producer step's manifest path/hash directly to the drill,
keeps backup files under the private runner temporary directory, and tests a
concurrent post-snapshot insert plus a later schema change. Catalog subprocess
capture is bounded at 16 MiB. Retention checks regular files and rejects symlinked
bundles; incomplete captures and unrelated files are not pruned. An exclusive
same-directory operation lock is acquired before snapshot capture and held
through heartbeat publication and retention. A second invocation refuses before
capture; an abandoned lock requires operator investigation, not automatic removal.
This is not global serialization across backup directories. Across directories,
the source database atomically refuses a backup heartbeat whose snapshot
`createdAt` predates the already recorded backup. Rejection does not prune files
or publish CI outputs. A verified archive is retained on publication or retention
failure for operator inspection. Protect all artifacts as production data.

This is a logical application backup, not a cluster-global or PITR backup. It
does not export role passwords or provision target extensions/cluster settings.
PostgreSQL client arguments never contain URL passwords: the connection helper
moves them to child `PGPASSWORD`, rejects password/service query overrides,
preserves TLS/socket parameters, and redacts credential-bearing errors/causes.
No password file is written. Existing process environment credentials remain
sensitive and must be protected by the operator.
Source access includes read-only snapshot/catalog/count queries and one successful
`backup` or `restore_drill` operational-heartbeat write; it is not literally a
read-only operation end to end. No application data is modified by these commands.
The CI integration test intentionally creates/changes a fixture table and must
only run against its explicitly disposable test database, never production.

For R198, the user has authorized the parent to perform an initial production
backup, isolated restore and local download; credentials and host operations
remain with the parent. No maintenance drain has been performed or implied by
that approval. The initial drill can establish capability, but a maintenance
release plan requiring a post-drain pre-change snapshot still needs a fresh
backup and matching retained-archive drill after that separately approved drain.

## Rollback

In the pilot profile an application-only rollback is a Publish of the previous
green commit's artifact (Release Path above). The rest of this section is the
data-compatibility reasoning that decides whether that is enough.

For the contract 0.99.0 transition, baseline
`8347dd29f3d947634a62739088e67548a8d0a946` (0.98) is not write-compatible with
the new revision/idempotency guarantees. Its application does not enforce
invoice content revisions or create/import idempotency, bind approvals to the
reviewed revision, or account for outstanding Clerk reservations. Additive
database columns and tables do not supply those missing application checks.
Do not serve that build against upgraded production data as an ordinary rollback.

No qualified 0.99-compatible fallback has yet been established for R198.
Qualification requires a successful immutable CI artifact and staging tests
against post-upgrade data: stale edit/approval rejection, original-key replay
and changed-payload refusal, import checkpoints, draft tombstones, and unsettled
Clerk spend. Record the fallback's full manifest revision and evidence before
setting `RELEASE_ROLLBACK_REVISION`. The current gate checks SHA syntax, not this
compatibility evidence; an arbitrary, baseline or candidate SHA must not be used
merely to satisfy it.

Without a qualified fallback, the alternative is a separately reviewed,
externally enforced maintenance and forward-recovery policy: stop all APIs,
workers, schedules and other writers, retain database evidence, and resume only
after a verified corrective release. The release gate now supports that explicitly
selected maintenance-forward mode with an independently approved plan and
retained-backup binding. HOLD/RUN adds separately approved startup admission;
it is not an automatic resume or a rollback-compatibility exemption. Preparation
approval does not authorize drain, migrations, Publish or activation. Follow the
HOLD/RUN procedure and retain all existing freshness, security-catalog and
immutable-artifact gates.

Application-only rollback:

1. Stop promotion and affected writes; preserve logs/request IDs.
2. Redeploy only the qualified contract-compatible immutable artifact, including
   its matching API, web and mobile assets. Do not mix 0.98 and 0.99 writers.
3. Keep migrations 0050-0054 applied, with all constraints, grants, RLS policies
   and triggers intact. No ordinary down migration is part of this procedure.
4. Verify the runtime revision against the fallback manifest, recheck readiness,
   asset/security parity and recovery journeys, then reopen approved traffic.
   Replay work only with its original idempotency key and payload.

Database-impacting rollback:

1. Externally stop every affected writer, including workers and schedules.
2. Prefer a forward corrective migration.
3. Do not run 0050-0054 downs for ordinary recovery. The ladder proves specific
   data-preservation behavior, not old-application write compatibility; 0051 and
   0054 downs remove operation/import safeguards. Any exceptional database
   recovery requires its own reviewed and tested incident plan.
4. Restore from the pre-release backup only as an incident decision, with the
   accepted recovery-point loss and reconciliation of external side effects
   recorded. A historical restore is not a contract-compatible application rollback.

Never roll back append-only audit or inference ledgers by deleting evidence.

## Observability

Correlate every incident with build revision, contract version, request ID,
firm/party scope where permitted, operation type, and sanitized provider
outcome. Never log tokens, cookies, document bodies, raw model prompts,
personal data, or unrestricted provider payloads.

Minimum release signals are readiness, 5xx/429 rates, p95 latency, DB pool
pressure, oldest pending outbox age, dead-letter count, rail breaker state,
Clerk invalid/error rate, spend, and backup/restore heartbeats.
