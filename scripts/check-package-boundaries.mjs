/**
 * Package-boundary check for the Agent Team plugin.
 *
 * The root package's three `packages/*` directories are build/export seams: a source file reaches
 * another seam through a declared subpath (`@contexera/dsh-agent-team/remote`), never by climbing out
 * of its package directory with a relative specifier, which bypasses the `exports` map and the generated
 * `tsconfig*.json` path facades that keep generated artifacts swappable.
 *
 * `import type` is exempt: it is erased before runtime, so it cannot couple the bundle to a generated file.
 *
 * Scope limits:
 * - Only source is scanned; tests wire directories together and may reach the shared `scripts/` helpers.
 * - Only *escaping* relative specifiers are rejected; paths inside the file's own package are fine.
 * - Declared subpaths are not cross-checked against the `exports` map; that needs a resolution engine.
 *
 * Import kinds are parsed per statement, not by one regular expression: a `[^;]*` class spans newlines
 * and swallows the rest of the import block, so the check would pass while enforcing nothing.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesRoot = join(root, 'packages')

const SOURCE_PATTERN = /\.tsx?$/
const IGNORED_DIRECTORY = new Set(['node_modules', 'lib'])
const IMPORT_PATTERN = /\bimport\s*(type\s+)?[^'"()]*?from\s*(['"])(\.[^'"]*)\2|\bimport\s*\(\s*(['"])(\.[^'"]*)\4\s*\)/g

/** List one directory tree's source files. */
const sourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORY.has(entry.name)) found.push(...await sourceFiles(path))
      continue
    }
    if (entry.isFile() && SOURCE_PATTERN.test(entry.name)) found.push(path)
  }
  return found
}

const directoryExists = async path =>
  stat(path).then(entry => entry.isDirectory()).catch(() => false)

const packageDirectories = (await readdir(packagesRoot, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && !IGNORED_DIRECTORY.has(entry.name))
  .map(entry => join(packagesRoot, entry.name))

const violations = []
let scanned = 0

for (const packageDirectory of packageDirectories) {
  const sourceRoot = join(packageDirectory, 'src')
  if (!(await directoryExists(sourceRoot))) continue
  for (const file of await sourceFiles(sourceRoot)) {
    scanned += 1
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      const isTypeOnly = match[1] !== undefined
      const specifier = match[3] ?? match[5]
      if (isTypeOnly || specifier === undefined) continue
      const target = resolve(dirname(file), specifier)
      const escaped = relative(packageDirectory, target)
      if (!escaped.startsWith('..')) continue
      const line = text.slice(0, match.index).split('\n').length
      violations.push(`${relative(root, file)}:${line} imports '${specifier}', which leaves ${relative(root, packageDirectory)}`)
    }
  }
}

if (violations.length > 0) {
  console.error('Package boundary check FAILED — use a declared subpath instead of a relative path across packages:\n')
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(`\n${violations.length} violation(s) in ${scanned} scanned source file(s).`)
  console.error('A type-only import is exempt; everything else must stay inside its own package directory.')
  process.exit(1)
}

console.log(`Package boundary check OK: ${scanned} source file(s) in ${packageDirectories.length} package(s) stay inside their own package.`)
