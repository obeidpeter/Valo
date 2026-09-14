import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sha256File } from "./common.mjs";

// Where GitHub serves artifact bytes from: its own content host family and
// the Azure blob accounts behind the Actions results service. Extend
// deliberately, never to an operator-supplied value (R114).
const ARTIFACT_STORAGE_HOST_SUFFIXES = Object.freeze([
  ".githubusercontent.com",
  ".blob.core.windows.net",
]);

const WORKFLOW = ".github/workflows/ci.yml";
const STAMP_STEP = "Stamp tested immutable build manifest";
const VERIFY_STEP = "Verify tested immutable build manifest";
const UPLOAD_STEP = "Preserve tested release artifact";
const CANDIDATE_STEPS = [
  STAMP_STEP,
  "Record tested candidate identity",
  "Preserve tested candidate",
];
// Retain both the legacy producer and the split-job qualification evidence.
const PRODUCER_STEPS = Object.freeze([
  ...CANDIDATE_STEPS,
  VERIFY_STEP,
  UPLOAD_STEP,
]);
export const ENVIRONMENT = "release-production-handoff";
export const mainWorkflowPath = (actual, expected) =>
  actual === expected || actual === `${expected}@main`;
export const positiveId = (value) =>
  /^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value));

export function selection(input) {
  assert.match(
    input.repository ?? "",
    /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/,
    "owner/repository required",
  );
  assert.ok(
    positiveId(input.runId) && positiveId(input.attempt),
    "exact CI run and attempt required",
  );
  assert.match(
    input.revision ?? "",
    /^[a-f0-9]{40}$/,
    "full expected source SHA required",
  );
  return {
    repository: input.repository,
    runId: String(input.runId),
    attempt: String(input.attempt),
    revision: input.revision,
  };
}

export function validateProducer(input, evidence) {
  const wanted = selection(input);
  const { repository, workflow, run, attempt, jobs, artifacts } = evidence;
  assert.equal(
    repository.full_name,
    wanted.repository,
    "repository identity mismatch",
  );
  assert.ok(positiveId(repository.id), "missing repository ID");
  assert.equal(workflow.path, WORKFLOW, "foreign workflow");
  assert.ok(positiveId(workflow.id), "missing workflow ID");
  for (const item of [run, attempt]) {
    assert.equal(String(item.id), wanted.runId, "foreign run");
    assert.equal(
      String(item.run_attempt),
      wanted.attempt,
      "stale or changed run attempt",
    );
    assert.equal(item.workflow_id, workflow.id, "foreign producer workflow");
    assert.ok(mainWorkflowPath(item.path, WORKFLOW), "foreign producer path");
    assert.equal(item.repository?.id, repository.id, "foreign repository");
    assert.equal(
      item.head_repository?.id,
      repository.id,
      "fork producer refused",
    );
    assert.equal(item.head_branch, "main", "main producer required");
    assert.equal(item.head_sha, wanted.revision, "wrong source revision");
    assert.ok(
      ["push", "workflow_dispatch"].includes(item.event),
      "untrusted producer event",
    );
    assert.equal(item.status, "completed", "producer not complete");
    assert.equal(item.conclusion, "success", "producer not successful");
  }
  assert.equal(run.event, attempt.event, "producer event changed");
  assert.equal(
    evidence.jobsEndpoint,
    `/repos/${wanted.repository}/actions/runs/${wanted.runId}/attempts/${wanted.attempt}/jobs`,
    "attempt-scoped jobs endpoint required",
  );
  const attemptStarted = Date.parse(attempt.run_started_at);
  assert.ok(Number.isFinite(attemptStarted), "attempt start time required");
  assert.equal(
    new Set(jobs.map((job) => job.id)).size,
    jobs.length,
    "duplicate jobs",
  );
  const splitProducer = jobs.some((job) => job.name === "release-artifact");
  for (const name of [
    "quality-gate",
    "e2e",
    ...(splitProducer ? ["release-artifact"] : []),
  ]) {
    const matches = jobs.filter((job) => job.name === name);
    assert.equal(
      matches.length,
      1,
      `exact successful ${name} job required in attempt`,
    );
    const job = matches[0];
    assert.equal(String(job.run_id), wanted.runId, "foreign job run");
    // The documented jobs response does not require run_attempt. The authenticated
    // attempt-specific endpoint and job timestamps provide that binding.
    if (job.run_attempt !== undefined)
      assert.equal(
        String(job.run_attempt),
        wanted.attempt,
        "foreign job attempt",
      );
    assert.ok(
      Date.parse(job.started_at) >= attemptStarted,
      "job predates selected attempt",
    );
    assert.equal(job.head_sha, wanted.revision, "foreign job source");
    assert.equal(job.status, "completed");
    assert.equal(job.conclusion, "success");
  }
  const producer = jobs.find(
    (job) => job.name === (splitProducer ? "release-artifact" : "e2e"),
  );
  const producerSteps = verifiedSteps(producer, [
    splitProducer ? VERIFY_STEP : STAMP_STEP,
    UPLOAD_STEP,
  ]);
  if (splitProducer) {
    verifiedSteps(
      jobs.find((job) => job.name === "e2e"),
      CANDIDATE_STEPS,
    );
    for (const name of ["quality-gate", "e2e"]) {
      const gate = jobs.find((job) => job.name === name);
      assert.ok(
        Date.parse(producer.started_at) >= Date.parse(gate.completed_at),
        "release qualification must follow both successful gates",
      );
    }
  }
  assert.equal(
    new Set(artifacts.map((item) => item.id)).size,
    artifacts.length,
    "duplicate artifact IDs",
  );
  const matches = artifacts.filter(
    (item) => item.name === `meridian-release-${wanted.revision}`,
  );
  assert.equal(
    matches.length,
    1,
    "exactly one immutable release artifact required; no latest fallback",
  );
  const artifact = matches[0];
  assert.ok(positiveId(artifact.id), "missing artifact ID");
  assert.equal(artifact.expired, false, "artifact expired");
  assert.match(
    artifact.digest ?? "",
    /^sha256:[a-f0-9]{64}$/,
    "authenticated GitHub artifact digest required",
  );
  assert.ok(
    Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= 4 * 1024 ** 3,
    "archive size limit",
  );
  assert.deepEqual(
    artifact.workflow_run,
    {
      id: Number(wanted.runId),
      repository_id: repository.id,
      head_repository_id: repository.id,
      head_branch: "main",
      head_sha: wanted.revision,
    },
    "foreign artifact provenance",
  );
  const [, upload] = producerSteps;
  const start = Date.parse(upload.started_at);
  const end = Date.parse(upload.completed_at);
  assert.ok(
    Number.isFinite(start) && Number.isFinite(end) && start <= end,
    "invalid producer interval",
  );
  for (const time of [artifact.created_at, artifact.updated_at]) {
    assert.ok(
      Date.parse(time) >= start && Date.parse(time) <= end,
      "artifact outside selected producer attempt",
    );
  }
  return artifact;
}

