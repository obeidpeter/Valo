import assert from "node:assert/strict";
import { appendFileSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPS,
  ROOT,
  assetInventory,
  digest,
  loadManifest,
  sourceIdentity,
} from "./build-manifest.mjs";
import {
  mobileBuildConfig,
  validateMobileArtifact,
} from "./mobile-artifact.mjs";

const MANIFEST = "release/build-manifest.json";
const SIDECAR = `${MANIFEST}.sha256`;
const DIST_ROOTS = [
  ...APPS.map(([app]) => `artifacts/${app}/dist`),
  "artifacts/api-server/dist",
  "artifacts/mobile/dist",
];

function ciIdentity(env) {
  assert.equal(
    env.GITHUB_ACTIONS,
    "true",
    "candidate qualification is CI-only",
  );
  assert.match(
    env.GITHUB_SHA ?? "",
    /^[a-f0-9]{40}$/,
    "full CI revision required",
  );
  assert.match(
    env.GITHUB_REPOSITORY ?? "",
    /^[\w.-]+\/[\w.-]+$/,
    "CI repository required",
  );
  for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"])
    assert.match(
      env[key] ?? "",
      /^[1-9][0-9]*$/,
      `${key} required; rerun all jobs in the selected attempt`,
    );
  return {
    repository: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
  };
}

function regularFiles(root, relative = "") {
  const absolute = path.join(root, relative);
  const stat = lstatSync(absolute);
  assert.ok(!stat.isSymbolicLink(), `candidate symlink refused: ${relative}`);
  if (stat.isFile()) return [relative];
  assert.ok(
    stat.isDirectory(),
    `candidate must contain only regular files: ${relative}`,
  );
  return readdirSync(absolute).flatMap((name) =>
    regularFiles(root, relative ? `${relative}/${name}` : name),
  );
}

function candidateDigest(root, transferred) {
  const files = transferred
    ? regularFiles(root)
    : [MANIFEST, SIDECAR, ...DIST_ROOTS].flatMap((file) =>
        regularFiles(root, file),
      );
  for (const file of files) {
    assert.ok(
      file === MANIFEST ||
        file === SIDECAR ||
        DIST_ROOTS.some((directory) => file.startsWith(`${directory}/`)),
      `unexpected candidate file: ${file}`,
    );
  }
  // Unlike the runtime inventory, the transfer binding includes source maps
  // and every hidden/auxiliary file too. No downloaded byte escapes the check.
  return digest(
    JSON.stringify(
      files
        .sort()
        .map((file) => [file, digest(readFileSync(path.join(root, file)))]),
    ),
  );
}

function verifyManifest(root, artifactRoot, expectedHash, env) {
  const ci = ciIdentity(env);
  const manifest = loadManifest(
    path.join(artifactRoot, MANIFEST),
    expectedHash,
  );
  assert.deepEqual(
    manifest.ci,
    ci,
    "candidate CI run/attempt differs; rerun all jobs, not only the failed job",
  );
  assert.equal(
    manifest.source.revision,
    env.GITHUB_SHA,
    "candidate is from a different revision",
  );
  assert.deepEqual(
    manifest.source,
    sourceIdentity(root),
    "candidate source/schema differs from checkout",
  );
  assert.equal(
    readFileSync(path.join(artifactRoot, SIDECAR), "utf8"),
    `${expectedHash}  build-manifest.json\n`,
    "candidate manifest sidecar mismatch",
  );
  assert.deepEqual(
    assetInventory(artifactRoot),
    manifest.assets,
    "candidate packages differ from tested inventory",
  );
  assert.deepEqual(
    validateMobileArtifact(artifactRoot),
    manifest.mobile,
    "candidate mobile bytes/config differ",
  );
  assert.deepEqual(
    mobileBuildConfig(root),
    manifest.mobile,
    "candidate mobile target differs from reviewed source",
  );
  return manifest;
}

export function recordCandidate(env = process.env, root = ROOT) {
  assert.equal(
    env.GITHUB_JOB,
    "e2e",
    "only the E2E job may record tested candidate bytes",
  );
  const manifestHash = digest(readFileSync(path.join(root, MANIFEST)));
  verifyManifest(root, root, manifestHash, env);
  return {
    manifestSha256: manifestHash,
    candidateSha256: candidateDigest(root, false),
  };
}

export function requireCandidateAdmission(env = process.env) {
  ciIdentity(env);
  assert.equal(
    env.GITHUB_JOB,
    "release-artifact",
    "only the final release-artifact job may qualify a candidate",
  );
  assert.equal(
    env.QUALITY_RESULT,
    "success",
    "quality-gate must succeed before qualification",
  );
  assert.equal(
    env.E2E_RESULT,
    "success",
    "e2e must succeed before qualification",
  );
  assert.match(
    env.CI_CANDIDATE_ID ?? "",
    /^[1-9][0-9]*$/,
    "exact candidate artifact ID required",
  );
  for (const key of ["CI_CANDIDATE_SHA256", "RELEASE_MANIFEST_SHA256"])
    assert.match(
      env[key] ?? "",
      /^[a-f0-9]{64}$/,
      `independently supplied ${key} required`,
    );
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

export function qualifyCandidate(env = process.env, root = ROOT) {
  requireCandidateAdmission(env);
  assert.ok(env.CI_CANDIDATE_DIR, "isolated candidate directory required");
  const directory = path.resolve(env.CI_CANDIDATE_DIR);
  assert.ok(
    !within(root, directory) && !within(directory, root),
    "downloaded candidate must be isolated from source checkout",
  );
  assert.equal(
    candidateDigest(directory, true),
    env.CI_CANDIDATE_SHA256,
    "candidate transfer checksum mismatch",
  );
  return verifyManifest(root, directory, env.RELEASE_MANIFEST_SHA256, env);
}

export function main(args = process.argv.slice(2), env = process.env) {
  assert.ok(
    args.length === 1 && ["record", "admission", "verify"].includes(args[0]),
    "use ci-release-artifact record|admission|verify",
  );
  if (args[0] === "admission") return requireCandidateAdmission(env);
  if (args[0] === "verify") {
    const manifest = qualifyCandidate(env);
    console.log(
      `CI candidate: all seven tested packages and source verified for ${manifest.source.revision}; no rebuild or restamp`,
    );
    return;
  }
  const recorded = recordCandidate(env);
  assert.ok(env.GITHUB_OUTPUT, "runner-owned step output required");
  appendFileSync(
    env.GITHUB_OUTPUT,
    `manifest_sha256=${recorded.manifestSha256}\ncandidate_sha256=${recorded.candidateSha256}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(`CI candidate: FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
