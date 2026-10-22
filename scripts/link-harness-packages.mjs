// Links every sibling deepseek-harness workspace package into this repo's
// node_modules, mirroring what a real profile install of the harness puts in
// its dependency tree. The host test surface relies on that layout: preset
// compositions resolve the plugins they name, and the roster's health check
// walks node_modules upward from the composition base (agent-presets
// discovery.ts packageInstalled). tsconfig facades cover typecheck; this
// covers the on-disk resolution the host tests still perform.
//
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { harnessDir } from './harness-dir.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesRoot = join(harnessDir, 'packages')

const scopeOf = name => {
  const match = /^(@[^/]+)\//.exec(name)
  return match === null ? undefined : match[1]
}

let linked = 0

// Replace a link left by an earlier harness layout: it dangles, so existsSync
// follows it and reports false; without this the create below fails EEXIST on
// a rerun. A healthy link resolves and is left alone. A win32 junction is
// reported as a symlink by lstat but is a directory reparse point, which
// unlink cannot remove.
const removeStaleLink = target => {
  if (existsSync(target)) return
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() !== true) return
  if (process.platform === 'win32') rmdirSync(target)
  else unlinkSync(target)
}

const linkPackage = (name, packageDir) => {
  const scope = scopeOf(name)
  if (scope === undefined) return
  const scopeRoot = join(repoRoot, 'node_modules', scope)
  mkdirSync(scopeRoot, { recursive: true })
  const target = join(scopeRoot, name.slice(scope.length + 1))
  if (existsSync(target)) return
  removeStaleLink(target)
  // node_modules/<scope>/<name> -> ../../../deepseek-harness/<packageDir>
  const relativeTarget = relative(scopeRoot, packageDir)
  if (process.platform === 'win32') {
    // Real symlinks need symlink privilege on Windows; directory junctions need none and behave
    // the same here.
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
// The bundle's own self-reference must resolve for preset rows that name it.
const selfRef = join(repoRoot, 'node_modules', '@contexera')
mkdirSync(selfRef, { recursive: true })
const selfTarget = join(selfRef, 'dsh-agent-team')
removeStaleLink(selfTarget)
if (!existsSync(selfTarget)) {
  if (process.platform === 'win32') {
    symlinkSync(relative(selfRef, repoRoot), join(selfRef, 'dsh-agent-team'), 'junction')
  } else {
    symlinkSync(relative(selfRef, repoRoot), join(selfRef, 'dsh-agent-team'), 'dir')
  }
  linked += 1
}
console.log(`linked ${linked} sibling packages into node_modules`)
