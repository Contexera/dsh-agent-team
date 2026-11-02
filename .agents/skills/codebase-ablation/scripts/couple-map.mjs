#!/usr/bin/env node
// Static coupling map: for every src file and module, direct fan-in and the
// size of the reverse-dependency closure (who must go with it). No builds.
// Usage: node couple-map.mjs <repoDir> <outJson>
import { writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { buildGraph, reverseClosure, listTsFiles } from "./graph.mjs";

const [repoDir, outJson] = process.argv.slice(2);
if (process.argv.length !== 4) {
  console.error("Usage: node couple-map.mjs <repoDir> <outJson>");
  process.exit(2);
}
let graph;
try {
  graph = buildGraph(repoDir);
} catch (e) {
  console.error(
    `couple-map: ${e.message}.\n` +
      `For other layouts, adapt scripts/graph.mjs first (see references/other-languages.md).`,
  );
  process.exit(1);
}
const rel = (p) => path.relative(repoDir, p);
const srcFiles = [...graph.files.keys()].filter((f) => rel(f).startsWith("src/"));
if (srcFiles.length === 0) {
  console.error(
    `couple-map: no TypeScript files found under ${path.join(path.resolve(repoDir), "src")}.\n` +
      `For other layouts, adapt scripts/graph.mjs first (see references/other-languages.md).`,
  );
  process.exit(1);
}

const directFanIn = (targetSet) => {
  const set = new Set(targetSet);
  const out = [];
  for (const [file, deps] of graph.files) {
    if (set.has(file)) continue;
    if (deps.some((d) => set.has(d))) out.push(file);
  }
  return out;
};

const fileRows = srcFiles.map((f) => {
  const closure = reverseClosure(graph, [f]);
  const fanInSrc = directFanIn([f]).filter((x) => rel(x).startsWith("src/"));
  const fanInTest = directFanIn([f]).filter((x) => rel(x).startsWith("test/"));
  const forwardDeps = new Set(graph.files.get(f) ?? []);
  return {
    file: rel(f),
    fanInSrc: fanInSrc.length,
    fanInTest: fanInTest.length,
    closureSize: closure.length,
    closureSrc: closure.filter((p) => rel(p).startsWith("src/")).length,
    forwardDeps: forwardDeps.size,
  };
});

const moduleNames = readdirSync(path.join(repoDir, "src"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

const moduleRows = moduleNames.map((mod) => {
  const targets = srcFiles.filter((f) => rel(f).startsWith(`src/${mod}/`));
  const closure = reverseClosure(graph, targets);
  const fanIn = directFanIn(targets);
  return {
    module: mod,
    files: targets.length,
    directFanInSrc: fanIn.filter((x) => rel(x).startsWith("src/")).length,
    directFanInTest: fanIn.filter((x) => rel(x).startsWith("test/")).length,
    closureSize: closure.length,
    closureSrc: closure.filter((p) => rel(p).startsWith("src/")).length,
    closureTest: closure.filter((p) => rel(p).startsWith("test/")).length,
  };
});

fileRows.sort((a, b) => b.closureSize - a.closureSize || b.fanInSrc - a.fanInSrc);
moduleRows.sort((a, b) => b.closureSize - a.closureSize);
mkdirSync(path.dirname(outJson), { recursive: true });
writeFileSync(outJson, JSON.stringify({ files: fileRows, modules: moduleRows }, null, 2));
console.log(moduleRows
  .map((r) => `${r.module}: files=${r.files} srcFanIn=${r.directFanInSrc} testFanIn=${r.directFanInTest} closure=${r.closureSize} (src ${r.closureSrc} / test ${r.closureTest})`)
  .join("\n"));
