/**
 * Package-boundary check for the Agent Team plugin.
 *
 * The root package's three `packages/*` directories are build/export seams: a source file reaches
 * another seam through a declared subpath (`@contexera/dsh-agent-team/remote`), never by climbing out
 * of its package directory with a relative specifier, which bypasses the `exports` map and the generated
 * `tsconfig*.json` path facades that keep generated artifacts swappable.
 *
 * Every module reference is read from the TypeScript syntax tree rather than matched as text: a pattern
 * cannot tell an `export … from` re-export or a bare side-effect `import` from prose that merely quotes
 * one, so it either misses an escaping reference or fails on a string literal. The tree also decides the
 * exemption per declaration — a declaration that binds no value is erased before runtime, so it cannot
 * couple the bundle — which is what keeps `import { type X } from '…'` legal while `import { X, type Y }`
 * stays a real reference.
 *
 * Scope limits:
 * - Only source is scanned; tests wire directories together and may reach the shared `scripts/` helpers.
 * - Only *escaping* relative specifiers are rejected; paths inside the file's own package are fine.
 * - Declared subpaths are not cross-checked against the `exports` map; that needs a resolution engine.
 *
 * Runs standalone: `npm run check:boundaries` (also part of `npm test`); `--root <dir>` checks another
 * tree, which is how the fixture tests drive it.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const args = process.argv.slice(2)
const rootFlag = args.indexOf('--root')
const root = rootFlag === -1
  ? resolve(dirname(fileURLToPath(import.meta.url)), '..')
  : resolve(args[rootFlag + 1] ?? '.')
const packagesRoot = join(root, 'packages')

const SOURCE_PATTERN = /\.(m|c)?tsx?$/
const IGNORED_DIRECTORY = new Set(['node_modules', 'lib'])

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

/**
 * True when an import or `export … from` declaration binds no value, so nothing of it survives emit:
 * `import type …` / `export type …`, or a named list whose every specifier carries the `type` modifier.
 * A default or namespace binding and a bare `import '…'` stay runtime references — each has a type-only
 * spelling of its own, so the conservative reading costs a specifier, never a false pass.
 */
const bindsOnlyTypes = (declaration) => {
  const clause = declaration.importClause ?? declaration.exportClause
  if (clause === undefined) return false
  // `import type …` marks the clause; `export type …` marks the declaration itself.
  if (clause.isTypeOnly || declaration.isTypeOnly) return true
  if (declaration.importClause?.name !== undefined) return false
  const specifiers = clause.namedBindings?.elements ?? clause.elements ?? []
  return specifiers.length > 0 && specifiers.every((specifier) => specifier.isTypeOnly)
}

/**
 * The relative module specifiers one file references at runtime, each with the line its literal sits on.
 * A reference is a declaration's own module specifier — an import, an `export … from` re-export, or a
 * dynamic `import()` argument — so text inside a string or a comment is never mistaken for one.
 */
const runtimeSpecifiers = (fileName, text) => {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /* setParentNodes */ false)
  const found = []
  const record = (specifier) => {
    if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return
    if (!specifier.text.startsWith('.')) return
    found.push({ specifier: specifier.text, line: source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1 })
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      if (!bindsOnlyTypes(node)) record(node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node)) {
      if (!bindsOnlyTypes(node)) record(node.moduleSpecifier)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      record(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

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
    for (const reference of runtimeSpecifiers(file, await readFile(file, 'utf8'))) {
      const target = resolve(dirname(file), reference.specifier)
      if (!relative(packageDirectory, target).startsWith('..')) continue
      violations.push(`${relative(root, file)}:${reference.line} imports '${reference.specifier}', which leaves ${relative(root, packageDirectory)}`)
    }
  }
}

if (violations.length > 0) {
  console.error('Package boundary check FAILED — use a declared subpath instead of a relative path across packages:\n')
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(`\n${violations.length} violation(s) in ${scanned} scanned source file(s).`)
  console.error('A declaration that binds no value is exempt; everything else must stay inside its own package directory.')
  process.exit(1)
}

console.log(`Package boundary check OK: ${scanned} source file(s) in ${packageDirectories.length} package(s) stay inside its own package.`)
