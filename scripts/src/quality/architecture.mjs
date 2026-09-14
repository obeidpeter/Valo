import { buildImportGraph } from "./architecture-graph.mjs";
import { ROOT, sourceFiles } from "./shared.mjs";

const files = sourceFiles();
const { imports, cycles, violations } = buildImportGraph(ROOT, files);
const edges = [...imports.values()].reduce(
  (sum, targets) => sum + targets.length,
  0,
);
console.log(
  `Architecture check: ${files.length} source files, ${edges} resolved import edges (relative, aliases and workspace exports).`,
);
for (const cycle of cycles)
  console.error(`Cycle component: ${cycle.join(", ")}`);
for (const violation of violations) console.error(`Boundary: ${violation}`);
if (cycles.length || violations.length) {
  console.error(
    `Architecture check failed: ${cycles.length} cycle(s), ${violations.length} boundary violation(s).`,
  );
  process.exitCode = 1;
} else {
  console.log(
    "Architecture check passed: no import cycles or boundary violations.",
  );
}
