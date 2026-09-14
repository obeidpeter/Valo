import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";
import { bundleDirectory, measureBundle } from "./bundle-inventory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const require = createRequire(path.join(root, "lib/web-config/package.json"));
const vite = path.join(
  path.dirname(require.resolve("vite/package.json")),
  "bin/vite.js",
);
const out = path.join(root, "tmp/route-budget-r198");
const { values: options } = parseArgs({
  options: {
    "use-built": { type: "boolean", default: false },
    "measure-only": { type: "boolean", default: false },
  },
});
const apps = [
  "console",
  "sme-compliance",
  "buyer-portal",
  "landing",
  "penalty-calculator",
];
const report = {
  generatedAt: new Date().toISOString(),
  apps: {},
  architecture: [],
};
await mkdir(out, { recursive: true });

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(file)));
    else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name)
    )
      files.push(file);
  }
  return files;
}

for (const app of apps) {
  const directory = path.join(root, "artifacts", app);
  for (const file of await sourceFiles(path.join(directory, "src"))) {
    const source = await readFile(file, "utf8");
    assert(
      !source.includes("meridianiq:operations:"),
      `Unscoped operation key in ${file}; use operationSessionKey`,
    );
    assert(
      !source.includes("state-catalogue"),
      `Development catalogue imported by production: ${file}`,
    );
    if (path.basename(file) !== "App.tsx" && path.basename(file) !== "main.tsx")
      continue;
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    for (const statement of ast.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        assert(
          !/(?:^|\/)pages\//.test(statement.moduleSpecifier.text),
          `Eager page import in ${file}: ${statement.moduleSpecifier.text}`,
        );
      }
    }
  }
  report.architecture.push(
    `${app}: no eager page imports in route entries, raw operation keys, or production catalogue references`,
  );
  const destination = bundleDirectory(root, app, options["use-built"]);
  if (!options["use-built"]) {
    const result = spawnSync(
      process.execPath,
      [
        vite,
        "build",
        "--configLoader",
        "runner",
        "--manifest",
        "--outDir",
        destination,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, NODE_ENV: "production" },
      },
    );
    await writeFile(
      path.join(out, `${app}.build.log`),
      result.stdout + result.stderr,
    );
    assert.equal(
      result.status,
      0,
      `${app} build failed; see ${out}/${app}.build.log`,
    );
  }
  // CI measures the same immutable bundles used by journeys and publication.
  // Missing manifests in --use-built mode fail; they never trigger a rebuild.
  report.apps[app] = await measureBundle(destination);
  console.log(
    `${app}: ${report.apps[app].eagerGzipBytes} eager gzip bytes; ${report.apps[app].dynamicEntries} lazy entries`,
  );
}
await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
if (!options["measure-only"]) {
  const budgets = JSON.parse(
    await readFile(path.join(here, "route-budgets.json"), "utf8"),
  );
  for (const app of apps) {
    assert(
      report.apps[app].eagerGzipBytes <= budgets[app].maxEagerGzipBytes,
      `${app} exceeds its eager gzip budget`,
    );
    assert(
      report.apps[app].dynamicEntries >= budgets[app].minDynamicEntries,
      `${app} lost lazy route entries`,
    );
  }
  console.log("Route architecture and measured bundle budgets passed.");
}
