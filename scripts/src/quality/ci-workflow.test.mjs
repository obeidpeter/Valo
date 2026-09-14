import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  ),
);
const jobs = workflow.jobs;
function step(job, name) {
  const matches = jobs[job].steps.filter((item) => item.name === name);
  assert.equal(matches.length, 1, `${job}: expected one ${name}`);
  return matches[0];
}

test("independent CI gates keep separate disposable databases and read-only workflow permissions", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const name of ["quality-gate", "e2e"]) {
    assert.equal(jobs[name].needs, undefined);
    assert.equal(jobs[name].if, undefined);
    assert.equal(jobs[name]["continue-on-error"], undefined);
    assert.equal(jobs[name].env.E2E_DATABASE_DISPOSABLE, "1");
    assert.equal(jobs[name].services.postgres.image, "pgvector/pgvector:pg16");
    assert.equal(
      step(name, "Install dependencies").run,
      "pnpm install --frozen-lockfile",
    );
  }
  assert.notEqual(
    jobs["quality-gate"].env.DATABASE_URL,
    jobs.e2e.env.DATABASE_URL,
  );
  assert.deepEqual(jobs["release-artifact"].needs, ["quality-gate", "e2e"]);
  assert.equal(jobs["release-artifact"].if, undefined);
  assert.equal(jobs["release-artifact"]["continue-on-error"], undefined);
});

test("all quality, security, rollback, recovery and browser gates remain mandatory", () => {
  const required = {
    "quality-gate": [
      "Architecture boundaries",
      "Quality, release, worker, load-tool and journey regression tests",
      "Client transport and database deadline configuration tests",
      "Tracked secret scan",
      "Documentation inventory",
      "Brand copy gate",
      "Complexity ratchet",
      "Formatting",
      "Dependency audit (prod, high+)",
      "Codegen drift check",
      "Typecheck (all packages)",
      "Lint",
      "Prepare database (schema + guardrail migrations)",
      "api-server unit tests with coverage floors",
      "mobile unit tests",
      "SME app unit tests with coverage floors",
      "Console app unit tests with coverage floors",
      "Buyer portal unit tests",
      "Landing unit tests",
      "Penalty calculator unit tests",
      "Shared lib unit tests",
      "web-ui unit tests with coverage floors",
      "Migration rollback test (real Postgres)",
      "Migration-only upgrade matches the release catalog",
      "Verify backup snapshot consistency and retained restore",
      "Provision isolated backup runtime role",
      "Retain snapshot-consistent backup",
      "Restore retained backup and verify full semantic catalog",
    ],
    e2e: [
      "Verify Valo vector and raster branding",
      "Build api-server",
      "Verify built API PDF worker and native rasterization",
      "Build immutable mobile native export and serving package",
      "Verify packaged mobile manifests and native asset bytes",
      "Axe engine and keyboard assertion regression",
      "Build frontends",
      "Verify landing and login accessibility across public states",
      "Verify signed-in workspace visuals and keyboard focus",
      "Verify shared Clerk and integration settings dialogs",
      "Verify guided onboarding and operational workspace usability",
      "Verify calculator startup, loading and recovery accessibility",
      "Verify customer picker keyboard and failure recovery",
      "Verify activity, Clerk, WHT, filing, branding and header accessibility",
      "Verify all Control Centre workspaces in both themes",
      "Push schema",
      "Render recovery states and verify accessibility",
      "Enforce lazy route and entry bundle budgets",
      "Keep CI bundle metadata out of published packages",
      "Run E2E journeys",
      "Stamp tested immutable build manifest",
      "Record tested candidate identity",
      "Preserve tested candidate",
    ],
  };
  for (const [job, names] of Object.entries(required)) {
    for (const name of names) {
      const gate = step(job, name);
      assert.equal(gate.if, undefined, name);
      assert.equal(gate["continue-on-error"], undefined, name);
    }
  }
  assert.match(
    step(
      "quality-gate",
      "Quality, release, worker, load-tool and journey regression tests",
    ).run,
    /scripts\/src\/quality\/\*\.test\.mjs scripts\/src\/ops\/\*\.test\.mjs/,
  );
  const fallback = step(
    "quality-gate",
    "Dependency audit fallback (OSV full lockfile)",
  );
  assert.equal(
    fallback.if,
    "steps.npm-audit.outputs.transport_failure == 'true'",
  );
  assert.equal(fallback["continue-on-error"], undefined);
});

