// Links every sibling deepseek-harness workspace package into this repo's
// node_modules, mirroring what a real profile install of the harness puts in
// its dependency tree. The host test surface relies on that layout: preset
// compositions resolve the plugins they name, and the roster's health check
// walks node_modules upward from the composition base (agent-presets
// discovery.ts packageInstalled). tsconfig facades cover typecheck; this
// covers the on-disk resolution the host tests still perform.
//
// It also provides the context-continuity engine, the other external plugin
// this bundle consumes, when the resolution is a sibling checkout
// (scripts/continuity-dir.mjs): the bundle imports
// `@wowyuarm/dsh-context-continuity` by name and must resolve exactly one copy
// of it. A clean checkout resolves the published package the package manager
// already installed instead, and then there is nothing to link.
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { continuityDir, continuityEntry, continuityFromSibling } from './continuity-dir.mjs'
import { harnessDir } from './harness-dir.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesRoot = join(harnessDir, 'packages')

// The first-level scope dir of a package.json name, or undefined.
const scopeOf = name => {
  const match = /^(@[^/]+)\//.exec(name)
  return match === null ? undefined : match[1]
}

let linked = 0
const linkPackage = (name, packageDir) => {
  const scope = scopeOf(name)
  if (scope === undefined) return
  const scopeRoot = join(repoRoot, 'node_modules', scope)
  mkdirSync(scopeRoot, { recursive: true })
  const target = join(scopeRoot, name.slice(scope.length + 1))
  if (existsSync(target)) return
  // node_modules/<scope>/<name> -> ../../../deepseek-harness/<packageDir>
  const relativeTarget = relative(scopeRoot, packageDir)
  if (process.platform === 'win32') {
    // Windows needs symlink privilege (admin or developer mode) for real
    // symlinks; directory junctions need none and behave the same for this
    // purpose. CI windows runners are admin, but junction keeps local
    // non-admin setups working too.
    symlinkSync(relativeTarget, target, 'junction')
  } else {
    symlinkSync(relativeTarget, target, 'dir')
  }
  linked += 1
}
for (const area of readdirSync(packagesRoot, { withFileTypes: true })) {
  if (!area.isDirectory()) continue
  const areaPath = join(packagesRoot, area.name)
  for (const entry of readdirSync(areaPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(areaPath, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    let name
    try { name = JSON.parse(readFileSync(manifestPath, 'utf8')).name } catch { continue }
    linkPackage(name, join(areaPath, entry.name))
  }
}
// The framework itself is vendored beside the workspace packages; the bundle
// lib imports @deepseek-ai/cordis (and friends) at runtime like a profile
// install would resolve them.
const vendorRoot = join(harnessDir, 'vendor')
if (existsSync(vendorRoot)) {
  for (const entry of readdirSync(vendorRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(vendorRoot, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    let name
    try { name = JSON.parse(readFileSync(manifestPath, 'utf8')).name } catch { continue }
    linkPackage(name, join(vendorRoot, entry.name))
  }
}
// The context-continuity engine: a sibling checkout is linked in by package
// name (scripts/continuity-dir.mjs owns which checkout), while an installed
// package is already where that name resolves. Either way the built entry must
// exist, so an unbuilt engine fails here rather than as a resolution error
// inside a test that has nothing to do with it.
if (!existsSync(continuityEntry)) {
  throw new Error(
    continuityFromSibling
      ? `The context-continuity engine at '${continuityDir}' has no built lib/index.js.`
        + ` Run 'npm run build' in that checkout, then rerun this script.`
      : `The installed context-continuity engine at '${continuityDir}' has no lib/index.js.`
        + ` Reinstall it (pnpm install), then rerun this script.`,
  )
}
if (continuityFromSibling) linkPackage('@wowyuarm/dsh-context-continuity', continuityDir)
// The bundle's own self-reference must resolve for preset rows that name it.
const selfRef = join(repoRoot, 'node_modules', '@contexera')
mkdirSync(selfRef, { recursive: true })
if (!existsSync(join(selfRef, 'dsh-agent-team'))) {
  if (process.platform === 'win32') {
    symlinkSync(relative(selfRef, repoRoot), join(selfRef, 'dsh-agent-team'), 'junction')
  } else {
    symlinkSync(relative(selfRef, repoRoot), join(selfRef, 'dsh-agent-team'), 'dir')
  }
  linked += 1
}
console.log(`linked ${linked} sibling packages into node_modules`)
