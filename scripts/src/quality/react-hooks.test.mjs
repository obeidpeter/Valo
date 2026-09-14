import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ESLint } from "eslint";
import { ROOT } from "./shared.mjs";

const eslint = new ESLint({ cwd: ROOT });
const reactRoots = [
  "artifacts/console/src",
  "artifacts/sme-compliance/src",
  "artifacts/buyer-portal/src",
  "artifacts/landing/src",
  "artifacts/penalty-calculator/src",
  "artifacts/mobile/app",
  "artifacts/mobile/lib",
  "lib/web-ui/src",
];

for (const root of reactRoots) {
  for (const extension of ["ts", "tsx"]) {
    const filePath = path.join(
      ROOT,
      root,
      `hook-coverage-fixture.${extension}`,
    );
    test(`${root}/*.${extension} enforces both hook rules`, async () => {
      const config = await eslint.calculateConfigForFile(filePath);
      assert.equal(config.rules["react-hooks/rules-of-hooks"][0], 2);
      assert.equal(config.rules["react-hooks/exhaustive-deps"][0], 2);

      const [invalid] = await eslint.lintText(
        `import { useEffect } from "react";
         export function useFixture(enabled: boolean, value: string) {
           if (enabled) useEffect(() => { console.log(value); }, []);
         }`,
        { filePath },
      );
      for (const ruleId of [
        "react-hooks/rules-of-hooks",
        "react-hooks/exhaustive-deps",
      ]) {
        assert.ok(
          invalid.messages.some(
            (message) => message.ruleId === ruleId && message.severity === 2,
          ),
          `${filePath} must reject ${ruleId}`,
        );
      }

      const [valid] = await eslint.lintText(
        `import { useEffect } from "react";
         export function useFixture(enabled: boolean, value: string) {
           useEffect(() => { if (enabled) console.log(value); }, [enabled, value]);
         }`,
        { filePath },
      );
      assert.deepEqual(valid.messages, []);
    });
  }
}
