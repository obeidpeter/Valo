import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { buildImportGraph, findCycles } from "./architecture-graph.mjs";
import {
  createImportResolver,
  importSpecifiers,
} from "./architecture-resolution.mjs";

function fixture(t, entries) {
  const root = mkdtempSync(join(tmpdir(), "valo-architecture-"));
  t.after(() => {
    assert.ok(
      resolve(root).startsWith(resolve(tmpdir()) + "/") ||
        resolve(root).startsWith(resolve(tmpdir()) + "\\"),
    );
    rmSync(root, { recursive: true, force: true });
  });
  const files = [];
  for (const [name, value] of Object.entries(entries)) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      typeof value === "string" ? value : JSON.stringify(value),
    );
    if (/\.(?:[cm]?[jt]sx?)$/.test(name)) files.push(file);
  }
  return { root, files, graph: () => buildImportGraph(root, files) };
}

test("AST discovery includes real ESM, type, CommonJS and lazy imports, not comments or examples", () => {
  const source = [
    'import { x } from "./static";',
    'export * from "./barrel";',
    'import type { A } from "./types";',
    'type B = import("./inline-type").B;',
    'import legacy = require("./legacy");',
    'const dependency = require("./commonjs.cjs");',
    "const lazy = import(`./lazy`);",
    '// import { bad } from "./comment";',
    '/* export * from "./block-comment"; */',
    "const example = 'import { bad } from \"./example\";';",
    'const computed = import("./" + name);',
  ].join("\n");
  assert.deepEqual(importSpecifiers("fixture.ts", source), [
    "./static",
    "./barrel",
    "./types",
    "./inline-type",
    "./legacy",
    "./commonjs.cjs",
    "./lazy",
  ]);
});

test("per-app aliases, inherited configs, index files and emitted JS extensions resolve to source", (t) => {
  const f = fixture(t, {
    "tsconfig.base.json": {
      compilerOptions: { module: "esnext", moduleResolution: "bundler" },
    },
    "artifacts/console/tsconfig.json": {
      extends: "../../tsconfig.base.json",
      compilerOptions: { paths: { "@/*": ["./src/*"] } },
    },
    "artifacts/mobile/tsconfig.json": {
      extends: "../../tsconfig.base.json",
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } },
    },
    "artifacts/console/src/a.ts": 'export { b } from "@/b";',
    "artifacts/console/src/b/index.ts": 'export { a } from "../a.js";',
    "artifacts/mobile/app/a.ts": 'export { b } from "@/lib/b";',
    "artifacts/mobile/lib/b.ts": "export const b = 1;",
  });
  const graph = f.graph();
  assert.equal(graph.violations.length, 0);
  assert.deepEqual(graph.cycles, [
    ["artifacts/console/src/a.ts", "artifacts/console/src/b/index.ts"],
  ]);
  assert.deepEqual(
    graph.imports.get(join(f.root, "artifacts/mobile/app/a.ts")),
    [join(f.root, "artifacts/mobile/lib/b.ts")],
  );
});

test("workspace exports and wildcard subpaths expose cross-package cycles without installed symlinks", (t) => {
  const f = fixture(t, {
    "lib/first/package.json": {
      name: "@workspace/first",
      type: "module",
      exports: {
        ".": { workspace: "./src/index.ts", default: "./src/fallback.ts" },
        "./features/*": "./src/features/*.ts",
      },
    },
    "lib/first/src/index.ts": 'export * from "@workspace/second";',
    "lib/first/src/fallback.ts": "export const fallback = true;",
    "lib/first/src/features/back.ts": 'export * from "@workspace/first";',
    "lib/second/package.json": {
      name: "@workspace/second",
      type: "module",
      exports: { ".": "./src/index.ts" },
    },
    "lib/second/src/index.ts":
      'export * from "@workspace/first/features/back";',
  });
  const graph = f.graph();
  assert.deepEqual(graph.violations, []);
  assert.deepEqual(graph.cycles, [
    [
      "lib/first/src/features/back.ts",
      "lib/first/src/index.ts",
      "lib/second/src/index.ts",
    ],
  ]);
});

test("private or missing source subpaths and aliases fail instead of disappearing from the graph", (t) => {
  const f = fixture(t, {
    "tsconfig.json": { compilerOptions: { paths: { "@/*": ["./src/*"] } } },
    "src/page.ts":
      'import "@workspace/one/private"; import "@/missing"; import "./missing.js"; import "@workspace/one/missing.entry"; import "./style.css";',
    "lib/one/package.json": {
      name: "@workspace/one",
      exports: { ".": "./src/index.ts" },
    },
    "lib/one/src/index.ts": "export {};",
    "lib/one/private.ts": "export {};",
  });
  const graph = f.graph();
  assert.equal(graph.violations.length, 4);
  for (const name of [
    "@workspace/one/private",
    "@/missing",
    "./missing.js",
    "@workspace/one/missing.entry",
  ])
    assert.ok(
      graph.violations.some((message) => message.endsWith(`import ${name}`)),
    );
});

