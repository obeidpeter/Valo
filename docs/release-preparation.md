# Release Preparation Sidecar

This is artifact preparation, not deployment. The authoritative release and
schema procedures remain [Operations](operations.md) and
[ADR 0004](adr/0004-release-profiles.md). Neither merging nor approving this
workflow authenticates to Replit, publishes an app, starts a service, opens a
database connection, or authorizes production changes.

## Existing Tooling Audit

- `build-manifest.mjs` already owns source/tree/schema identity, seven-app asset
  inventory, manifest checksums, and mobile configuration parity. It stamps the
  manifest only in the existing CI job against a disposable database.
- `replit-promote.mjs` already owns clean-source and immutable-artifact gates.
  The sidecar runs its exported `promoteReplit` for all seven apps, with explicit
  `RELEASE_PROFILE=pilot`, `RELEASE_RUNTIME_STATE=RUN`, and the verified manifest
  checksum. This is its artifact-only build verification, never its `start`
  action. The API and mobile bundles are not imported.
- `postdeploy.mjs` owns real readiness, served-byte, and database catalog parity
  after deployment. Preparation does not pretend to run that live check.
- `release.mjs` and the governed recovery/activation tools retain their existing
  requirements. A pilot preparation receipt cannot replace a governed RUN permit.

The preparation tooling fills the transport/provenance, isolated-checkout, and
human handoff gaps. It does not edit those gates, `.replit`, or schema tools.

## Parallel CI And Artifact Reuse

`quality-gate` and `e2e` run independently on separate runners and disposable
databases. E2E builds the seven production packages once, runs the existing
browser/journey checks, and stamps the immutable manifest. Bundle budgets read
those same frontend outputs instead of rebuilding them. CI moves the five Vite
bundle manifests to `tmp/route-budget-r198` before stamping: they are diagnostic
metadata, not public website files. No runtime bundle is rewritten.

E2E records independently supplied manifest and full candidate-tree checksums
in job outputs, then uploads a non-release candidate named
`meridian-tested-<sha>-<run>-<attempt>`. The transfer checksum includes hidden
files, maps and auxiliary package files. This candidate is not deployable release
evidence, even if E2E passes while the quality job fails.

The final `release-artifact` job requires both successful gates. It downloads the
exact candidate ID outside the source checkout, verifies every transferred byte,
source/tree/schema identity, CI run/attempt and mobile target, then uploads the
unchanged files as `meridian-release-<sha>`. It installs nothing, does not rebuild
or restamp, opens no database, and executes no downloaded application code.
Missing outputs, altered packages, skipped gates or stale attempts fail closed.

The consumer verifies all three jobs and their ordered producer steps. Existing
two-job release evidence remains supported under its original checks; removing
the qualifier from new evidence cannot downgrade it because E2E no longer has
the final release-upload step. Always rerun **all jobs** after a failed attempt.
Elapsed-time savings must be measured on hosted CI after this workflow lands;
local tests verify the graph and provenance constraints, not runner scheduling.

## Trust And Selection

Supply the repository, full source SHA, CI run ID, and exact attempt. There is
no automatic latest-run or latest-artifact fallback. GitHub's authenticated
read-only REST responses must establish:

1. The producer is this repository's `.github/workflows/ci.yml`, running a
   `push` or `workflow_dispatch` on `main`, at that SHA, completed successfully.
   A fork, PR event, different workflow, unfinished run, or failed run refuses.
2. Both the run and attempt endpoints still identify the requested attempt.
   `quality-gate` and `e2e` must each occur exactly once and succeed in that
   attempt; the manifest-stamp and artifact-upload steps must succeed too. For
   the parallel workflow, `release-artifact` must also succeed after both gates,
   including its immutable verification and final artifact-upload steps.
3. Complete paginated artifact enumeration finds exactly one
   `meridian-release-<sha>`. Its numeric ID, repository/head-repository IDs,
   branch, SHA, non-expiration, producer-job timestamps, byte count, and
   GitHub-provided SHA-256 digest must agree. A missing digest refuses; the
   manifest's adjacent checksum is not an independent provenance root.
4. The downloaded ZIP matches that authenticated digest and byte count. The
   download follows GitHub's redirect only to its own artifact storage hosts
   (`*.githubusercontent.com`, `*.blob.core.windows.net`) and never carries the
   API token there; any other redirect host refuses before a byte is fetched.
   Its manifest binds the same repository/run/attempt/SHA. Producer selection is
   repeated after gates and before approved handoff to detect reruns/deletion.

