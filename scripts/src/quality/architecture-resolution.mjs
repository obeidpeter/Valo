import { existsSync, readFileSync } from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import ts from "typescript";

const ASSET_EXTENSIONS = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".json",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp3",
  ".mp4",
  ".pdf",
  ".wasm",
  ".html",
  ".yaml",
  ".yml",
]);

export function importReferences(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = new Map();
  const add = (node, resolutionMode = ts.ModuleKind.ESNext) => {
    if (
      node &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    )
      found.set(`${resolutionMode}:${node.text}`, {
        specifier: node.text,
        resolutionMode,
      });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      add(node.moduleSpecifier);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      add(node.moduleReference.expression, ts.ModuleKind.CommonJS);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node.argument.literal);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    )
      add(
        node.arguments[0],
        node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? ts.ModuleKind.ESNext
          : ts.ModuleKind.CommonJS,
      );
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return [...found.values()];
}

export function importSpecifiers(file, source) {
  return [
    ...new Set(
      importReferences(file, source).map((reference) => reference.specifier),
    ),
  ];
}

function within(root, file) {
  const path = relative(root, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function nearest(root, from, name, cache) {
  let directory = dirname(from);
  const visited = [];
  let result = null;
  while (within(root, directory)) {
    if (cache.has(directory)) {
      result = cache.get(directory);
      break;
    }
    visited.push(directory);
    const candidate = join(directory, name);
    if (existsSync(candidate)) {
      result = candidate;
      break;
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  for (const directory of visited) cache.set(directory, result);
  return result;
}

function workspacePackages(root, files) {
  const locations = new Set();
  const packages = new Map();
  const cache = new Map();
  for (const file of files) {
    const manifest = nearest(root, file, "package.json", cache);
    if (manifest) locations.add(manifest);
  }
  for (const manifest of locations) {
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (!pkg.name?.startsWith("@workspace/")) continue;
    if (packages.has(pkg.name))
      throw new Error(`Duplicate workspace package ${pkg.name}`);
    packages.set(pkg.name, dirname(manifest));
  }
  return packages;
}

function matchesAlias(specifier, paths = {}) {
  return Object.keys(paths).some((pattern) => {
    const star = pattern.indexOf("*");
    return star < 0
      ? specifier === pattern
      : specifier.startsWith(pattern.slice(0, star)) &&
          specifier.endsWith(pattern.slice(star + 1));
  });
}

export function createImportResolver(root, files) {
  root = resolve(root);
  const packages = workspacePackages(root, files);
  const fileSet = new Map(files.map((file) => [canonical(file), file]));
  const configs = new Map();
  const nearestConfig = new Map();
  const resolutionCaches = new Map();

  // Present workspace source packages to TypeScript without depending on pnpm's
  // symlinks. TypeScript still owns exports, conditions, subpaths and extensions.
  const mapWorkspacePath = (file) => {
    const match = file
      .replaceAll("\\", "/")
      .match(/\/node_modules\/(@workspace\/[^/]+)(\/.*)?$/);
    const location = match && packages.get(match[1]);
    return location ? join(location, match[2] ?? "") : file;
  };
  const host = {
    ...ts.sys,
    fileExists: (file) => ts.sys.fileExists(mapWorkspacePath(file)),
    readFile: (file) => ts.sys.readFile(mapWorkspacePath(file)),
    directoryExists: (file) =>
      (packages.size > 0 &&
        /\/node_modules(?:\/@workspace)?$/.test(file.replaceAll("\\", "/"))) ||
      ts.sys.directoryExists(mapWorkspacePath(file)),
    realpath: (file) => normalize(mapWorkspacePath(file)),
  };
  function compilerOptions(from) {
    const config = nearest(root, from, "tsconfig.json", nearestConfig);
    if (!configs.has(config)) {
      let options = {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowJs: true,
        customConditions: ["workspace"],
      };
      if (config) {
        const parsed = ts.getParsedCommandLineOfConfigFile(
          config,
          {},
          {
            ...host,
            getCurrentDirectory: () => root,
            onUnRecoverableConfigFileDiagnostic: (error) => {
              throw new Error(
                ts.flattenDiagnosticMessageText(error.messageText, "\n"),
              );
            },
          },
        );
        const errors =
          parsed?.errors.filter(
            (error) => ![18002, 18003].includes(error.code),
          ) ?? [];
        if (errors.length)
          throw new Error(
            `${config}: ${ts.flattenDiagnosticMessageText(errors[0].messageText, "\n")}`,
          );
        options = { ...options, ...parsed?.options };
      }
      configs.set(config, options);
      resolutionCaches.set(
        config,
        ts.createModuleResolutionCache(root, canonical, options),
      );
    }
    return {
      options: configs.get(config),
      cache: resolutionCaches.get(config),
    };
  }

  return (from, specifier, resolutionMode = ts.ModuleKind.ESNext) => {
    const { options, cache } = compilerOptions(from);
    const resolved = ts.resolveModuleName(
      specifier,
      from,
      options,
      host,
      cache,
      undefined,
      resolutionMode,
    ).resolvedModule;
    const target =
      resolved &&
      fileSet.get(canonical(mapWorkspacePath(resolved.resolvedFileName)));
    if (target) return { target };
    const local =
      specifier.startsWith(".") ||
      specifier.startsWith("#") ||
      specifier.startsWith("@workspace/") ||
      matchesAlias(specifier, options.paths);
    // Styles, data and media are not source-graph edges. A missing local source
    // import must fail rather than silently opening a hole in cycle detection.
    const extension = extname(specifier);
    const asset = ASSET_EXTENSIONS.has(extension);
    return { target: null, unresolved: local && !asset ? specifier : null };
  };
}

function canonical(file) {
  const normalized = normalize(file);
  return ts.sys.useCaseSensitiveFileNames
    ? normalized
    : normalized.toLowerCase();
}