test("browser imports cannot reach database code through a shared barrel or an alias", (t) => {
  const f = fixture(t, {
    "artifacts/console/tsconfig.json": {
      compilerOptions: {
        paths: {
          "@/*": ["./src/*"],
          "secret-db": ["../../lib/db/src/index.ts"],
        },
      },
    },
    "artifacts/console/src/page.ts":
      'import "@workspace/bridge"; import "secret-db";',
    "lib/bridge/package.json": {
      name: "@workspace/bridge",
      exports: "./src/index.ts",
    },
    "lib/bridge/src/index.ts": 'export * from "@workspace/db/schema";',
    "lib/db/package.json": {
      name: "@workspace/db",
      exports: { ".": "./src/index.ts", "./schema": "./src/schema.ts" },
    },
    "lib/db/src/index.ts": "export {};",
    "lib/db/src/schema.ts": "export {};",
  });
  assert.ok(
    f
      .graph()
      .violations.some((message) =>
        /browser\/mobile dependency reaches server-only source/.test(message),
      ),
  );
});

test("domain-to-route aliases and indirect imports remain prohibited", (t) => {
  const f = fixture(t, {
    "artifacts/api-server/tsconfig.json": {
      compilerOptions: { paths: { "@/*": ["./src/*"] } },
    },
    "artifacts/api-server/src/modules/example/service.ts":
      'import "@/lib/bridge";',
    "artifacts/api-server/src/lib/bridge.ts":
      'export * from "@/routes/example";',
    "artifacts/api-server/src/routes/example.ts": "export {};",
  });
  assert.ok(
    f
      .graph()
      .violations.some(
        (message) =>
          message.includes("domain module imports HTTP route") &&
          message.includes("lib/bridge.ts"),
      ),
  );
});

test("only the provider can cross into the model SDK package, including relative paths", (t) => {
  const f = fixture(t, {
    "lib/integrations-openai-ai-server/package.json": {
      name: "@workspace/integrations-openai-ai-server",
      exports: "./src/index.ts",
    },
    "lib/integrations-openai-ai-server/src/index.ts":
      'export * from "./client";',
    "lib/integrations-openai-ai-server/src/client.ts": "export {};",
    "artifacts/api-server/src/modules/clerk/provider.ts":
      'import "@workspace/integrations-openai-ai-server";',
    "lib/bypass/src/index.ts":
      'import "../../integrations-openai-ai-server/src/client";',
  });
  const violations = f.graph().violations;
  assert.equal(violations.length, 1);
  assert.match(
    violations[0],
    /^lib\/bypass\/src\/index.ts: model SDK access must go through/,
  );
});

test("explicit CommonJS extensions and type-only imports remain part of cycle detection", (t) => {
  const f = fixture(t, {
    "src/a.cjs": 'require("./b/index.cjs");',
    "src/b/index.cts": 'import type { A } from "../a.cjs";',
  });
  const graph = f.graph();
  assert.deepEqual(graph.violations, []);
  assert.equal(graph.cycles.length, 1);
});

test("import and require select their respective conditional workspace exports", (t) => {
  const f = fixture(t, {
    "src/consumer.ts":
      'import "@workspace/dual"; const cjs = require("@workspace/dual");',
    "lib/dual/package.json": {
      name: "@workspace/dual",
      exports: {
        ".": { import: "./src/import.ts", require: "./src/require.cts" },
      },
    },
    "lib/dual/src/import.ts": "export {};",
    "lib/dual/src/require.cts": "export {};",
  });
  const graph = f.graph();
  assert.deepEqual(graph.violations, []);
  assert.deepEqual(graph.imports.get(join(f.root, "src/consumer.ts")), [
    join(f.root, "lib/dual/src/import.ts"),
    join(f.root, "lib/dual/src/require.cts"),
  ]);
});

test("self cycles are rejected while unrelated external packages and assets stay outside the graph", (t) => {
  const f = fixture(t, {
    "src/a.ts":
      'export * from "./a"; import "react"; import "node:fs"; import "./logo.svg";',
  });
  assert.deepEqual(f.graph().cycles, [["src/a.ts"]]);
  assert.deepEqual(f.graph().violations, []);
  assert.deepEqual(
    findCycles(
      new Map([
        ["a", ["b"]],
        ["b", []],
      ]),
    ),
    [],
  );
});

test("malformed alias configuration is a gate failure, not an ignored resolution error", (t) => {
  const f = fixture(t, {
    "tsconfig.json": {
      compilerOptions: { moduleResolution: "not-a-resolution-mode" },
    },
    "src/a.ts": 'import "./b";',
    "src/b.ts": "export {};",
  });
  assert.throws(
    () =>
      createImportResolver(f.root, f.files)(join(f.root, "src/a.ts"), "./b"),
    /moduleResolution/,
  );
});
