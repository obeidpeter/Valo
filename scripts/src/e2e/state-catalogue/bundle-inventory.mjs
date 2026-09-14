import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

export function bundleDirectory(root, app, useBuilt) {
  assert.match(app, /^[a-z]+(?:-[a-z]+)*$/, "invalid bundle application");
  return useBuilt
    ? path.join(root, "artifacts", app, "dist/public")
    : path.join(root, "tmp/route-budget-r198", app);
}

async function readBundleFile(directory, file) {
  const root = await lstat(directory);
  assert.ok(
    root.isDirectory() && !root.isSymbolicLink(),
    "bundle output must be a real directory",
  );
  assert.ok(
    typeof file === "string" &&
      file.length > 0 &&
      !file.includes("\\") &&
      !path.isAbsolute(file),
    "invalid bundle file",
  );
  let target = directory;
  for (const part of file.split("/")) {
    assert.ok(
      part && part !== "." && part !== "..",
      "bundle file escapes output directory",
    );
    target = path.join(target, part);
    assert.ok(
      !(await lstat(target)).isSymbolicLink(),
      "bundle symlink refused",
    );
  }
  assert.ok((await lstat(target)).isFile(), "bundle entry must be a file");
  return readFile(target);
}

export async function measureBundle(directory) {
  const manifest = JSON.parse(
    (await readBundleFile(directory, ".vite/manifest.json")).toString("utf8"),
  );
  assert.ok(
    manifest && typeof manifest === "object" && !Array.isArray(manifest),
    "invalid Vite bundle manifest",
  );
  const closure = new Set();
  function visit(key) {
    if (closure.has(key)) return;
    assert.ok(Object.hasOwn(manifest, key), `missing imported bundle: ${key}`);
    closure.add(key);
    const imports = manifest[key].imports ?? [];
    assert.ok(
      Array.isArray(imports) &&
        imports.every((name) => typeof name === "string"),
      "invalid bundle imports",
    );
    for (const imported of imports) visit(imported);
  }
  const entries = Object.entries(manifest).filter(
    ([, chunk]) => chunk.isEntry === true,
  );
  assert.ok(entries.length > 0, "Vite manifest has no application entry");
  entries.forEach(([key]) => visit(key));
  const chunks = await Promise.all(
    [...closure].map(async (key) => {
      const bytes = await readBundleFile(directory, manifest[key].file);
      return {
        source: key,
        file: manifest[key].file,
        bytes: bytes.length,
        gzipBytes: gzipSync(bytes).length,
      };
    }),
  );
  const lazy = await Promise.all(
    Object.entries(manifest)
      .filter(([, chunk]) => chunk.isDynamicEntry === true)
      .map(async ([key, chunk]) => {
        await readBundleFile(directory, chunk.file);
        return { source: key, file: chunk.file };
      }),
  );
  return {
    eagerBytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
    eagerGzipBytes: chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
    dynamicEntries: lazy.length,
    chunks,
    lazy,
  };
}
