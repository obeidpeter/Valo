# Troubleshooting

## `pnpm` or `node` Is Not Found

Use Node 22/24 and pnpm 10/11. In Codex desktop, load the bundled workspace
dependencies before running commands. Do not substitute npm or yarn; the
preinstall guard removes foreign lockfiles.

## Build Requests `PORT` or `BASE_PATH`

Current app configs have checked-in defaults. Pull current `main` and run
`pnpm run build`. Deployment workflows can still override both variables.

## Database Tests Return Permission Errors

First confirm `DATABASE_URL` points to a separate, disposable PostgreSQL 16
test database with pgvector, and that the test role can create the required
roles/extensions. The following commands are for that disposable database
only, never production. The table schema exists but guardrails may not; run both:

```bash
pnpm --filter @workspace/db run push
pnpm --filter @workspace/db run migrate
```

For a production readiness failure, follow
[Production Readiness Recovery](operations.md#production-readiness-recovery).

## App Shows a Stale-Build Banner

Compare `/api/healthz` contract/build data with the deployed web bundle. A
merge alone does not restart an existing process. For local development,
rebuild and restart the development workflow. For production, use the
[release path](operations.md#release-path-pilot-profile): stage the exact CI
artifact's seven `dist` trees, manifest and sidecar without rebuilding them,
then verify `EXPECTED_BUILD_REVISION` matches the running SHA. Do not suppress
the banner or reuse locally rebuilt output for publication.

## Replit Preview Does Not Reflect a Merge

Preserve any uncommitted or unpushed work first. Confirm the development Repl
is tracking the intended reviewed commit, pull/sync it, then restart the
Project workflow to check the development preview. Do not restart development
watchers on a checkout already staged for immutable publication: they can
replace the CI-built output. Production publishing is a separate, explicit
action; stop watchers and stage the complete matching CI artifact through the
[release path](operations.md#release-path-pilot-profile) before Republish.

## API Is Healthy but Not Ready

Read `/api/readyz` and the release-readiness detail. Common causes are pending
migrations, a bootstrap failure, missing signing keys, stale operational
heartbeats, or a required live integration that is not configured. For
production, follow
[Production Readiness Recovery](operations.md#production-readiness-recovery).
Keep development-data copying OFF and keep readiness enforced while repairing
the underlying cause.

## Clerk Features Are Unavailable

Check the `clerk_ai` feature flag, provider key/base URL, model tier mapping,
firm budget, consent, and gateway ledger. A missing provider configuration is
expected to fail closed. Do not bypass the gateway or disable schema checks.

## Architecture Check Fails

Read the reported cycle or boundary. Move shared types/pure helpers into a
neutral lower-level module. Do not suppress a cycle by changing only the
import syntax. Tests may import route harnesses; production domain modules may
not import routes.

## Secret Scan Fails

Remove the credential from the working tree, rotate/revoke it, and purge it
from Git history before pushing. Replacing it with a placeholder is not enough
after a real secret has been committed.

## Large Bundle Warning

Console and SME bundles still exceed Vite's advisory threshold. Treat the
warning as tracked debt, not a failed build. Prefer route-level lazy imports
and measured chunking; verify deep links, loading states, and error boundaries
after each split.