function verifiedSteps(job, names) {
  const selected = names.map((name) => {
    const matches = (job.steps ?? []).filter((step) => step.name === name);
    assert.equal(matches.length, 1, `missing/duplicate producer step: ${name}`);
    assert.equal(matches[0].status, "completed");
    assert.equal(matches[0].conclusion, "success");
    return matches[0];
  });
  assert.ok(
    selected.every(
      (step, index) =>
        positiveId(step.number) &&
        (index === 0 || step.number > selected[index - 1].number),
    ),
    "producer steps must be ordered",
  );
  const timeline = [
    job.started_at,
    ...selected.flatMap((step) => [step.started_at, step.completed_at]),
    job.completed_at,
  ].map(Date.parse);
  assert.ok(
    timeline.every(
      (value, index) =>
        Number.isFinite(value) && (index === 0 || value >= timeline[index - 1]),
    ),
    "invalid producer step interval",
  );
  return selected;
}

const pick = (source, keys) =>
  Object.fromEntries(
    keys
      .filter((key) => source?.[key] !== undefined)
      .map((key) => [source && key, source[key]]),
  );
const RUN_FIELDS = [
  "id",
  "run_attempt",
  "workflow_id",
  "path",
  "head_branch",
  "head_sha",
  "event",
  "status",
  "conclusion",
  "run_started_at",
  "html_url",
];
const JOB_FIELDS = [
  "id",
  "name",
  "run_id",
  "run_attempt",
  "head_sha",
  "status",
  "conclusion",
  "started_at",
  "completed_at",
  "html_url",
];
const STEP_FIELDS = [
  "name",
  "number",
  "status",
  "conclusion",
  "started_at",
  "completed_at",
];
const ARTIFACT_FIELDS = [
  "id",
  "name",
  "expired",
  "digest",
  "size_in_bytes",
  "created_at",
  "updated_at",
];

// What the retained provenance file keeps (R116): the producer fields the
// checks above consumed plus the human-facing links, never the whole API
// responses (actors, commit messages, every step of every job, download
// URLs). The snapshot still satisfies validateProducer, so the evidence can
// be re-validated from the file alone.
export function provenanceSnapshot(evidence) {
  const runSnapshot = (item) => ({
    ...pick(item, RUN_FIELDS),
    repository: pick(item.repository, ["id"]),
    head_repository: pick(item.head_repository, ["id"]),
  });
  return {
    repository: pick(evidence.repository, ["id", "full_name"]),
    workflow: pick(evidence.workflow, ["id", "path"]),
    run: runSnapshot(evidence.run),
    attempt: runSnapshot(evidence.attempt),
    jobsEndpoint: evidence.jobsEndpoint,
    jobs: evidence.jobs.map((job) => ({
      ...pick(job, JOB_FIELDS),
      steps: (job.steps ?? [])
        .filter((step) => PRODUCER_STEPS.includes(step.name))
        .map((step) => pick(step, STEP_FIELDS)),
    })),
    artifacts: evidence.artifacts.map((item) => ({
      ...pick(item, ARTIFACT_FIELDS),
      workflow_run: pick(item.workflow_run, [
        "id",
        "repository_id",
        "head_repository_id",
        "head_branch",
        "head_sha",
      ]),
    })),
  };
}