test("production frontends build once and budget inspection never substitutes a second build", () => {
  const builds = step("e2e", "Build frontends").run.trim().split("\n");
  assert.deepEqual(builds, [
    "BASE_PATH=/ PORT=3000 pnpm --filter @workspace/landing run build --manifest",
    "BASE_PATH=/console/ PORT=3000 pnpm --filter @workspace/console run build --manifest",
    "BASE_PATH=/app/ PORT=3000 pnpm --filter @workspace/sme-compliance run build --manifest",
    "BASE_PATH=/buyer/ PORT=3000 pnpm --filter @workspace/buyer-portal run build --manifest",
    "BASE_PATH=/penalty-calculator/ PORT=3000 pnpm --filter @workspace/penalty-calculator run build --manifest",
  ]);
  assert.equal(
    jobs["quality-gate"].steps.some((item) => item.name?.startsWith("Build ")),
    false,
  );
  assert.equal(
    step("e2e", "Enforce lazy route and entry bundle budgets").run,
    "node scripts/src/e2e/state-catalogue/route-budget.mjs --use-built",
  );
  const names = jobs.e2e.steps.map((item) => item.name);
  const sequence = [
    "Build frontends",
    "Enforce lazy route and entry bundle budgets",
    "Keep CI bundle metadata out of published packages",
    "Run E2E journeys",
    "Stamp tested immutable build manifest",
    "Record tested candidate identity",
    "Preserve tested candidate",
  ].map((name) => names.indexOf(name));
  assert.deepEqual(
    sequence,
    [...sequence].sort((a, b) => a - b),
  );
  assert.match(
    step("e2e", "Keep CI bundle metadata out of published packages").run,
    /mv "artifacts\/\$app\/dist\/public\/\.vite\/manifest.json" "tmp\/route-budget-r198\/\$app\/\.vite\/manifest.json"/,
  );
});

test("release qualification uses only exact same-run outputs and an isolated download", () => {
  assert.deepEqual(jobs.e2e.outputs, {
    "candidate-id": "${{ steps.tested-candidate.outputs.artifact-id }}",
    "candidate-sha256":
      "${{ steps.candidate-identity.outputs.candidate_sha256 }}",
    "manifest-sha256":
      "${{ steps.candidate-identity.outputs.manifest_sha256 }}",
  });
  const candidate = step("e2e", "Preserve tested candidate");
  assert.equal(
    candidate.with.name,
    "meridian-tested-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  assert.equal(candidate.with["include-hidden-files"], true);
  assert.equal(candidate.with["if-no-files-found"], "error");
  assert.equal(candidate.id, "tested-candidate");
  assert.equal(
    step("e2e", "Record tested candidate identity").id,
    "candidate-identity",
  );
  assert.equal(
    jobs.e2e.steps.some((item) =>
      item.with?.name?.startsWith("meridian-release-"),
    ),
    false,
  );
  const final = jobs["release-artifact"];
  assert.equal(final.env, undefined);
  assert.equal(final.services, undefined);
  const [checkout, node, admission, download, verify, upload] = final.steps;
  assert.equal(final.steps.length, 6);
  assert.equal(checkout.uses, "actions/checkout@v4");
  assert.equal(node.uses, "actions/setup-node@v4");
  assert.equal(
    admission.run,
    "node scripts/src/ops/ci-release-artifact.mjs admission",
  );
  assert.equal(download.uses, "actions/download-artifact@v4");
  assert.deepEqual(download.with, {
    "artifact-ids": "${{ needs.e2e.outputs.candidate-id }}",
    "merge-multiple": true,
    path: "${{ runner.temp }}/tested-candidate",
  });
  assert.equal(verify.name, "Verify tested immutable build manifest");
  assert.equal(
    verify.run,
    "node scripts/src/ops/ci-release-artifact.mjs verify",
  );
  const admissionEnv = {
    QUALITY_RESULT: "${{ needs.quality-gate.result }}",
    E2E_RESULT: "${{ needs.e2e.result }}",
    CI_CANDIDATE_ID: "${{ needs.e2e.outputs.candidate-id }}",
    CI_CANDIDATE_SHA256: "${{ needs.e2e.outputs.candidate-sha256 }}",
    RELEASE_MANIFEST_SHA256: "${{ needs.e2e.outputs.manifest-sha256 }}",
  };
  assert.deepEqual(admission.env, admissionEnv);
  assert.deepEqual(verify.env, {
    ...admissionEnv,
    CI_CANDIDATE_DIR: download.with.path,
  });
  assert.equal(upload.name, "Preserve tested release artifact");
  assert.equal(upload.uses, "actions/upload-artifact@v4");
  assert.equal(upload.with.name, "meridian-release-${{ github.sha }}");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with["include-hidden-files"], true);
  assert.deepEqual(upload.with.path.trim().split("\n"), [
    "${{ runner.temp }}/tested-candidate/release/build-manifest.json*",
    "${{ runner.temp }}/tested-candidate/artifacts/*/dist/**",
  ]);
  for (const item of final.steps) {
    assert.equal(item.if, undefined);
    assert.equal(item["continue-on-error"], undefined);
  }
});
