import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { ROOT } from "./shared.mjs";

const source = (file) => readFileSync(path.join(ROOT, file), "utf8");

test("production recovery messages point to the safe runbook without data-copy advice", () => {
  const guidance = source(
    "artifacts/api-server/src/bootstrap/recovery-guidance.ts",
  );
  assert.match(guidance, /docs\/operations\.md#production-readiness-recovery/);
  assert.match(guidance, /Keep development-data copying OFF/);
  assert.match(guidance, /do not run schema push against production/);
  assert.match(guidance, /fresh verified backup and disposable restore drill/);
  const startup = source("artifacts/api-server/src/index.ts");
  for (const name of [
    "applyProductionGuardrails",
    "verifyProductionGuardrails",
    "ensureRlsRoleAssumable",
  ]) {
    const body = startup
      .split(`async function ${name}(`)[1]
      ?.split("\nasync function ")[0];
    assert.ok(body, `missing startup function ${name}`);
    assert.match(body, /PRODUCTION_RECOVERY_GUIDANCE/);
    assert.doesNotMatch(
      body,
      /dev\s*(?:->|\u2192)\s*prod|overwrite data|run migrate|run push/i,
    );
  }
});

test("active recovery docs distinguish disposable tests from production maintenance", () => {
  const operations = source("docs/operations.md");
  assert.match(operations, /^## Production Readiness Recovery$/m);
  const recovery = operations
    .split("## Production Readiness Recovery")[1]
    .split("\n## ")[0];
  assert.match(recovery, /development-data copying \*\*OFF\*\*/);
  assert.match(recovery, /separate disposable database/);
  assert.match(
    recovery,
    /Stop every API instance, worker, schedule and external/,
  );
  assert.match(recovery, /Keep writers stopped after a/);
  assert.match(recovery, /complete production security catalog/);
  const troubleshooting = source("docs/troubleshooting.md");
  assert.match(troubleshooting, /operations\.md#production-readiness-recovery/);
  assert.ok(
    troubleshooting.indexOf("only, never production") <
      troubleshooting.indexOf("run push"),
    "the disposable-only warning must precede database setup commands",
  );
});
