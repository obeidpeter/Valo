import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  APPS,
  assetInventory,
  digest,
  sourceIdentity,
} from "./build-manifest.mjs";
import { mobileBuildConfig } from "./mobile-artifact.mjs";
import {
  main,
  qualifyCandidate,
  recordCandidate,
  requireCandidateAdmission,
} from "./ci-release-artifact.mjs";

function fixture(t) {
  const parent = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(parent, "ci-candidate-test-"));
  t.after(() => {
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith("ci-candidate-test-"));
    rmSync(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, "source");
  const target = path.join(directory, "download");
  function write(file, value, base = root) {
    const name = path.join(base, file);
    mkdirSync(path.dirname(name), { recursive: true });
    writeFileSync(name, value);
  }
  const eas = {
    build: { production: { env: { EXPO_PUBLIC_DOMAIN: "fixture.invalid" } } },
  };
  write(".gitignore", "dist/\nrelease/\n");
  write("source.txt", "reviewed source\n");
  write("lib/db/src/schema/fixture.ts", "// schema\n");
  write("artifacts/mobile/eas.json", JSON.stringify(eas));
  const git = (...args) => {
    const result = spawnSync(
      "git",
      ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result.stdout.trim();
  };
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  for (const [app] of APPS)
    write(`artifacts/${app}/dist/public/index.html`, `<main>${app}</main>`);
  write("artifacts/landing/dist/public/.hidden", "hidden bytes");
  write(
    "artifacts/api-server/dist/index.mjs",
    "throw new Error('CANDIDATE API MUST NOT EXECUTE');\n",
  );
  write("artifacts/api-server/dist/index.mjs.map", "map bytes");
  write(
    "artifacts/mobile/dist/deployment.json",
    JSON.stringify(mobileBuildConfig(root)),
  );
  write("artifacts/mobile/dist/eas.json", JSON.stringify(eas));
  write("artifacts/mobile/dist/app.json", "{}");
  write(
    "artifacts/mobile/dist/server/serve.cjs",
    "throw new Error('CANDIDATE MOBILE MUST NOT EXECUTE');\n",
  );
  write(
    "artifacts/mobile/dist/server/templates/landing-page.html",
    "<main>mobile</main>",
  );
  for (const platform of ["ios", "android"]) {
    write(
      `artifacts/mobile/dist/static-build/${platform}/bundle.js`,
      "native bytes",
    );
    write(
      `artifacts/mobile/dist/static-build/${platform}/manifest.json`,
      JSON.stringify({
        launchAsset: {
          url: `https://fixture.invalid/mobile/${platform}/bundle.js`,
        },
        assets: [],
      }),
    );
  }
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_JOB: "e2e",
    GITHUB_SHA: git("rev-parse", "HEAD"),
    GITHUB_REPOSITORY: "fixture/repository",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
  };
  const manifest = {
    format: 1,
    source: sourceIdentity(root),
    contractVersion: "fixture",
    ci: {
      repository: env.GITHUB_REPOSITORY,
      runId: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
    },
    assets: assetInventory(root),
    mobile: mobileBuildConfig(root),
    database: {},
  };
  const manifestBytes = JSON.stringify(manifest);
  write("release/build-manifest.json", manifestBytes);
  write(
    "release/build-manifest.json.sha256",
    `${digest(manifestBytes)}  build-manifest.json\n`,
  );
  const recorded = recordCandidate(env, root);
  for (const relative of [
    "release",
    ...[...APPS.map(([app]) => app), "api-server", "mobile"].map(
      (app) => `artifacts/${app}/dist`,
    ),
  ]) {
    mkdirSync(path.dirname(path.join(target, relative)), { recursive: true });
    cpSync(path.join(root, relative), path.join(target, relative), {
      recursive: true,
    });
  }
  const admitted = {
    ...env,
    GITHUB_JOB: "release-artifact",
    QUALITY_RESULT: "success",
    E2E_RESULT: "success",
    CI_CANDIDATE_ID: "45",
    CI_CANDIDATE_DIR: target,
    CI_CANDIDATE_SHA256: recorded.candidateSha256,
    RELEASE_MANIFEST_SHA256: recorded.manifestSha256,
  };
  return { root, target, write, env, admitted, manifest, recorded };
}

test("qualifies all seven byte-identical packages without rebuilding, restamping or executing them", (t) => {
  const f = fixture(t);
  const before = readFileSync(
    path.join(f.target, "release/build-manifest.json"),
  );
  assert.deepEqual(qualifyCandidate(f.admitted, f.root), f.manifest);
  assert.deepEqual(recordCandidate(f.env, f.root), f.recorded);
  assert.deepEqual(
    readFileSync(path.join(f.target, "release/build-manifest.json")),
    before,
  );
});

