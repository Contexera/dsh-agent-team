#!/usr/bin/env node
// Stub ablation: keep an exported factory's signature but make its body throw,
// so the whole system still compiles and every runtime touchpoint fails loudly.
//
// Usage: node ablate-stub.mjs <repoDir> <srcRelFile> <fnName> <outJson>
//   srcRelFile is relative to src/ (e.g. "agents/orientation.ts"); fnName is an
//   exported function whose body should be replaced by a throw.
// Env:
//   ABLATION_BUILD_CMD  command that produces a runnable build (default "npm run build")
//   ABLATION_TEST_CMD   command that runs the full suite   (default "npm test")
// Each run happens in a throwaway git worktree (under the OS temp dir, path
// unique per repo and target); the caller's checkout is never touched.
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

if (process.argv.length !== 6) {
  console.error("Usage: node ablate-stub.mjs <repoDir> <srcRelFile> <fnName> <outJson>");
  process.exit(2);
}
const [repoDirRaw, srcRelFile, fnName, outJson] = process.argv.slice(2);
const repoDir = path.resolve(repoDirRaw);
const buildCmd = process.env.ABLATION_BUILD_CMD ?? "npm run build";
const testCmd = process.env.ABLATION_TEST_CMD ?? "npm test";
const repoTag = createHash("sha256").update(repoDir).digest("hex").slice(0, 8);
const slug = `stub__${repoTag}__${srcRelFile.replaceAll("/", "__")}`;
const worktrees = path.join(os.tmpdir(), "codebase-ablation");
const wt = path.join(worktrees, slug);

const fail = (json, stage, error) => {
  const result = { target: srcRelFile, function: fnName, mode: "stub", stage, error: String(error).slice(0, 4000), ...json };
  mkdirSync(path.dirname(outJson), { recursive: true });
  writeFileSync(outJson, JSON.stringify(result, null, 2));
  console.error(`[${slug}] failed at ${stage}: ${String(error).slice(0, 500)}`);
  cleanup();
  process.exit(1);
};

function cleanup() {
  try {
    execSync(`git worktree remove --force "${wt}"`, { cwd: repoDir, stdio: "ignore" });
  } catch {}
  try {
    execSync("git worktree prune", { cwd: repoDir, stdio: "ignore" });
  } catch {}
}

