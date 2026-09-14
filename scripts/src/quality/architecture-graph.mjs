import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  createImportResolver,
  importReferences,
} from "./architecture-resolution.mjs";

const browser =
  /^artifacts\/(?:landing|console|sme-compliance|buyer-portal|penalty-calculator|mobile)\//;
const server =
  /^(?:lib\/db\/|artifacts\/api-server\/|lib\/integrations-openai-ai-server\/)/;
const provider = "artifacts/api-server/src/modules/clerk/provider.ts";
const modelPackage = "lib/integrations-openai-ai-server/";

export function buildImportGraph(root, sourceFiles) {
  root = resolve(root);
  const files = sourceFiles.map((file) => resolve(file));
  const resolveImport = createImportResolver(root, files);
  const display = (file) => relative(root, file).replaceAll("\\", "/");
  const imports = new Map();
  const violations = new Set();
  for (const file of files) {
    const name = display(file);
    const targets = new Set();
    for (const { specifier, resolutionMode } of importReferences(
      file,
      readFileSync(file, "utf8"),
    )) {
      const { target, unresolved } = resolveImport(
        file,
        specifier,
        resolutionMode,
      );
      if (target) targets.add(target);
      if (unresolved)
        violations.add(`${name}: unresolved local source import ${specifier}`);
      if (
        browser.test(name) &&
        /^@workspace\/(?:db|api-server|integrations-openai-ai-server)(?:\/|$)/.test(
          specifier,
        )
      )
        violations.add(
          `${name}: browser/mobile code imports server-only package ${specifier}`,
        );
      if (
        (/^@workspace\/integrations-openai-ai-server(?:\/|$)/.test(specifier) ||
          (target && display(target).startsWith(modelPackage))) &&
        name !== provider &&
        !name.startsWith(modelPackage)
      )
        violations.add(
          `${name}: model SDK access must go through modules/clerk/provider.ts`,
        );
    }
    imports.set(file, [...targets]);
  }
  for (const file of files) {
    const name = display(file);
    if (browser.test(name)) {
      const path = pathTo(imports, file, (target) =>
        server.test(display(target)),
      );
      if (path)
        violations.add(
          `${name}: browser/mobile dependency reaches server-only source: ${path.map(display).join(" -> ")}`,
        );
    }
    const production =
      !/\.(?:test|spec)\.[^.]+$/.test(name) &&
      !/\/test-support\.[^.]+$/.test(name);
    if (production && name.startsWith("artifacts/api-server/src/modules/")) {
      const path = pathTo(imports, file, (target) =>
        display(target).startsWith("artifacts/api-server/src/routes/"),
      );
      if (path)
        violations.add(
          `${name}: domain module imports HTTP route: ${path.map(display).join(" -> ")}`,
        );
    }
  }
  return {
    imports,
    violations: [...violations].sort(),
    cycles: findCycles(imports).map((cycle) => cycle.map(display).sort()),
  };
}

function pathTo(graph, start, matches) {
  const parents = new Map([[start, null]]);
  const queue = [start];
  for (let index = 0; index < queue.length; index++) {
    const file = queue[index];
    for (const target of graph.get(file) ?? []) {
      if (parents.has(target)) continue;
      parents.set(target, file);
      if (matches(target)) {
        const path = [target];
        let parent = file;
        while (parent !== null) {
          path.push(parent);
          parent = parents.get(parent);
        }
        return path.reverse();
      }
      queue.push(target);
    }
  }
  return null;
}

export function findCycles(imports) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indexes = new Map();
  const lowLinks = new Map();
  const cycles = [];
  function strongConnect(file) {
    indexes.set(file, index);
    lowLinks.set(file, index++);
    stack.push(file);
    onStack.add(file);
    for (const dependency of imports.get(file) ?? []) {
      if (!indexes.has(dependency)) {
        strongConnect(dependency);
        lowLinks.set(
          file,
          Math.min(lowLinks.get(file), lowLinks.get(dependency)),
        );
      } else if (onStack.has(dependency)) {
        lowLinks.set(
          file,
          Math.min(lowLinks.get(file), indexes.get(dependency)),
        );
      }
    }
    if (lowLinks.get(file) !== indexes.get(file)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== file);
    if (component.length > 1 || (imports.get(file) ?? []).includes(file))
      cycles.push(component);
  }
  for (const file of imports.keys())
    if (!indexes.has(file)) strongConnect(file);
  return cycles;
}