test("both gates, exact identity and the dedicated job are required before reading any candidate", (t) => {
  const f = fixture(t);
  for (const key of ["QUALITY_RESULT", "E2E_RESULT"]) {
    for (const result of [
      undefined,
      "failure",
      "cancelled",
      "skipped",
      "in_progress",
    ])
      assert.throws(
        () =>
          qualifyCandidate(
            { ...f.admitted, [key]: result, CI_CANDIDATE_DIR: "missing" },
            f.root,
          ),
        /must succeed/,
      );
  }
  for (const patch of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_JOB: "e2e" },
    { GITHUB_SHA: "short" },
    { GITHUB_REPOSITORY: "" },
    { GITHUB_RUN_ID: "0" },
    { GITHUB_RUN_ATTEMPT: "" },
    { CI_CANDIDATE_ID: "latest" },
    { CI_CANDIDATE_SHA256: "" },
    { RELEASE_MANIFEST_SHA256: "" },
  ])
    assert.throws(() => requireCandidateAdmission({ ...f.admitted, ...patch }));
  assert.throws(() => recordCandidate(f.admitted, f.root), /only the E2E/);
  assert.throws(
    () => main(["verify", "--ignore-failure"], f.admitted),
    /use ci-release-artifact/,
  );
});

test("stale run, attempt, repository, revision, source and schema refuse", (t) => {
  const f = fixture(t);
  for (const patch of [
    { GITHUB_RUN_ID: "124" },
    { GITHUB_RUN_ATTEMPT: "3" },
    { GITHUB_REPOSITORY: "fixture/other" },
    { GITHUB_SHA: "f".repeat(40) },
  ])
    assert.throws(
      () => qualifyCandidate({ ...f.admitted, ...patch }, f.root),
      /differs|different/,
    );
  f.write("source.txt", "unreviewed source\n");
  assert.throws(
    () => qualifyCandidate(f.admitted, f.root),
    /source\/schema differs/,
  );
  f.write("source.txt", "reviewed source\n");
  f.write("lib/db/src/schema/fixture.ts", "// changed schema\n");
  assert.throws(
    () => qualifyCandidate(f.admitted, f.root),
    /source\/schema differs/,
  );
});

test("package, hidden, map, manifest, sidecar and omitted bytes cannot be substituted", (t) => {
  const f = fixture(t);
  const files = [
    ...APPS.map(([app]) => `artifacts/${app}/dist/public/index.html`),
    "artifacts/api-server/dist/index.mjs",
    "artifacts/mobile/dist/server/serve.cjs",
    "artifacts/landing/dist/public/.hidden",
    "artifacts/api-server/dist/index.mjs.map",
    "release/build-manifest.json",
    "release/build-manifest.json.sha256",
  ];
  for (const file of files) {
    const original = readFileSync(path.join(f.target, file));
    f.write(file, "altered", f.target);
    assert.throws(
      () => qualifyCandidate(f.admitted, f.root),
      /transfer checksum mismatch/,
    );
    rmSync(path.join(f.target, file));
    assert.throws(
      () => qualifyCandidate(f.admitted, f.root),
      /transfer checksum mismatch/,
    );
    f.write(file, original, f.target);
  }
  assert.throws(
    () =>
      qualifyCandidate(
        { ...f.admitted, RELEASE_MANIFEST_SHA256: "f".repeat(64) },
        f.root,
      ),
    /manifest checksum mismatch/,
  );
  f.write("unexpected.txt", "extra", f.target);
  assert.throws(
    () => qualifyCandidate(f.admitted, f.root),
    /unexpected candidate file/,
  );
});

test("recording rejects rebuilt outputs and corrupted sidecars before upload", (t) => {
  const f = fixture(t);
  f.write("release/build-manifest.json.sha256", "replacement checksum");
  assert.throws(() => recordCandidate(f.env, f.root), /sidecar mismatch/);
  f.write(
    "release/build-manifest.json.sha256",
    `${f.recorded.manifestSha256}  build-manifest.json\n`,
  );
  f.write("artifacts/api-server/dist/index.mjs", "rebuilt API");
  assert.throws(() => recordCandidate(f.env, f.root), /packages differ/);
});

test("candidate must stay outside source and contain no symlink directories", (t) => {
  const f = fixture(t);
  for (const directory of [
    f.root,
    path.join(f.root, "download"),
    path.dirname(f.root),
  ])
    assert.throws(
      () =>
        qualifyCandidate(
          { ...f.admitted, CI_CANDIDATE_DIR: directory },
          f.root,
        ),
      /isolated from source/,
    );
  const link = path.join(f.target, "artifacts/api-server/dist/linked");
  symlinkSync(f.root, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => qualifyCandidate(f.admitted, f.root), /symlink refused/);
});