export function githubClient(token, fetchImpl = fetch) {
  assert.ok(
    typeof token === "string" && token.length > 0,
    "GITHUB_TOKEN required (read-only repository access)",
  );
  async function request(endpoint) {
    assert.ok(
      endpoint.startsWith("/repos/") && !endpoint.includes(".."),
      "invalid GitHub endpoint",
    );
    const response = await fetchImpl(`https://api.github.com${endpoint}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(120000),
    });
    assert.ok(
      response.ok || response.status === 302,
      `GitHub request failed (${response.status})`,
    );
    return response;
  }
  async function json(endpoint) {
    const response = await request(endpoint);
    assert.equal(response.status, 200, "unexpected GitHub redirect");
    return response.json();
  }
  async function list(endpoint, key) {
    const result = [];
    let total;
    for (let page = 1; page <= 100; page++) {
      const data = await json(`${endpoint}?per_page=100&page=${page}`);
      assert.ok(
        Array.isArray(data[key]) && Number.isSafeInteger(data.total_count),
        "invalid paginated response",
      );
      total ??= data.total_count;
      assert.equal(
        data.total_count,
        total,
        "pagination changed during selection",
      );
      result.push(...data[key]);
      if (result.length === total) return result;
      assert.ok(
        data[key].length > 0 && result.length < total,
        "incomplete/duplicate pagination",
      );
    }
    throw new Error("GitHub pagination limit exceeded");
  }
  return {
    json,
    list,
    async producer(input) {
      const wanted = selection(input);
      const base = `/repos/${wanted.repository}`;
      const endpoint = `${base}/actions/runs/${wanted.runId}`;
      const evidence = {
        repository: await json(base),
        workflow: await json(`${base}/actions/workflows/ci.yml`),
        run: await json(endpoint),
        attempt: await json(`${endpoint}/attempts/${wanted.attempt}`),
        jobsEndpoint: `${endpoint}/attempts/${wanted.attempt}/jobs`,
        jobs: await list(`${endpoint}/attempts/${wanted.attempt}/jobs`, "jobs"),
        artifacts: await list(`${endpoint}/artifacts`, "artifacts"),
      };
      validateProducer(wanted, evidence);
      return evidence;
    },
    async download(repository, artifact, destination) {
      let response = await request(
        `/repos/${repository}/actions/artifacts/${artifact.id}/zip`,
      );
      if (response.status === 302) {
        const url = new URL(response.headers.get("location"));
        assert.ok(
          url.protocol === "https:" &&
            !url.username &&
            !url.password &&
            !url.hash,
          "unsafe artifact redirect",
        );
        // The digest check decides whether the bytes count; the host pin
        // decides where this credential-free GET may go at all, so a spoofed
        // API answer cannot point it at an arbitrary server (R114).
        assert.ok(
          ARTIFACT_STORAGE_HOST_SUFFIXES.some((suffix) =>
            url.hostname.endsWith(suffix),
          ),
          "unexpected artifact redirect host",
        );
        // Do not forward the API token to signed blob storage or log the URL.
        response = await fetchImpl(url, {
          redirect: "error",
          signal: AbortSignal.timeout(300000),
        });
      }
      assert.equal(response.status, 200, "artifact download failed");
      let bytes = 0;
      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
          transform(chunk, encoding, done) {
            bytes += chunk.length;
            done(
              bytes > artifact.size_in_bytes || bytes > 4 * 1024 ** 3
                ? new Error("archive size limit")
                : null,
              chunk,
            );
          },
        }),
        createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      );
      assert.equal(
        bytes,
        artifact.size_in_bytes,
        "archive byte count mismatch",
      );
      assert.equal(
        await sha256File(destination),
        artifact.digest.slice(7),
        "authenticated archive checksum mismatch",
      );
    },
  };
}

export function validateProtection(environment, policies) {
  assert.equal(environment.name, ENVIRONMENT, "wrong approval environment");
  assert.ok(positiveId(environment.id), "approval environment missing");
  const rules = environment.protection_rules?.filter(
    (rule) => rule.type === "required_reviewers",
  );
  assert.equal(
    rules?.length,
    1,
    "required environment reviewers not configured",
  );
  assert.equal(
    rules[0].prevent_self_review,
    true,
    "self-approval must be disabled",
  );
  assert.ok(rules[0].reviewers?.length > 0, "environment reviewers empty");
  assert.deepEqual(
    environment.deployment_branch_policy,
    { protected_branches: false, custom_branch_policies: true },
    "explicit main-only environment policy required",
  );
  assert.equal(
    policies.length,
    1,
    "exactly one environment branch policy required",
  );
  assert.equal(policies[0].name, "main");
  assert.equal(policies[0].type, "branch");
}

export async function protection(client, repository) {
  const endpoint = `/repos/${repository}/environments/${ENVIRONMENT}`;
  const environment = await client.json(endpoint);
  const policies = await client.list(
    `${endpoint}/deployment-branch-policies`,
    "branch_policies",
  );
  validateProtection(environment, policies);
  return { environment, policies };
}
