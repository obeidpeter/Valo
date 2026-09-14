import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  lstatSync,
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
  ROOT,
  assetInventory,
  digest,
  sourceIdentity,
} from "./build-manifest.mjs";
import {
  checkPublishingChecksumConfiguration,
  inspectArchive,
  checklist,
  prepareCandidate,
  processEnvironment,
  publishingConfigurationMetadataReader,
  realPath,
  reserveOutput,
  safeRelative,
  stageSource,
  verifyEvidence,
  verifyManifestBinding,
} from "./release-candidate.mjs";
import {
  validateApproval,
  approveHandoff,
  validatePublishingChecksumProvenance,
} from "./release-candidate-handoff.mjs";
import {
  ENVIRONMENT,
  provenanceSnapshot,
  validateProducer,
  validateProtection,
  githubClient,
  selection,
} from "./release-candidate-github.mjs";

const PYTHON =
  process.env.RELEASE_CANDIDATE_PYTHON ??
  (process.platform === "win32" ? "python" : "python3");
const selectionBase = {
  repository: "fixture/repository",
  runId: "123",
  attempt: "2",
  revision: "a".repeat(40),
};

function producer(chosen = selectionBase) {
  const run = {
    id: Number(chosen.runId),
    run_attempt: Number(chosen.attempt),
    workflow_id: 10,
    path: ".github/workflows/ci.yml",
    repository: { id: 20 },
    head_repository: { id: 20 },
    head_branch: "main",
    head_sha: chosen.revision,
    status: "completed",
    conclusion: "success",
    event: "push",
    run_started_at: "2026-09-01T10:00:00Z",
  };
  const jobs = ["quality-gate", "e2e"].map((name, index) => ({
    name,
    id: 30 + index,
    run_id: run.id,
    run_attempt: run.run_attempt,
    head_sha: chosen.revision,
    status: "completed",
    conclusion: "success",
    started_at: "2026-09-01T10:00:00Z",
    completed_at: "2026-09-01T11:00:00Z",
    steps: [
      "Stamp tested immutable build manifest",
      "Preserve tested release artifact",
    ].map((step, number) => ({
      name: step,
      number: number + 1,
      status: "completed",
      conclusion: "success",
      started_at:
        number === 0 ? "2026-09-01T10:57:00Z" : "2026-09-01T10:58:00Z",
      completed_at:
        number === 0 ? "2026-09-01T10:57:30Z" : "2026-09-01T10:59:30Z",
    })),
  }));
  return {
    repository: { id: 20, full_name: chosen.repository },
    workflow: { id: 10, path: ".github/workflows/ci.yml" },
    run,
    attempt: structuredClone(run),
    jobsEndpoint: `/repos/${chosen.repository}/actions/runs/${chosen.runId}/attempts/${chosen.attempt}/jobs`,
    jobs,
    artifacts: [
      {
        id: 40,
        name: `meridian-release-${chosen.revision}`,
        expired: false,
        digest: `sha256:${"b".repeat(64)}`,
        size_in_bytes: 123,
        workflow_run: {
          id: run.id,
          repository_id: 20,
          head_repository_id: 20,
          head_branch: "main",
          head_sha: chosen.revision,
        },
        created_at: "2026-09-01T10:59:00Z",
        updated_at: "2026-09-01T10:59:00Z",
      },
    ],
  };
}

