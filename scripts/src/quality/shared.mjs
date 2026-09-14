import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
export const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".mjs",
  ".cts",
  ".cjs",
  ".js",
  ".jsx",
]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".expo",
  ".turbo",
]);

export function workspaceFiles(roots = ["artifacts", "lib", "scripts"]) {
  const files = [];
  const visit = (absolute) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const target = join(absolute, entry.name);
      if (entry.isDirectory()) visit(target);
      else files.push(target);
    }
  };
  for (const root of roots) visit(join(ROOT, root));
  return files;
}

export function sourceFiles() {
  return workspaceFiles().filter((file) =>
    SOURCE_EXTENSIONS.has(extname(file)),
  );
}

export function displayPath(file) {
  return relative(ROOT, file).replaceAll("\\", "/");
}

export function readText(file) {
  return readFileSync(file, "utf8");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function isTextFile(file) {
  try {
    return (
      statSync(file).size <= 5_000_000 &&
      !readFileSync(file).subarray(0, 8000).includes(0)
    );
  } catch {
    return false;
  }
}
