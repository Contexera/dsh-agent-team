// Static import graph over src/ and test/ for ablation experiments.
// Only relative imports matter; package imports are ignored.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const TS_FILE_RE = /\.[cm]?tsx?$/; // .ts .tsx .mts .cts
const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

export function listTsFiles(rootDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (TS_FILE_RE.test(entry.name)) out.push(full);
    }
  };
  walk(rootDir);
  return out;
}

function statSyncSafe(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// Resolve a relative import specifier to a source file, covering
// extensionless specs, TS-extension specs, .js/.mjs/.cjs compile-output
// specs, and directory index files.
function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  let stems;
  if (/\.js$/.test(spec)) stems = [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx"];
  else if (/\.mjs$/.test(spec)) stems = [base.slice(0, -4) + ".mts"];
  else if (/\.cjs$/.test(spec)) stems = [base.slice(0, -4) + ".cts"];
  else if (TS_EXTENSIONS.some((e) => spec.endsWith(e))) stems = [base];
  else stems = TS_EXTENSIONS.map((e) => base + e);
  const candidates = [...stems, ...stems.map((s) => path.join(s, "index.ts")), ...stems.map((s) => path.join(s, "index.tsx"))];
  for (const c of candidates) {
    if (statSyncSafe(c)) return c;
  }
  return null;
}

// Returns { files: Map<absPath, string[] deps>, roots: { src, test } }
export function buildGraph(rootDir) {
  rootDir = path.resolve(rootDir);
  const srcRoot = path.join(rootDir, "src");
  if (!existsSync(srcRoot)) {
    throw new Error(`no src/ directory under ${rootDir} (the resolver assumes a src/ + test/ TypeScript layout)`);
  }
  const testRoot = path.join(rootDir, "test");
  const files = new Map(); // abs -> deps[]
  const add = (abs) => {
    const text = readFileSync(abs, "utf8");
    const specs = [];
    for (const m of text.matchAll(/from\s*["']([^"']+)["']/g)) specs.push(m[1]);
    for (const m of text.matchAll(/import\s*["']([^"']+)["']/g)) specs.push(m[1]);
    for (const m of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
    const deps = [];
    for (const spec of specs) {
      const resolved = resolveImport(abs, spec);
      if (resolved) deps.push(resolved);
    }
    files.set(abs, deps);
  };
  for (const f of listTsFiles(srcRoot)) add(f);
  if (existsSync(testRoot)) for (const f of listTsFiles(testRoot)) add(f);
  return { files, rootDir };
}

// All files (src or test) that transitively import anything in `targets`.
export function reverseClosure(graph, targets) {
  const targetSet = new Set(targets);
  const importers = new Map(); // dep -> [importers]
  for (const [file, deps] of graph.files) {
    for (const dep of deps) {
      if (!importers.has(dep)) importers.set(dep, []);
      importers.get(dep).push(file);
    }
  }
  const removed = new Set(targetSet);
  const queue = [...targetSet];
  while (queue.length > 0) {
    const cur = queue.pop();
    for (const imp of importers.get(cur) ?? []) {
      if (!removed.has(imp)) {
        removed.add(imp);
        queue.push(imp);
      }
    }
  }
  return [...removed].sort();
}