Only the current successful attempt is accepted. Partial job reruns that reuse
older job/artifact evidence refuse: rerun the complete CI workflow, then use
that exact successful attempt. Old artifacts without GitHub's digest need a new
CI producer, not an override. An older successful `main` commit is permitted for
an explicitly selected fallback; this is not a claim that it is today's HEAD.

This is authenticated GitHub producer provenance, not a new signed build
attestation. Protect `main`, the CI workflow, and release tooling with normal
review rules. A compromised repository administrator or CI producer is outside
this trust model. No production credentials, backups, tenant exports, database
dumps, or business data belong in this workflow. Only the existing seven-app
release artifact and CI metadata are downloaded, not unrelated run artifacts.

GitHub documents the [artifact digest and provenance fields](https://docs.github.com/en/rest/actions/artifacts)
and [run/attempt and review APIs](https://docs.github.com/en/rest/actions/workflow-runs).

## Local Preparation

Requirements: Node 22+, Git, Python 3.11+, a local clone containing the selected
commit, and a token with repository contents/Actions read access. No pnpm
installation or workspace dependencies are needed. Python's standard `zipfile`
parser is used rather than a new ZIP parser or transitive npm dependency.

Use an already configured read-only `GITHUB_TOKEN`; do not place token values on
the command line or in files. First inspect the selection without writes:

```sh
node scripts/src/ops/release-candidate.mjs \
  --repository OWNER/REPOSITORY --run-id RUN_ID --attempt ATTEMPT \
  --revision FULL_40_CHARACTER_SHA --dry-run
```

Dry-run verifies producer metadata only. It does not download or validate ZIP
bytes, clone, run artifact gates, create evidence, or grant approval. The
workflow also checks the configured approval environment during dry-run.

For preparation, use a new output directory under an existing private parent,
outside the development checkout and any directory watched by development tools:

```sh
node scripts/src/ops/release-candidate.mjs \
  --repository OWNER/REPOSITORY --run-id RUN_ID --attempt ATTEMPT \
  --revision FULL_40_CHARACTER_SHA \
  --source /absolute/development-clone \
  --output /absolute/private-release-staging/new-candidate \
  --python python3
```

Windows accepts absolute Windows paths and `--python C:/path/to/python.exe`.
Use PowerShell's invocation syntax for an absolute Node executable path.
The output must not exist; rerunning never merges or overwrites it. No fetch,
checkout, index update, branch change, hook, or clean operation occurs in the
development checkout. A local `git clone --no-local --no-checkout` creates an
independent object database, inspects every source tree mode before checkout,
checks out the exact SHA with byte-preserving line endings, and removes its
remote. Uncommitted development changes are not included or reverted.

The successful directory contains:

```text
new-candidate/
  source/                 matching Git checkout plus untouched CI package
  evidence/
    original.zip          exact GitHub archive, never repacked or modified
    provenance.json       the producer fields the checks consumed, re-validatable
    inventory.json        every transported file's bytes and SHA-256
    gates.log             existing seven-app artifact gate output
    checklist.md          exact checksums and settings requiring review
    candidate.json        candidate identity and evidence checksum bindings
```

The original ZIP remains nested inside the workflow's evidence upload, preserving
its producer checksum even though GitHub wraps the evidence in a second ZIP.
Record the candidate checksum from the preparation job summary; do not trust a
replacement checksum file arriving through an unrelated channel.

## Archive And Failure Safety

ZIP entries are inspected and read for CRC/hash validation before extraction.
Absolute paths, traversal, backslashes, Windows device names/alternate streams,
ambiguous trailing dots/spaces, symlinks, special file modes, encryption,
duplicate entries, case aliases (including parent directories), file/directory
collisions, duplicate JSON keys/assets, empty extra directories, and missing or
extra package files refuse. Files are created exclusively; no `extractall` or
shell-built archive commands are used. Source symlinks and Git submodules refuse
before checkout even on Windows configurations that materialize symlinks as files.

The seven-app inventory is exact. Existing `build-manifest` deliberately excludes
source maps: the sole transport exception is `<inventoried-file>.map`. These
companions are preserved and independently hashed in `inventory.json`. Orphan
maps refuse. Hidden inventoried files are mandatory. Limits are 100,000 entries,
4 GiB archive/expanded bytes, 512 MiB per entry, and 32 MiB manifest; only stored
and deflated ZIP entries are supported. Unsupported packaging refuses instead
of silently omitting files or weakening existing verification.

Every existing path component must be real, and no stage may overlap its source.
Child processes receive a small OS environment allowlist, no Node preloads,
Git configuration injection, provider tokens, or database configuration. The
trusted preparation checkout supplies the existing gate implementation, passing
the matching-source candidate as its root; candidate source is not executed.
Use a private owner-controlled directory or an ephemeral hosted runner: path
checks are not a sandbox against a hostile process racing filesystem changes
under the same OS identity. Do not attach a watcher to `source/`.

On a handled failure, only the newly reserved `source`, extraction directory,
and Git template are removed. Original download bytes and producer evidence stay
with `failure.json`; its `archiveVerified` distinguishes authenticated complete
archives from partial/failed downloads. Cleanup failures are recorded explicitly.
Any failed evidence bundle is invalid for handoff. A hard kill or machine crash
can leave a partial directory: retain evidence, discard that entire private
candidate only after checking its absolute path, and choose a fresh destination.
Never resume by merging. Hosted-runner disks are ephemeral; evidence retention
is 30 days, subject to repository policy. Cancellation can prevent upload.

## Protected Approval

Before enabling `.github/workflows/prepare-release.yml`, an administrator must
create the exact environment `release-production-handoff`, require human
reviewers, enable **Prevent self-review**, and select custom deployment branch
rules with exactly one **branch** rule named `main`. Disable administrator bypass
in repository settings as well. No production secrets belong in this environment.
The workflow refuses absent/unreadable policy, missing reviewers, self-review,
or broader branch rules. GitHub plan/repository support for protection rules is
a prerequisite, not something this tool attempts to bypass. See
[GitHub environment protection](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

Dispatch **Prepare Release** from `main` with the explicit producer selection.
It defaults to dry-run. An actual preparation retains its original archive and
checklist before the separate `handoff` job waits at the protected environment.
Review the candidate checksum, source identity, all seven app outputs, settings,
target, schema responsibilities, and rollback requirements before approval.
Required operator settings include Replit Publish development-data copying
**OFF** and `PUBLIC_APP_URL` set to the correct live HTTPS origin for the approved
production target, never a preview, localhost, or staging origin. The sidecar
only records these unchecked obligations; it does not configure production.
The handoff has no authenticated Replit metadata channel and does not pretend
that one exists. The optional local key-name snapshot is useful for duplicate
detection only; it never proves a secret value or a setting scope. Instead, the
existing protected `release-production-handoff` environment supplies an
explicit manual verification step. Before approving that environment, the
trusted reviewer must inspect this exact candidate/checklist, open the
production **Publishing** setting, verify that the displayed
`RELEASE_MANIFEST_SHA256` secret equals the candidate's manifest checksum, and
verify that no Publishing environment variable has the same key. If the
metadata snapshot is unavailable, this manual review is mandatory rather than
silently treated as an automatic pass. A checked snapshot still requires the
same manual value and scope review.

Only the production Publishing secret is accepted: an ordinary production
environment variable, workspace secret, or self-asserted workflow value cannot
satisfy the check. The receipt records `MANUALLY_VERIFIED`, the exact candidate
and expected manifest checksums, exact checklist checksum,
`production Publishing` scope, sole-secret assertion, the protected
environment, reviewer identity, and `platformAttestation: false`; it never
contains the secret. This uses the existing trusted reviewer/environment
boundary and does not authorize Publish or change any Replit setting.
The job downloads the exact preparation artifact ID and verifies every retained
file against the candidate checksum passed by the producing job, not by filename
selection or a self-supplied sidecar.

The handoff still requires one explicit approved environment review by a human
other than the initiator, checked against GitHub's review-history API; an admin
bypass without that review cannot issue a receipt. Preparation workflow reruns
are deliberately prohibited because review history is not attempt-bound:
dispatch a fresh workflow instead. The approval record binds
candidate/checklist, original archive, manifest, producer run/attempt, manual
Publishing verification, reviewer, environment, and preparation run. It is an
audit receipt, not a credential or portable deployment authorization. The
approved checklist keeps its original unchecked obligations; automation does
not claim the operator completed them.

The documented review-history response exposes `state`, `environments`, and
`user`, not an attempt binding or bypass discriminator. The code does not invent
an `approvedAt`, `run_attempt`, or bypass flag in that response, nor infer approval
from a comment. Disabling administrator bypass remains an administrative
prerequisite; the receipt is not proof of that setting. The protected environment
is the enforcement boundary, and the REST review record is additional evidence.
These distinctions follow the official
[review-history API](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run)
and [deployment review/bypass documentation](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments).

An authorized operator must separately approve and perform authenticated native
Replit Publish from an isolated matching-source staging checkout. The CI runner's
checkout is not automatically copied to Replit; local preparation can recreate
it from the same explicit producer, and the original ZIP/checksums remain the
handoff identity. Do not paste the package over an active development checkout.
No supported Replit publishing API is assumed or invented here.

Native Publish still owns the reviewed schema diff and any destructive/rename
confirmation. Production boot retains its guardrail migrations and readiness
gate. Afterwards, run existing `ops:postdeploy` under separately authorized
target credentials outside this CI workflow. Governed deployments must separately
meet all existing HOLD, backup, security-catalog, recovery, and RUN admission gates.

## Parent Integration Notes

- Optional root/package alias: `ops:release-candidate` can invoke
  `node scripts/src/ops/release-candidate.mjs`; a scripts-workspace alias uses
  `node src/ops/release-candidate.mjs`. Do not replace `ops:release` or promotion.
  The parent's root `release:prepare` alias already invokes this CLI.
- Run `node --test scripts/src/ops/release-candidate*.test.mjs`. Existing CI and
  `test:reliability` already glob `ops/*.test.mjs`, so no duplicate CI test step
  is necessary there. Python must be available, or set
  `RELEASE_CANDIDATE_PYTHON` to its executable. Fixtures contain synthetic source,
  ZIPs, API responses, and disposable Git repositories only, with no database.
- Link this page from the operations/development documentation index. The current
  documentation gate also requires three entries in `docs/environment.md`:
  `GITHUB_TOKEN` (read-only CI/repository access, never forwarded to storage or
  child processes), `GITHUB_STEP_SUMMARY` (GitHub-provided summary output file),
  and `RELEASE_CANDIDATE_PYTHON` (test-only Python executable selection).
  Those entries and existing-file wiring are parent-owned, outside this sidecar.
- Producer hardening the parent may add to `ci.yml`: retain the upload step's
  artifact ID/digest as explicit outputs; include `github.run_attempt` in future
  artifact naming if desired, updating the consumer contract and tests together.
  Do not remove current manifest/sidecar/hidden seven-app bytes. Existing artifact
  naming and schema workflow are unchanged by this sidecar.
- Configure branch protection/CODEOWNERS and the named environment through the
  normal admin process. Test the authenticated dry-run and approval flow in the
  actual repository after merge. Unit tests cannot prove hosted permissions or
  environment protection settings. Do not substitute production credentials.

## Action Pin Verification

The preparation workflow's four unique action pins were checked against their
official release/commit pages, not inferred from version names:

- `actions/checkout` v4.2.2: [11bd71901bbe5b1630ceea73d27597364c9af683](https://github.com/actions/checkout/commit/11bd71901bbe5b1630ceea73d27597364c9af683).
- `actions/setup-node` v4.4.0: [49933ea5288caeca8642d1e84afbd3f7d6820020](https://github.com/actions/setup-node/commit/49933ea5288caeca8642d1e84afbd3f7d6820020).
- `actions/upload-artifact` v4.6.2: [ea165f8d65b6e75b540449e92b4886f43607fa02](https://github.com/actions/upload-artifact/commit/ea165f8d65b6e75b540449e92b4886f43607fa02).
- `actions/download-artifact` v4.3.0: [d3f86a106a0bac45b974a628896c90dbdf5c8093](https://github.com/actions/download-artifact/commit/d3f86a106a0bac45b974a628896c90dbdf5c8093).

The workflow regression requires these exact pins as well as immutable SHA
syntax. Updates require reviewing the new official release and updating that
test deliberately. No Actions run, deployment, or environment configuration was
changed to perform these read-only checks.