function temporary(t) {
  const parent = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(parent, "release-candidate-test-"));
  t.after(() => {
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith("release-candidate-test-"));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function execute(binary, args, cwd, input) {
  const result = spawnSync(binary, args, {
    cwd,
    env: processEnvironment(),
    encoding: "utf8",
    input,
    windowsHide: true,
    maxBuffer: 16 * 1024 ** 2,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.trim();
}

function fixture(t, longSourceFile) {
  const directory = temporary(t);
  const source = path.join(directory, "development");
  mkdirSync(source);
  const write = (file, bytes) => {
    const target = path.join(source, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  };
  const git = (...args) =>
    execute("git", ["-c", "core.autocrlf=false", ...args], source);
  write(".gitignore", "dist/\n");
  write("source.txt", "reviewed source\n");
  if (longSourceFile) write(longSourceFile, "tracked long-path source\n");
  write("lib/db/src/schema/fixture.ts", "// schema fixture\n");
  write("artifacts/mobile/app/[id].tsx", "// bracket path fixture\n");
  const mobile = {
    format: 1,
    domain: "fixture.invalid",
    basePath: "/mobile/",
    replId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
  const eas = {
    build: {
      production: {
        env: {
          EXPO_PUBLIC_DOMAIN: mobile.domain,
          EXPO_PUBLIC_REPL_ID: mobile.replId,
        },
      },
    },
  };
  write("artifacts/mobile/eas.json", JSON.stringify(eas));
  git("init", "--quiet");
  git("add", ".");
  // Fixture commits are confined to this test's disposable repository.
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  for (const [app] of APPS)
    write(`artifacts/${app}/dist/public/index.html`, `<main>${app}</main>`);
  write("artifacts/landing/dist/public/.vite/manifest.json", "{}");
  write(
    "artifacts/api-server/dist/index.mjs",
    "throw new Error('API MUST NEVER EXECUTE');\n",
  );
  write("artifacts/mobile/dist/deployment.json", JSON.stringify(mobile));
  write("artifacts/mobile/dist/eas.json", JSON.stringify(eas));
  write("artifacts/mobile/dist/app.json", "{}");
  write(
    "artifacts/mobile/dist/server/serve.cjs",
    "throw new Error('MOBILE MUST NEVER EXECUTE');\n",
  );
  write(
    "artifacts/mobile/dist/server/templates/landing-page.html",
    "<main>mobile</main>",
  );
  for (const platform of ["ios", "android"]) {
    write(
      `artifacts/mobile/dist/static-build/${platform}/bundle.js`,
      "fixture",
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
  const chosen = { ...selectionBase, revision: git("rev-parse", "HEAD") };
  const manifest = {
    format: 1,
    source: sourceIdentity(source),
    contractVersion: "fixture",
    ci: {
      repository: chosen.repository,
      runId: chosen.runId,
      attempt: chosen.attempt,
    },
    assets: assetInventory(source),
    mobile,
    database: {},
  };
  const records = manifest.assets.map(({ file }) => ({
    name: file,
    data: readFileSync(path.join(source, file)).toString("base64"),
  }));
  const manifestRecord = () => {
    const bytes = Buffer.from(JSON.stringify(manifest));
    return [
      { name: "release/build-manifest.json", data: bytes.toString("base64") },
      {
        name: "release/build-manifest.json.sha256",
        data: Buffer.from(`${digest(bytes)}  build-manifest.json\n`).toString(
          "base64",
        ),
      },
    ];
  };
  let sequence = 0;
  const zip = (entries = [...records, ...manifestRecord()]) => {
    const archive = path.join(directory, `fixture-${sequence++}.zip`);
    execute(
      PYTHON,
      [
        "-I",
        "-c",
        `import base64,json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED) as archive:\n for item in json.load(sys.stdin):\n  info=zipfile.ZipInfo(item['name'])\n  info.create_system=3\n  info.external_attr=item.get('mode',0o100644)<<16\n  archive.writestr(info,base64.b64decode(item.get('data','')),compress_type=zipfile.ZIP_DEFLATED)`,
        archive,
      ],
      directory,
      JSON.stringify(entries),
    );
    return archive;
  };
  const archive = zip();
  const evidence = producer(chosen);
  evidence.artifacts[0].size_in_bytes = lstatSync(archive).size;
  evidence.artifacts[0].digest = `sha256:${digest(readFileSync(archive))}`;
  const client = {
    producer: async () => structuredClone(evidence),
    download: async (repository, artifact, destination) =>
      copyFileSync(archive, destination),
  };
  return {
    directory,
    source,
    write,
    git,
    chosen,
    manifest,
    records,
    manifestRecord,
    zip,
    archive,
    evidence,
    client,
    options: {
      ...chosen,
      source,
      output: path.join(directory, "candidate"),
      python: PYTHON,
    },
  };
}

test("producer binds repository, workflow, exact main run/attempt, successful jobs and immutable artifact", () => {
  assert.equal(validateProducer(selectionBase, producer()).id, 40);
  const documented = producer();
  documented.run.path += "@main";
  documented.attempt.path += "@main";
  for (const job of documented.jobs) delete job.run_attempt;
  assert.equal(validateProducer(selectionBase, documented).id, 40);
  const mutations = [
    (p) => (p.repository.full_name = "fork/repository"),
    (p) => (p.run.head_repository.id = 99),
    (p) => (p.run.head_branch = "feature"),
    (p) => (p.run.event = "pull_request"),
    (p) => (p.attempt.event = "pull_request_target"),
    (p) => (p.run.head_sha = "f".repeat(40)),
    (p) => p.run.run_attempt++,
    (p) => p.attempt.run_attempt--,
    (p) => (p.run.path = ".github/workflows/other.yml"),
    (p) => (p.run.path += "@feature"),
    (p) => p.run.workflow_id++,
    (p) => (p.workflow.path = ".github/workflows/other.yml"),
    (p) => (p.run.status = "in_progress"),
    (p) => (p.run.conclusion = "failure"),
    (p) => (p.attempt.conclusion = "cancelled"),
    (p) => p.jobs.pop(),
    (p) => p.jobs.push(p.jobs[0]),
    (p) => p.jobs[1].run_attempt--,
    (p) =>
      (p.jobsEndpoint = p.jobsEndpoint.replace("attempts/2", "attempts/1")),
    (p) => (p.jobs[0].started_at = "2026-08-31T10:00:00Z"),
    (p) => (p.jobs[1].steps[0].number = 3),
    (p) => (p.jobs[1].steps[1].completed_at = "2026-09-01T10:58:30Z"),
    (p) => p.jobs[1].steps.pop(),
    (p) => (p.jobs[1].steps[1].conclusion = "skipped"),
    (p) => p.artifacts.push({ ...p.artifacts[0], id: 41 }),
    (p) => (p.artifacts = []),
    (p) => (p.artifacts[0].expired = true),
    (p) => delete p.artifacts[0].digest,
    (p) => (p.artifacts[0].workflow_run.head_sha = "f".repeat(40)),
    (p) => (p.artifacts[0].created_at = "2026-08-31T10:59:00Z"),
    (p) => (p.artifacts[0].updated_at = "2026-09-02T10:59:00Z"),
  ];
  for (const mutate of mutations) {
    const p = producer();
    mutate(p);
    assert.throws(() => validateProducer(selectionBase, p));
  }
  for (const values of [
    { runId: "latest" },
    { attempt: "0" },
    { revision: "abcd" },
    { repository: "x/../y" },
  ])
    assert.throws(() => selection({ ...selectionBase, ...values }));
});

function parallelProducer() {
  const p = producer();
  const e2e = p.jobs[1];
  e2e.steps = [
    { ...e2e.steps[0] },
    {
      ...e2e.steps[1],
      name: "Record tested candidate identity",
      completed_at: "2026-09-01T10:58:15Z",
    },
    {
      ...e2e.steps[1],
      name: "Preserve tested candidate",
      number: 3,
      started_at: "2026-09-01T10:58:30Z",
    },
  ];
  p.jobs.push({
    ...e2e,
    id: 32,
    name: "release-artifact",
    started_at: "2026-09-01T11:00:00Z",
    completed_at: "2026-09-01T11:03:00Z",
    steps: [
      {
        ...e2e.steps[0],
        name: "Verify tested immutable build manifest",
        started_at: "2026-09-01T11:01:00Z",
        completed_at: "2026-09-01T11:01:30Z",
      },
      {
        ...e2e.steps[1],
        name: "Preserve tested release artifact",
        started_at: "2026-09-01T11:02:00Z",
        completed_at: "2026-09-01T11:02:30Z",
      },
    ],
  });
  p.artifacts[0].created_at = "2026-09-01T11:02:15Z";
  p.artifacts[0].updated_at = p.artifacts[0].created_at;
  return p;
}

test("parallel gates qualify only through the later successful release-artifact job", () => {
  const p = parallelProducer();
  assert.equal(validateProducer(selectionBase, p).id, 40);
  assert.equal(validateProducer(selectionBase, provenanceSnapshot(p)).id, 40);
  for (const mutate of [
    (p) => {
      p.jobs[0].conclusion = "failure";
    },
    (p) => {
      p.jobs[1].conclusion = "cancelled";
    },
    (p) => {
      p.jobs[2].conclusion = "skipped";
    },
    (p) => {
      p.jobs[2].status = "in_progress";
    },
    (p) => {
      p.jobs[2].run_attempt = 1;
    },
    (p) => {
      p.jobs[2].head_sha = "b".repeat(40);
    },
    (p) => {
      p.jobs[2].started_at = "2026-09-01T10:59:59Z";
    },
    (p) => {
      p.jobs[0].completed_at = "2026-09-01T11:01:00Z";
    },
    (p) => {
      p.jobs[1].steps[1].conclusion = "failure";
    },
    (p) => {
      p.jobs[1].steps.pop();
    },
    (p) => {
      p.jobs[1].steps[1].number = 4;
    },
    (p) => {
      p.jobs[2].steps[0].conclusion = "skipped";
    },
    (p) => {
      p.jobs[2].steps[1].number = 1;
    },
    (p) => {
      p.artifacts[0].created_at = "2026-09-01T10:59:00Z";
    },
    (p) => {
      p.artifacts[0].name = `meridian-tested-${selectionBase.revision}-123-2`;
    },
    (p) => {
      p.jobs.pop();
    },
    (p) => {
      p.jobs.push({ ...p.jobs[2], id: 33 });
    },
    (p) => {
      p.jobs[2].name = "unexpected-producer";
    },
  ]) {
    const changed = parallelProducer();
    mutate(changed);
    assert.throws(() => validateProducer(selectionBase, changed));
  }
});

test("API pagination is complete and duplicate/changed counts fail closed", async () => {
  const calls = [];
  const client = githubClient("synthetic", async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, "manual");
    return Response.json({ total_count: 2, artifacts: [{ id: calls.length }] });
  });
  assert.deepEqual(
    await client.list(
      "/repos/fixture/repository/actions/runs/123/artifacts",
      "artifacts",
    ),
    [{ id: 1 }, { id: 2 }],
  );
  assert.match(calls[1], /page=2$/);
  let page = 0;
  const changed = githubClient("synthetic", async () =>
    Response.json({ total_count: ++page + 1, artifacts: [{}] }),
  );
  await assert.rejects(
    changed.list(
      "/repos/fixture/repository/actions/runs/123/artifacts",
      "artifacts",
    ),
    /pagination changed/,
  );
});

test("an artifact redirect outside GitHub storage is refused before any download (R114)", async (t) => {
  const directory = temporary(t);
  const client = githubClient("token", async (url) => {
    if (String(url).startsWith("https://api.github.com"))
      return new Response(null, {
        status: 302,
        headers: { location: "https://fixture.invalid/archive?signed=secret" },
      });
    throw new Error("the redirect must not be fetched");
  });
  await assert.rejects(
    client.download(
      "fixture/repository",
      { id: 41, size_in_bytes: 1, digest: `sha256:${"a".repeat(64)}` },
      path.join(directory, "refused.zip"),
    ),
    /unexpected artifact redirect host/,
  );
  assert.equal(existsSync(path.join(directory, "refused.zip")), false);
});

test("signed archive redirect does not receive credentials and checksum/size failures refuse", async (t) => {
  const directory = temporary(t);
  const bytes = Buffer.from("synthetic zip bytes");
  let count = 0;
  const client = githubClient("must-not-forward", async (url, options) => {
    if (String(url).startsWith("https://api.github.com")) {
      assert.equal(options.headers.Authorization, "Bearer must-not-forward");
      return new Response(null, {
        status: 302,
        headers: {
          location:
            "https://productionresultssa0.blob.core.windows.net/archive?signed=secret",
        },
      });
    }
    count++;
    assert.equal(options.headers, undefined);
    assert.equal(options.redirect, "error");
    return new Response(bytes);
  });
  const artifact = {
    id: 40,
    size_in_bytes: bytes.length,
    digest: `sha256:${digest(bytes)}`,
  };
  await client.download(
    "fixture/repository",
    artifact,
    path.join(directory, "ok.zip"),
  );
  await assert.rejects(
    client.download(
      "fixture/repository",
      { ...artifact, digest: `sha256:${"f".repeat(64)}` },
      path.join(directory, "wrong.zip"),
    ),
    /checksum/,
  );
  await assert.rejects(
    client.download(
      "fixture/repository",
      { ...artifact, size_in_bytes: 1 },
      path.join(directory, "big.zip"),
    ),
    /size/,
  );
  assert.equal(count, 3);
});

test("ZIP verifies hidden assets and permits only transport maps paired to inventoried assets", (t) => {
  const f = fixture(t);
  const report = inspectArchive(f.archive, PYTHON);
  assert.equal(report.manifest.source.revision, f.chosen.revision);
  assert.ok(report.files.some((item) => item.file.includes("/.vite/")));
  const map = {
    name: "artifacts/api-server/dist/index.mjs.map",
    data: Buffer.from("{}").toString("base64"),
  };
  assert.deepEqual(
    inspectArchive(f.zip([...f.records, ...f.manifestRecord(), map]), PYTHON)
      .transportOnlySourceMaps,
    [map.name],
  );
  verifyManifestBinding(report, f.chosen);
  assert.throws(
    () => verifyManifestBinding(report, { ...f.chosen, attempt: "1" }),
    /attempt/,
  );
});

test("ZIP rejects traversal, aliases, symlinks, missing, duplicate and extra files before extraction", (t) => {
  const f = fixture(t);
  const base = [...f.records, ...f.manifestRecord()];
  for (const name of [
    "../escape",
    "/absolute",
    "C:/drive",
    "artifacts\\escape",
    "artifacts/api-server/dist/NUL.txt",
    "artifacts/api-server/dist/with.",
    "artifacts/api-server/dist/a:stream",
    "artifacts/api-server/dist/orphan.map",
    "secrets.json",
    "empty/",
  ]) {
    assert.throws(() => inspectArchive(f.zip([...base, { name }]), PYTHON));
  }
  for (const records of [
    [...base, base[0]],
    [...base, { ...base[0], name: base[0].name.toUpperCase() }],
    base.slice(1),
    [...base, { name: "artifacts/api-server/dist/link", mode: 0o120777 }],
    [...base, { name: "artifacts/api-server/dist/pipe", mode: 0o010644 }],
    base.map((item, index) =>
      index === 0
        ? { ...item, data: Buffer.from("tampered").toString("base64") }
        : item,
    ),
    [...base, { name: "artifacts/api-server/dist" }],
  ])
    assert.throws(() => inspectArchive(f.zip(records), PYTHON));
  f.manifest.assets.push(f.manifest.assets[0]);
  assert.throws(
    () => inspectArchive(f.zip(), PYTHON),
    /duplicate manifest asset/,
  );
  assert.equal(existsSync(path.join(f.directory, "escape")), false);
});

test("paths refuse existing output, developer overlap and symlinked ancestors", (t) => {
  const directory = temporary(t);
  const source = path.join(directory, "source");
  mkdirSync(source);
  assert.throws(
    () => reserveOutput(source, path.join(source, "stage")),
    /separate/,
  );
  assert.throws(() => reserveOutput(source, directory), /separate/);
  const occupied = path.join(directory, "occupied");
  mkdirSync(occupied);
  assert.throws(() => reserveOutput(source, occupied), /already exists/);
  const link = path.join(directory, "link");
  symlinkSync(source, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => realPath(link), /symlink/);
  assert.throws(
    () => reserveOutput(source, path.join(link, "stage")),
    /symlink/,
  );
  for (const value of [
    "../escape",
    "C:/escape",
    "a\\b",
    "a/.git/config",
    "a/CON",
    "a/trailing.",
  ])
    assert.throws(() => safeRelative(value));
  assert.equal(safeRelative("app/[id].tsx"), "app/[id].tsx");
});

test("ZIP refuses corrupt transport, duplicate JSON keys, oversized metadata and occupied extraction", (t) => {
  const f = fixture(t);
  const truncated = path.join(f.directory, "truncated.zip");
  writeFileSync(truncated, readFileSync(f.archive).subarray(0, -12));
  assert.throws(() => inspectArchive(truncated, PYTHON));
  const oversized = Buffer.from(readFileSync(f.archive));
  const central = oversized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central > 0);
  oversized.writeUInt32LE(512 * 1024 ** 2 + 1, central + 24);
  const large = path.join(f.directory, "oversized.zip");
  writeFileSync(large, oversized);
  assert.throws(() => inspectArchive(large, PYTHON), /size limit/);
  const duplicate = Buffer.from(
    JSON.stringify(f.manifest).replace('"format":1', '"format":1,"format":1'),
  );
  const archive = f.zip([
    ...f.records,
    { name: "release/build-manifest.json", data: duplicate.toString("base64") },
    {
      name: "release/build-manifest.json.sha256",
      data: Buffer.from(`${digest(duplicate)}  build-manifest.json\n`).toString(
        "base64",
      ),
    },
  ]);
  assert.throws(() => inspectArchive(archive, PYTHON), /duplicate JSON key/);
  const occupied = path.join(f.directory, "occupied");
  mkdirSync(occupied);
  writeFileSync(path.join(occupied, "keep.txt"), "operator file");
  assert.throws(() => inspectArchive(f.archive, PYTHON, occupied));
  assert.equal(
    readFileSync(path.join(occupied, "keep.txt"), "utf8"),
    "operator file",
  );
});

test("subprocess environment strips secrets, database configuration, preloads and Git injection", () => {
  const env = processEnvironment({
    PATH: "bins",
    SYSTEMROOT: "windows",
    DATABASE_URL: "secret",
    GITHUB_TOKEN: "secret",
    NODE_OPTIONS: "--import attack",
    GIT_CONFIG_COUNT: "1",
    PGHOST: "production",
    RELEASE_RECOVERY_MODE: "maintenance-forward",
    PYTHONPATH: "attack",
  });
  for (const key of [
    "DATABASE_URL",
    "GITHUB_TOKEN",
    "NODE_OPTIONS",
    "GIT_CONFIG_COUNT",
    "PGHOST",
    "RELEASE_RECOVERY_MODE",
    "PYTHONPATH",
  ])
    assert.equal(env[key], undefined);
  assert.equal(env.PATH, "bins");
});

test("operator checklist explicitly requires manual Publishing verification, development-data copying OFF and the live HTTPS PUBLIC_APP_URL without configuring production", () => {
  const text = checklist({
    selection: selectionBase,
    artifact: { id: 40, sha256: "b".repeat(64) },
    manifest: {
      sha256: "c".repeat(64),
      contractVersion: "fixture",
      source: {
        tree: "a".repeat(40),
        sha256: "d".repeat(64),
        schemaSha256: "e".repeat(64),
      },
      mobile: { domain: "fixture.invalid" },
    },
    files: { "inventory.json": "f".repeat(64), "gates.log": "0".repeat(64) },
  });
  assert.match(
    text,
    new RegExp(
      `^- \\[ \\] Rotate the sole production Publishing RELEASE_MANIFEST_SHA256 secret to ${"c".repeat(64)}; verify the displayed Publishing value matches and remove any environment-variable duplicate before Publish \\(the secret takes precedence\\)\\. Publishing key metadata was unavailable during preparation; the protected reviewer must manually verify the displayed production Publishing secret and absence of an environment-variable duplicate\\.$`,
      "m",
    ),
  );
  assert.match(
    text,
    /^- \[ \] Replit Publish development-data copying is OFF\..*never copy development data into production\.$/m,
  );
  assert.match(
    text,
    /^- \[ \] PUBLIC_APP_URL is the correct live HTTPS origin for the operator-approved production target, not a development preview, localhost, or staging origin\..*this tool does not configure it\.$/m,
  );
  assert.match(text, /PREPARED, NOT APPROVED/);
  assert.equal(
    processEnvironment({ PUBLIC_APP_URL: "https://production.invalid" })
      .PUBLIC_APP_URL,
    undefined,
  );
});

test("Publishing metadata blocks a duplicate checksum key without reading values", async () => {
  await assert.rejects(
    checkPublishingChecksumConfiguration(async () => ({
      secretKeys: ["OTHER_SECRET", "RELEASE_MANIFEST_SHA256"],
      environmentVariableKeys: ["RELEASE_MANIFEST_SHA256", "PUBLIC_APP_URL"],
    })),
    /Remove the Publishing environment variable.*sole source of truth/,
  );
  await assert.rejects(
    checkPublishingChecksumConfiguration(async () => ({
      secretKeys: [{ key: "RELEASE_MANIFEST_SHA256", value: "must-not-read" }],
      environmentVariableKeys: [],
    })),
    /key names only/,
  );
});

test("Publishing metadata accepts a single checksum source and records names-free status", async () => {
  assert.deepEqual(
    await checkPublishingChecksumConfiguration(async () => ({
      secretKeys: ["RELEASE_MANIFEST_SHA256"],
      environmentVariableKeys: ["PUBLIC_APP_URL"],
    })),
    {
      status: "CHECKED",
      manualReviewRequired: false,
      checksumSources: ["secret"],
    },
  );
});

test("unavailable Publishing metadata preserves the manual release review", async () => {
  assert.deepEqual(await checkPublishingChecksumConfiguration(), {
    status: "UNAVAILABLE",
    manualReviewRequired: true,
  });
  assert.deepEqual(
    await checkPublishingChecksumConfiguration(async () => null),
    {
      status: "UNAVAILABLE",
      manualReviewRequired: true,
    },
  );
});

test("handoff uses protected review for Publishing verification without claiming platform attestation", () => {
  const options = {
    candidateSha256: "a".repeat(64),
    checklistSha256: "c".repeat(64),
    reviewer: { id: 2, login: "reviewer" },
    environment: { id: 77, name: ENVIRONMENT },
  };
  const candidate = {
    manifest: { sha256: "b".repeat(64) },
    gates: {
      publishingConfiguration: {
        status: "UNAVAILABLE",
        manualReviewRequired: true,
      },
    },
  };
  assert.deepEqual(validatePublishingChecksumProvenance(candidate, options), {
    status: "MANUALLY_VERIFIED",
    method: "protected-environment-review",
    platformAttestation: false,
    scope: "production Publishing",
    key: "RELEASE_MANIFEST_SHA256",
    secretOnly: true,
    candidateSha256: "a".repeat(64),
    checklistSha256: "c".repeat(64),
    expectedSecretSha256: "b".repeat(64),
    metadataStatus: "UNAVAILABLE",
    environment: { id: 77, name: ENVIRONMENT },
    reviewer: { id: 2, login: "reviewer" },
  });
  candidate.gates.publishingConfiguration = {
    status: "CHECKED",
    manualReviewRequired: false,
    checksumSources: ["secret"],
  };
  assert.equal(
    validatePublishingChecksumProvenance(candidate, options).metadataStatus,
    "CHECKED",
  );
  for (const publishingConfiguration of [
    undefined,
    { status: "UNAVAILABLE", manualReviewRequired: true },
    {
      status: "CHECKED",
      manualReviewRequired: false,
      checksumSources: ["environment-variable"],
    },
    {
      status: "CHECKED",
      manualReviewRequired: false,
      checksumSources: ["workspace-secret"],
    },
    {
      status: "CHECKED",
      manualReviewRequired: false,
      checksumSources: [],
    },
  ]) {
    assert.throws(
      () =>
        validatePublishingChecksumProvenance({
          gates: publishingConfiguration
            ? { publishingConfiguration }
            : undefined,
        }),
      /Publishing checksum|exact candidate checksum/,
    );
  }
  assert.throws(
    () =>
      validatePublishingChecksumProvenance(
        {
          gates: {
            publishingConfiguration: {
              status: "CHECKED",
              manualReviewRequired: false,
              checksumSources: ["secret"],
              secretValue: "must-not-enter-receipt",
            },
          },
        },
        options,
      ),
    /unknown fields/,
  );
});

test("duplicate Publishing metadata refuses before producer access or filesystem writes", async (t) => {
  const directory = temporary(t);
  const output = path.join(directory, "candidate");
  await assert.rejects(
    prepareCandidate(
      { ...selectionBase, source: directory, output },
      {
        client: {
          producer: () => assert.fail("producer accessed after duplicate"),
        },
        readPublishingConfigurationMetadata: async () => ({
          secretKeys: ["RELEASE_MANIFEST_SHA256"],
          environmentVariableKeys: ["RELEASE_MANIFEST_SHA256"],
        }),
      },
    ),
    /duplicated across Publishing secrets and environment variables/,
  );
  assert.equal(existsSync(output), false);
});

test("release CLI metadata snapshot blocks a duplicate before GitHub or filesystem access", (t) => {
  const directory = temporary(t);
  const metadata = path.join(directory, "publishing-configuration.json");
  const output = path.join(directory, "candidate");
  writeFileSync(
    metadata,
    JSON.stringify({
      secretKeys: ["RELEASE_MANIFEST_SHA256"],
      environmentVariableKeys: ["RELEASE_MANIFEST_SHA256"],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts/src/ops/release-candidate.mjs"),
      "--repository",
      selectionBase.repository,
      "--run-id",
      selectionBase.runId,
      "--attempt",
      selectionBase.attempt,
      "--revision",
      selectionBase.revision,
      "--source",
      directory,
      "--output",
      output,
      "--publishing-configuration-metadata",
      metadata,
    ],
    {
      cwd: ROOT,
      env: processEnvironment(),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release-candidate: REFUSED/);
  assert.equal(result.stdout, "");
  assert.equal(existsSync(output), false);
});

test("Publishing metadata snapshot reader accepts only a small regular file", async (t) => {
  const directory = temporary(t);
  const metadata = path.join(directory, "publishing-configuration.json");
  writeFileSync(
    metadata,
    JSON.stringify({
      secretKeys: ["RELEASE_MANIFEST_SHA256"],
      environmentVariableKeys: [],
    }),
  );
  assert.deepEqual(
    await checkPublishingChecksumConfiguration(
      publishingConfigurationMetadataReader(metadata),
    ),
    {
      status: "CHECKED",
      manualReviewRequired: false,
      checksumSources: ["secret"],
    },
  );
});

test("dry run selects provenance without download, filesystem writes or gates", async (t) => {
  const directory = temporary(t);
  const output = path.join(directory, "candidate");
  const result = await prepareCandidate(
    { ...selectionBase, dryRun: true, output },
    {
      client: {
        producer: async () => producer(),
        download: () => assert.fail("download in dry run"),
      },
    },
  );
  assert.equal(result.status, "DRY_RUN");
  assert.equal(result.gatesRun, false);
  assert.deepEqual(result.publishingConfiguration, {
    status: "UNAVAILABLE",
    manualReviewRequired: true,
  });
  assert.equal(result.approved, false);
  assert.equal(existsSync(output), false);
});

test("end-to-end preparation reuses all seven real pilot/RUN gates without bundle execution or developer mutation", async (t) => {
  const f = fixture(t);
  f.write("source.txt", "developer uncommitted work\n");
  f.write(
    "artifacts/landing/dist/public/index.html",
    "developer watcher output",
  );
  const before = f.git("status", "--porcelain");
  const result = await prepareCandidate(f.options, { client: f.client });
  assert.equal(result.status, "PREPARED");
  assert.equal(result.approved, false);
  assert.equal(
    readFileSync(path.join(result.staging, "source.txt"), "utf8"),
    "reviewed source\n",
  );
  assert.equal(
    readFileSync(path.join(f.source, "source.txt"), "utf8"),
    "developer uncommitted work\n",
  );
  assert.equal(f.git("status", "--porcelain"), before);
  assert.deepEqual(
    readFileSync(path.join(result.evidence, "original.zip")),
    readFileSync(f.archive),
  );
  const candidate = await verifyEvidence(
    result.evidence,
    result.candidateSha256,
  );
  assert.equal(candidate.gates.applications.length, 7);
  assert.equal(candidate.gates.databaseAccess, false);
  assert.equal(candidate.gates.publishingConfiguration.status, "UNAVAILABLE");
  const log = readFileSync(path.join(result.evidence, "gates.log"), "utf8");
  assert.equal((log.match(/all seven CI artifacts/g) ?? []).length, 7);
  // The retained provenance is the consumed-field snapshot, not the raw
  // producer responses (R116).
  assert.deepEqual(
    JSON.parse(
      readFileSync(path.join(result.evidence, "provenance.json"), "utf8"),
    ),
    provenanceSnapshot(f.evidence),
  );
  assert.match(log, /pilot profile/);
  assert.equal(existsSync(path.join(f.options.output, "unpacked")), false);
  await assert.rejects(
    prepareCandidate(f.options, { client: f.client }),
    /already exists/,
  );
  writeFileSync(path.join(result.evidence, "gates.log"), "tampered");
  await assert.rejects(
    verifyEvidence(result.evidence, result.candidateSha256),
    /checksum/,
  );
});

test("long Expo transport paths prepare through all seven gates and cleanup", async (t) => {
  const f = fixture(t);
  const name =
    "artifacts/mobile/dist/static-build/1788904986134-3589/_expo/node_modules/.pnpm/" +
    "@expo+vector-icons@15.1.1_expo-font@14.0.12_expo@54.0.35_react-native@0.81.5_" +
    "@babel+cor_8679ad296ddbfbe0b15babd247e2ae5e/node_modules/@expo/vector-icons/" +
    "build/vendor/react-native-vector-icons/Fonts/MaterialCommunityIcons.ttf";
  const bytes = Buffer.from("synthetic font bytes");
  assert.ok(name.length > 260);
  f.write(name, bytes);
  f.manifest.assets = assetInventory(f.source);
  f.records.push({ name, data: bytes.toString("base64") });
  const archive = f.zip();
  f.evidence.artifacts[0].size_in_bytes = lstatSync(archive).size;
  f.evidence.artifacts[0].digest = `sha256:${digest(readFileSync(archive))}`;
  f.client.download = async (repository, artifact, destination) =>
    copyFileSync(archive, destination);

  const result = await prepareCandidate(f.options, { client: f.client });
  assert.equal(result.status, "PREPARED");
  assert.deepEqual(readFileSync(path.join(result.staging, name)), bytes);
  const candidate = await verifyEvidence(
    result.evidence,
    result.candidateSha256,
  );
  assert.equal(candidate.gates.applications.length, 7);
  assert.equal(candidate.gates.databaseAccess, false);
  assert.equal(existsSync(path.join(f.options.output, "unpacked")), false);
  assert.equal(existsSync(path.join(f.options.output, "git-template")), false);
  assert.equal(existsSync(path.join(result.evidence, "failure.json")), false);
});

test("long tracked source paths remain complete through checkout and all seven gates", async (t) => {
  const name = `attached_assets/${"tracked-source-".repeat(9)}.txt`;
  const f = fixture(t, name);
  f.options.output = path.join(
    f.directory,
    `candidate-${"nested-".repeat(12)}`,
  );
  assert.ok(path.join(f.options.output, "source", name).length > 260);
  const result = await prepareCandidate(f.options, { client: f.client });
  assert.equal(result.status, "PREPARED");
  assert.equal(
    readFileSync(path.join(result.staging, name), "utf8"),
    "tracked long-path source\n",
  );
  assert.deepEqual(sourceIdentity(result.staging), f.manifest.source);
  const candidate = await verifyEvidence(
    result.evidence,
    result.candidateSha256,
  );
  assert.equal(candidate.gates.applications.length, 7);
  assert.equal(candidate.gates.databaseAccess, false);
});

test("long archive and extraction roots retain exclusive writes and reparse refusal", (t) => {
  const f = fixture(t);
  const directory = path.join(
    f.directory,
    ...Array(4).fill("nested-".repeat(10)),
  );
  assert.ok(directory.length > 260);
  mkdirSync(directory, { recursive: true });
  const archive = path.join(directory, "original.zip");
  copyFileSync(f.archive, archive);
  const destination = path.join(directory, "unpacked");
  assert.deepEqual(
    inspectArchive(archive, PYTHON, destination),
    inspectArchive(f.archive, PYTHON),
  );
  const manifest = path.join(destination, "release/build-manifest.json");
  const before = readFileSync(manifest);
  assert.throws(() => inspectArchive(archive, PYTHON, destination));
  assert.deepEqual(readFileSync(manifest), before);

  const outside = path.join(f.directory, "outside");
  mkdirSync(outside);
  const link = path.join(directory, "alias");
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => inspectArchive(archive, PYTHON, path.join(link, "unpacked")),
    /symlink\/reparse point refused/,
  );
  assert.equal(existsSync(path.join(outside, "unpacked")), false);
});

test("existing source identity gate failure removes partial stage while retaining original evidence", async (t) => {
  const f = fixture(t);
  f.manifest.source.sha256 = "f".repeat(64);
  const archive = f.zip();
  f.evidence.artifacts[0].size_in_bytes = lstatSync(archive).size;
  f.evidence.artifacts[0].digest = `sha256:${digest(readFileSync(archive))}`;
  f.client.download = async (repository, artifact, destination) =>
    copyFileSync(archive, destination);
  await assert.rejects(
    prepareCandidate(f.options, { client: f.client }),
    /source or schema/,
  );
  assert.equal(existsSync(path.join(f.options.output, "source")), false);
  assert.equal(existsSync(path.join(f.options.output, "unpacked")), false);
  assert.deepEqual(
    readFileSync(path.join(f.options.output, "evidence/original.zip")),
    readFileSync(archive),
  );
  assert.equal(
    JSON.parse(
      readFileSync(path.join(f.options.output, "evidence/failure.json")),
    ).stagingRemoved,
    true,
  );
});

test("producer rerun during preparation refuses and cleans verified staging", async (t) => {
  const f = fixture(t);
  let calls = 0;
  f.client.producer = async () => {
    const p = structuredClone(f.evidence);
    if (++calls > 1) p.run.run_attempt++;
    return p;
  };
  await assert.rejects(
    prepareCandidate(f.options, { client: f.client }),
    /attempt/,
  );
  assert.equal(existsSync(path.join(f.options.output, "source")), false);
});

test("interrupted download is retained as unverified and cannot create a candidate", async (t) => {
  const f = fixture(t);
  f.client.download = async (repository, artifact, destination) => {
    writeFileSync(destination, "partial download");
    throw new Error("synthetic interrupted download");
  };
  await assert.rejects(
    prepareCandidate(f.options, { client: f.client }),
    /interrupted/,
  );
  const evidence = path.join(f.options.output, "evidence");
  assert.equal(
    JSON.parse(readFileSync(path.join(evidence, "failure.json")))
      .archiveVerified,
    false,
  );
  assert.equal(existsSync(path.join(evidence, "candidate.json")), false);
  assert.equal(existsSync(path.join(f.options.output, "source")), false);
  assert.equal(
    readFileSync(path.join(evidence, "original.zip"), "utf8"),
    "partial download",
  );
});

test("committed source symlink modes are rejected before checkout, including Windows", (t) => {
  const f = fixture(t);
  const object = execute(
    "git",
    ["hash-object", "-w", "--stdin"],
    f.source,
    "source.txt",
  );
  f.git("update-index", "--add", "--cacheinfo", `120000,${object},link`);
  f.git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "symlink fixture",
  );
  const reservation = reserveOutput(f.source, f.options.output);
  assert.throws(
    () => stageSource(reservation, f.git("rev-parse", "HEAD")),
    /symlinks/,
  );
  assert.equal(existsSync(path.join(f.options.output, "source/link")), false);
});

function approvalFixture() {
  const environment = {
    id: 77,
    name: ENVIRONMENT,
    protection_rules: [
      {
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [{ type: "User", reviewer: { id: 2 } }],
      },
    ],
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  };
  const policies = [{ name: "main", type: "branch" }];
  const context = {
    GITHUB_ACTIONS: "true",
    GITHUB_JOB: "handoff",
    GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "789",
    GITHUB_SHA: "c".repeat(40),
    GITHUB_REPOSITORY: selectionBase.repository,
  };
  const run = {
    id: 789,
    run_attempt: 1,
    path: ".github/workflows/prepare-release.yml",
    event: "workflow_dispatch",
    status: "in_progress",
    head_branch: "main",
    head_sha: context.GITHUB_SHA,
    repository: { id: 20, full_name: context.GITHUB_REPOSITORY },
    head_repository: { id: 20 },
    actor: { id: 1 },
    triggering_actor: { id: 1 },
  };
  const reviews = [
    {
      state: "approved",
      environments: [{ id: 77, name: ENVIRONMENT }],
      user: { id: 2, login: "reviewer", type: "User" },
    },
  ];
  return { environment, policies, context, run, reviews };
}

test("protected environment requires reviewers, anti-self-review, main-only policy and explicit approval history", () => {
  const a = approvalFixture();
  validateProtection(a.environment, a.policies);
  assert.equal(
    validateApproval(a.run, a.reviews, a.environment, a.context).id,
    2,
  );
  assert.equal(
    validateApproval(
      { ...a.run, path: `${a.run.path}@main` },
      a.reviews,
      a.environment,
      a.context,
    ).id,
    2,
  );
  for (const mutate of [
    (x) => (x.environment.protection_rules = []),
    (x) => (x.environment.protection_rules[0].prevent_self_review = false),
    (x) => (x.policies[0].name = "*"),
    (x) => (x.policies[0].type = "tag"),
  ]) {
    const x = approvalFixture();
    mutate(x);
    assert.throws(() => validateProtection(x.environment, x.policies));
  }
  for (const mutate of [
    (x) => (x.reviews = []),
    (x) => (x.reviews[0].state = "rejected"),
    (x) => (x.reviews[0].user.id = 1),
    (x) => (x.reviews[0].user.type = "Bot"),
    (x) => (x.context.GITHUB_RUN_ATTEMPT = "2"),
    (x) => x.reviews.push(x.reviews[0]),
    (x) => x.reviews[0].environments[0].id++,
    (x) => (x.run.path = ".github/workflows/other.yml"),
  ]) {
    const x = approvalFixture();
    mutate(x);
    assert.throws(() =>
      validateApproval(x.run, x.reviews, x.environment, x.context),
    );
  }
});

test("handoff records explicit manual Publishing verification for unavailable metadata", async (t) => {
  const f = fixture(t);
  const result = await prepareCandidate(f.options, { client: f.client });
  const approval = approvalFixture();
  const client = {
    producer: async () => structuredClone(f.evidence),
    json: async (endpoint) => {
      if (endpoint.includes(`/environments/${ENVIRONMENT}`))
        return approval.environment;
      if (endpoint.endsWith(`/actions/runs/${approval.context.GITHUB_RUN_ID}`))
        return approval.run;
      if (endpoint.endsWith("/approvals")) return approval.reviews;
      throw new Error(`unexpected JSON endpoint: ${endpoint}`);
    },
    list: async (endpoint) => {
      assert.match(endpoint, /deployment-branch-policies$/);
      return approval.policies;
    },
  };
  const output = path.join(f.directory, "approved");
  const handoff = await approveHandoff(
    {
      evidence: result.evidence,
      candidateSha256: result.candidateSha256,
      output,
    },
    client,
    approval.context,
  );
  assert.equal(
    handoff.receipt.publishingVerification.status,
    "MANUALLY_VERIFIED",
  );
  assert.equal(
    handoff.receipt.publishingVerification.platformAttestation,
    false,
  );
  assert.equal(handoff.receipt.publishingVerification.secretOnly, true);
  assert.equal(
    handoff.receipt.publishingVerification.candidateSha256,
    result.candidateSha256,
  );
  const receipt = JSON.parse(
    readFileSync(path.join(output, "approved-handoff.json"), "utf8"),
  );
  assert.equal(
    receipt.publishingVerification.expectedSecretSha256,
    receipt.manifestSha256,
  );
  assert.equal(
    receipt.publishingVerification.checklistSha256,
    receipt.checklistSha256,
  );
  assert.equal(receipt.publishingVerification.scope, "production Publishing");
  assert.deepEqual(receipt.publishingVerification.environment, {
    id: approval.environment.id,
    name: ENVIRONMENT,
  });
  assert.equal(receipt.publishingVerification.reviewer.id, 2);
  assert.equal(receipt.publishingVerification.reviewer.login, "reviewer");
  assert.doesNotMatch(
    readFileSync(path.join(output, "approved-handoff.json"), "utf8"),
    /secretValue|must-not-enter-receipt/,
  );
  assert.equal(existsSync(path.join(output, "approved-checklist.md")), true);
});

test("handoff refuses when unavailable metadata lacks the protected manual review", async (t) => {
  const f = fixture(t);
  const result = await prepareCandidate(f.options, { client: f.client });
  const approval = approvalFixture();
  approval.reviews = [];
  const client = {
    producer: async () => structuredClone(f.evidence),
    json: async (endpoint) => {
      if (endpoint.includes(`/environments/${ENVIRONMENT}`))
        return approval.environment;
      if (endpoint.endsWith(`/actions/runs/${approval.context.GITHUB_RUN_ID}`))
        return approval.run;
      if (endpoint.endsWith("/approvals")) return approval.reviews;
      throw new Error(`unexpected JSON endpoint: ${endpoint}`);
    },
    list: async () => approval.policies,
  };
  await assert.rejects(
    approveHandoff(
      {
        evidence: result.evidence,
        candidateSha256: result.candidateSha256,
        output: path.join(f.directory, "refused-approval"),
      },
      client,
      approval.context,
    ),
    /one explicit protected-environment approval required/,
  );
  assert.equal(existsSync(path.join(f.directory, "refused-approval")), false);
});

test("workflow stays manual, main-only, read-only, protected and distinct from production deployment", () => {
  const workflow = readFileSync(
    path.join(ROOT, ".github/workflows/prepare-release.yml"),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /name: release-production-handoff/);
  assert.match(workflow, /candidate-sha256 "\$CANDIDATE_SHA256"/);
  assert.match(
    workflow,
    /artifact-ids: \$\{\{ needs.prepare.outputs.evidence_id \}\}/,
  );
  assert.doesNotMatch(
    workflow,
    /pull_request_target|workflow_run:|secrets\.|permissions:[\s\S]*?\bwrite\b|pnpm install|replit.*deploy|db.*push/,
  );
  assert.doesNotMatch(
    workflow,
    /publishing_configuration_metadata|CANDIDATE_PUBLISHING_METADATA|publishing-configuration-metadata/,
    "workflow must not accept self-asserted Publishing provenance",
  );
  const reviewedPins = new Set([
    "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  ]);
  const actual = new Set(
    [...workflow.matchAll(/uses: ([^\s]+)/g)].map((match) => match[1]),
  );
  assert.deepEqual(
    actual,
    reviewedPins,
    "only officially verified action pins are permitted",
  );
  for (const pin of actual) assert.match(pin, /@[a-f0-9]{40}$/);
});

test("the CI producer workflow grants its token read-only contents access (R113)", () => {
  // Release preparation trusts the artifacts ci.yml produces, so that
  // workflow's token scope is part of the provenance chain: one top-level
  // read-only block, no job widening it, and no secret or token use at all.
  const workflow = readFileSync(
    path.join(ROOT, ".github/workflows/ci.yml"),
    "utf8",
  );
  const block = workflow.match(/^permissions:\n((?: {2}[a-z-]+: [a-z-]+\n)+)/m);
  assert.ok(block, "ci.yml must declare a top-level permissions block");
  assert.deepEqual(
    block[1]
      .trim()
      .split("\n")
      .map((line) => line.trim()),
    ["contents: read"],
  );
  assert.equal(
    (workflow.match(/^\s*permissions:/gm) ?? []).length,
    1,
    "no job may widen the token",
  );
  assert.doesNotMatch(
    workflow,
    /pull_request_target|workflow_run:|secrets\.|github\.token|GITHUB_TOKEN/,
  );
});

test("the retained provenance keeps only the fields the checks consumed and still validates (R116)", () => {
  const evidence = producer();
  evidence.repository.owner = { login: "someone", id: 1 };
  evidence.run.actor = { login: "someone", id: 1 };
  evidence.run.head_commit = { message: "internal commit message" };
  evidence.attempt.triggering_actor = { login: "someone", id: 1 };
  evidence.jobs[1].steps.push({
    name: "Set up job",
    number: 0,
    status: "completed",
    conclusion: "success",
  });
  evidence.jobs[1].runner_name = "GitHub Actions 42";
  evidence.artifacts[0].archive_download_url =
    "https://api.github.com/repos/x/y/actions/artifacts/40/zip";
  const snapshot = provenanceSnapshot(evidence);
  assert.deepEqual(Object.keys(snapshot), [
    "repository",
    "workflow",
    "run",
    "attempt",
    "jobsEndpoint",
    "jobs",
    "artifacts",
  ]);
  const text = JSON.stringify(snapshot);
  for (const leaked of [
    "owner",
    "actor",
    "head_commit",
    "internal commit message",
    "Set up job",
    "runner_name",
    "archive_download_url",
  ])
    assert.equal(text.includes(leaked), false, leaked);
  // Re-validation from the snapshot alone selects the same artifact, now
  // without the download URL the raw response carried.
  assert.equal(
    validateProducer(selectionBase, snapshot).id,
    validateProducer(selectionBase, evidence).id,
  );
  assert.deepEqual(
    validateProducer(selectionBase, snapshot),
    snapshot.artifacts[0],
  );
  assert.equal(snapshot.jobs[1].steps.length, 2);
});