try {
  rmSync(wt, { recursive: true, force: true });
  mkdirSync(worktrees, { recursive: true });
  execSync("git worktree prune", { cwd: repoDir, stdio: "ignore" });
  try {
    execSync(`git worktree add --detach "${wt}" HEAD`, { cwd: repoDir, stdio: "ignore" });
  } catch {
    execSync("git worktree prune", { cwd: repoDir, stdio: "ignore" });
    execSync(`git worktree add --detach "${wt}" HEAD`, { cwd: repoDir, stdio: "ignore" });
  }
  if (!existsSync(wt)) throw new Error(`worktree missing after add: ${wt}`);
  const nm = path.join(repoDir, "node_modules");
  if (existsSync(nm)) symlinkSync(nm, path.join(wt, "node_modules"));
  // Same invariant as ablate-delete: compiled output must come from THIS run,
  // so drop any dist/ that a repo tracks in git before building.
  rmSync(path.join(wt, "dist"), { recursive: true, force: true });

  // 1. Insert a throw at the very start of the factory body.
  const file = path.join(wt, "src", srcRelFile);
  const text = readFileSync(file, "utf8");
  const fnNameRe = fnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sig = new RegExp(`export\\s+(?:async\\s+)?function\\s+${fnNameRe}\\b`);
  const m = text.match(sig);
  if (!m) fail({}, "edit", `export function ${fnName} not found in ${srcRelFile}`);
  let i = m.index + m[0].length;
  while (text[i] !== "(" && i < text.length) i += 1;
  let depth = 0;
  for (; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  // A return-type annotation may sit between the parameter list and the body
  // and can itself contain braces (`function makeBox(): { w: number } {`,
  // `| { b }`, `=> { … }`). A `{` at annotation depth 0 is part of the type
  // when it follows an operator or the `:` itself, and is the body brace when
  // it follows a complete type token (identifier, `)`, `]`, `}`, `>`).
  const typeCompleteBefore = (idx) => {
    let k = idx - 1;
    while (k >= 0 && /\s/.test(text[k])) k -= 1;
    const prev = text[k] ?? "";
    if (prev === ">" && text[k - 1] === "=") return false; // `=> { … }` return type
    return !"|&=,:<".includes(prev) && /[A-Za-z0-9_$)\]}>."']/.test(prev);
  };
  let j = i + 1;
  while (j < text.length && /\s/.test(text[j])) j += 1;
  if (text[j] === ":") {
    j += 1;
    let annDepth = 0;
    while (j < text.length) {
      const ch = text[j];
      if (ch === "(" || ch === "[" || ch === "<") annDepth += 1;
      else if (ch === ")" || ch === "]") annDepth -= 1;
      else if (ch === ">") annDepth -= 1;
      else if (ch === "{") {
        if (annDepth === 0 && typeCompleteBefore(j)) break; // body brace
        annDepth += 1;
      } else if (ch === "}") annDepth -= 1;
      j += 1;
    }
  }
  while (j < text.length && text[j] !== "{") j += 1;
  if (j >= text.length) fail({}, "edit", `function body brace not found for ${fnName} in ${srcRelFile}`);
  const marker = `[ablated] ${fnName} disabled by codebase-ablation`;
  const patched =
    text.slice(0, j + 1) + `\n  throw new Error(${JSON.stringify(marker)});` + text.slice(j + 1);
  writeFileSync(file, patched);

  // 2. Build via the project's own entrypoint.
  const build = spawnSync(buildCmd, { cwd: wt, shell: true, encoding: "utf8", timeout: 600_000 });
  if (build.status !== 0 || build.error) {
    fail({}, "build", (build.error ? String(build.error) : "") + (build.stderr ?? "") + (build.stdout ?? ""));
  }

  // 3. Sanity: the throw must exist in the compiled output. The check assumes
  // the default tsc-mirroring `dist/src/` layout; other layouts are recorded
  // as unverified rather than silently trusted.
  const distFile = path.join(wt, "dist", "src", srcRelFile.replace(/\.ts$/, ".js"));
  let markerVerified = false;
  if (existsSync(distFile)) {
    if (!readFileSync(distFile, "utf8").includes(marker)) {
      fail({}, "sanity", `marker missing from ${distFile}`);
    }
    markerVerified = true;
  } else {
    console.warn(`[${slug}] warning: marker check skipped — ${distFile} not found (non-default build layout); results recorded as markerVerified: false`);
  }

  // 4. Run the full suite via the project's own entrypoint.
  const run = spawnSync(testCmd, { cwd: wt, shell: true, encoding: "utf8", timeout: 1_800_000 });
  const out = (run.stdout ?? "") + (run.stderr ?? "");
  let tests = 0,
    pass = 0,
    failCount = 0;
  for (const mm of out.matchAll(/ℹ (tests|pass|fail)\s+(\d+)/g)) {
    if (mm[1] === "tests") tests = Number(mm[2]);
    if (mm[1] === "pass") pass = Number(mm[2]);
    if (mm[1] === "fail") failCount = Number(mm[2]);
  }
  const failures = [];
  let failureDetails = "";
  const failIdx = out.indexOf("✖ failing tests:");
  if (failIdx >= 0) {
    failureDetails = out.slice(failIdx, failIdx + 6000);
    let inFailures = false;
    for (const line of out.split("\n")) {
      if (line.startsWith("✖ failing tests:")) {
        inFailures = true;
        continue;
      }
      if (inFailures && line.startsWith("✖ ")) {
        failures.push(line.replace(/^✖\s+/, "").replace(/\s+\(\d+(\.\d+)?m?s\)$/, ""));
      }
    }
  }

  const result = {
    target: srcRelFile,
    function: fnName,
    mode: "stub",
    markerVerified,
    tests,
    pass,
    fail: failCount,
    testExitCode: run.status,
    failures,
    rawTail: out.slice(-2000),
    failureDetails,
  };
  mkdirSync(path.dirname(outJson), { recursive: true });
  writeFileSync(outJson, JSON.stringify(result, null, 2));
  console.log(`[${slug}] ${tests} tests ran, ${failCount} failed${markerVerified ? "" : " (marker unverified)"}`);
} catch (error) {
  fail({}, "setup/run", error);
} finally {
  cleanup();
}
