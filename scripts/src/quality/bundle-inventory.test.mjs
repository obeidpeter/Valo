import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  bundleDirectory,
  measureBundle,
} from "../e2e/state-catalogue/bundle-inventory.mjs";

function fixture(t) {
  const parent = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(parent, "bundle-inventory-test-"));
  t.after(() => {
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith("bundle-inventory-test-"));
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(path.join(directory, ".vite"));
  const manifest = {
    "index.html": {
      file: "entry.js",
      isEntry: true,
      imports: ["shared", "shared"],
      dynamicImports: ["route"],
    },
    shared: { file: "shared.js", imports: ["index.html"] },
    route: { file: "route.js", isDynamicEntry: true },
  };
  const save = () =>
    writeFileSync(
      path.join(directory, ".vite/manifest.json"),
      JSON.stringify(manifest),
    );
  for (const name of ["entry", "shared", "route"])
    writeFileSync(path.join(directory, `${name}.js`), name);
  save();
  return { directory, manifest, save };
}

test("measures existing entry/import bytes once, tolerates cycles and counts lazy entries separately", async (t) => {
  const f = fixture(t);
  const result = await measureBundle(f.directory);
  assert.equal(result.eagerBytes, Buffer.byteLength("entryshared"));
  assert.equal(
    result.eagerGzipBytes,
    gzipSync("entry").length + gzipSync("shared").length,
  );
  assert.equal(result.dynamicEntries, 1);
  assert.equal(result.chunks.length, 2);
  assert.equal(result.lazy[0].file, "route.js");
  assert.equal(
    bundleDirectory(f.directory, "sme-compliance", true),
    path.join(f.directory, "artifacts/sme-compliance/dist/public"),
  );
  assert.equal(
    bundleDirectory(f.directory, "sme-compliance", false),
    path.join(f.directory, "tmp/route-budget-r198/sme-compliance"),
  );
  assert.throws(
    () => bundleDirectory(f.directory, "../other", true),
    /invalid bundle application/,
  );
});

test("incomplete entry graphs or absent output fail instead of rebuilding", async (t) => {
  const f = fixture(t);
  f.manifest["index.html"].imports.push("missing");
  f.save();
  await assert.rejects(measureBundle(f.directory), /missing imported bundle/);
  f.manifest["index.html"].imports = "shared";
  f.save();
  await assert.rejects(measureBundle(f.directory), /invalid bundle imports/);
  f.manifest["index.html"].isEntry = false;
  f.save();
  await assert.rejects(measureBundle(f.directory), /no application entry/);
  f.manifest["index.html"].isEntry = true;
  f.manifest["index.html"].imports = [];
  f.save();
  rmSync(path.join(f.directory, "route.js"));
  await assert.rejects(measureBundle(f.directory), /ENOENT/);
  rmSync(path.join(f.directory, ".vite/manifest.json"));
  await assert.rejects(measureBundle(f.directory), /ENOENT/);
});

test("manifest paths cannot escape the output directory or traverse symlinks", async (t) => {
  const f = fixture(t);
  for (const name of [
    "../outside.js",
    "/absolute.js",
    "nested\\file.js",
    "./entry.js",
    "",
    ".vite",
  ]) {
    f.manifest["index.html"].file = name;
    f.save();
    await assert.rejects(
      measureBundle(f.directory),
      /invalid bundle file|escapes output|must be a file/,
    );
  }
  const linked = path.join(f.directory, "linked");
  symlinkSync(
    path.join(f.directory, ".vite"),
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  f.manifest["index.html"].file = "linked/manifest.json";
  f.save();
  await assert.rejects(measureBundle(f.directory), /symlink refused/);
});
