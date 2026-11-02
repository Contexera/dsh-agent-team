#!/usr/bin/env node
// Deletion ablation: remove a target (dir or file under src/) plus its reverse
// dependency closure (src + test), build the remainder, run surviving tests.
//
// Usage: node ablate-delete.mjs <repoDir> <targetRel> <outJson>
//   targetRel is a directory or file path relative to src/ (e.g. "runtime",
//   "channels/raft", "channels/raft.ts" — the file form needs its extension;
//   a bare stem without extension is also tried against .ts/.tsx/.mts/.cts).
// Env:
//   ABLATION_BUILD_CMD  command that produces a runnable build (default "npm run build")
//   ABLATION_TEST_CMD   command that runs the full suite   (default "npm test")
// Each run happens in a throwaway git worktree (under the OS temp dir, path
// unique per repo and target); the caller's checkout is never touched.
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { buildGraph, reverseClosure, listTsFiles } from "./graph.mjs";

if (process.argv.length !== 5) {
  console.error("Usage: node ablate-delete.mjs <repoDir> <targetRel> <outJson>");
  process.exit(2);
}
const [repoDirRaw, targetRel, outJson] = process.argv.slice(2);
const repoDir = path.resolve(repoDirRaw);
const buildCmd = process.env.ABLATION_BUILD_CMD ?? "npm run build";
const testCmd = process.env.ABLATION_TEST_CMD ?? "npm test";
const repoTag = createHash("sha256").update(repoDir).digest("hex").slice(0, 8);
const slug = `${repoTag}__${targetRel.replaceAll("/", "__")}`;
const worktrees = path.join(os.tmpdir(), "codebase-ablation");
const wt = path.join(worktrees, slug);

const fail = (json, stage, error) => {
  const result = { target: targetRel, mode: "deletion", stage, error: String(error).slice(0, 4000), ...json };
  mkdirSync(path.dirname(outJson), { recursive: true });
  writeFileSync(outJson, JSON.stringify(result, null, 2));
  console.error(`[${targetRel}] failed at ${stage}: ${String(error).slice(0, 400)}`);
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
  // The build/partial logic assumes all compiled output came from THIS run;
  // a repo that tracks its dist/ in git would otherwise leak stale
  // pre-ablation artifacts into the worktree and the measurement.
  rmSync(path.join(wt, "dist"), { recursive: true, force: true });

  // 1. Closure from the worktree's own graph.
  const graph = buildGraph(wt);
  const srcTarget = path.join(wt, "src", targetRel);
  let targets;
  try {
    targets = listTsFiles(srcTarget);
  } catch {
    if (existsSync(srcTarget)) targets = [srcTarget];
    else targets = [".ts", ".tsx", ".mts", ".cts"].map((e) => srcTarget + e).filter((p) => existsSync(p));
  }
  if (targets.length === 0) throw new Error(`no target files under src/${targetRel}`);
  const closure = reverseClosure(graph, targets);
  const rel = (p) => path.relative(wt, p);
  const removedSrc = closure.filter((p) => rel(p).startsWith("src/"));
  const removedTest = closure.filter((p) => rel(p).startsWith("test/"));

  // 2. Delete the collapse set.
  for (const f of closure) rmSync(f);

  // 3. Build via the project's own entrypoint. Ablation legitimately deletes
  // source files, so build post-steps may reference artifacts that no longer
  // exist (e.g. `chmod dist/cli.js` after cli.ts was ablated away). The
  // worktree is freshly created, so any compiled test output came from THIS
  // build: if it exists, treat the build as partial and measure; a missing
  // compiled output is the only real build failure.
  let buildOk = "full";
  let buildError = "";
  const build = spawnSync(buildCmd, { cwd: wt, shell: true, encoding: "utf8", timeout: 600_000 });
  if (build.status !== 0 || build.error) {
    buildError = ((build.stdout ?? "") + (build.stderr ?? "")).slice(-4000);
    if (!existsSync(path.join(wt, "dist", "test"))) {
      fail(
        {
          removedSrcCount: removedSrc.length,
          removedTestCount: removedTest.length,
          buildOk: false,
          buildError,
        },
        "build",
        `build failed with no compiled test output: ${(build.error ? String(build.error) : buildError).slice(0, 300)}`,
      );
    }
    buildOk = "partial";
  }

  // 4. Run surviving tests via the project's own entrypoint.
  let tests = 0,
    pass = 0,
    failCount = 0,
    failures = [],
    failureDetails = "",
    testExit = null;
  const run = spawnSync(testCmd, { cwd: wt, shell: true, encoding: "utf8", timeout: 1_800_000 });
  const out = (run.stdout ?? "") + (run.stderr ?? "");
  testExit = run.status;
  for (const m of out.matchAll(/ℹ (tests|pass|fail)\s+(\d+)/g)) {
    if (m[1] === "tests") tests = Number(m[2]);
    if (m[1] === "pass") pass = Number(m[2]);
    if (m[1] === "fail") failCount = Number(m[2]);
  }
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

  // Contract: TEST_CMD must run the suite against the CURRENT worktree state,
  // without rebuilding. If it wiped the compiled output (its embedded build
  // ran `clean` and failed, e.g. on a post-step referencing an ablated file),
  // no measurement is possible — fail telling the caller how to fix it.
  if (testExit !== 0 && tests === 0 && failCount === 0 && !existsSync(path.join(wt, "dist", "test"))) {
    fail(
      { removedSrcCount: removedSrc.length, removedTestCount: removedTest.length, testContractViolation: true },
      "test",
      `ABLATION_TEST_CMD rebuilt the tree and failed before running tests (dist/test was wiped). ` +
        `Pass a buildless test command, e.g. ABLATION_TEST_CMD='node --test "dist/test/**/*.test.js"'.`,
    );
  }

  const result = {
    target: targetRel,
    mode: "deletion",
    buildOk,
    buildError,
    removedSrcCount: removedSrc.length,
    removedTestCount: removedTest.length,
    removedSrc: removedSrc.map(rel),
    removedTest: removedTest.map(rel),
    tests,
    pass,
    fail: failCount,
    testExitCode: testExit,
    failures,
    // Non-node:test frameworks: read this instead of the parsed counters.
    rawTail: out.slice(-2000),
    failureDetails,
  };
  mkdirSync(path.dirname(outJson), { recursive: true });
  writeFileSync(outJson, JSON.stringify(result, null, 2));
  const summary =
    tests > 0 || failCount > 0
      ? `${tests} tests ran, ${failCount} failed`
      : `suite exit=${testExit} (no node:test summary parsed — see rawTail in the JSON)`;
  console.log(`[${targetRel}] removed ${removedSrc.length} src / ${removedTest.length} test files; ${summary}`);
} catch (error) {
  fail({}, "setup/run", error);
} finally {
  cleanup();
}
