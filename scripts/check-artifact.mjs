// Gate for the publish artifact: what `npm pack` would ship. The tarball only carries
// what `package.json`'s `files` allowlist (plus npm's always-included set) selects, so a
// runtime file outside it, or a stray `.ts`, breaks installed users only. Asserts:
//   1. no stray `.ts`/`.tsx` sources (published `.d.ts` declarations are fine);
//   2. the mandatory manifests (`package.json`, `cordis.patch.yml`) are present;
//   3. every runtime relative import resolves to a file in the tarball.
//
// Run AFTER `npm run build`: it packs with `--ignore-scripts`, so it validates the `lib/`
// on disk.
//
// Usage:  npm run check:artifact      (or: node scripts/check-artifact.mjs [repoRoot])
// Exit:   0 = the artifact is complete and clean, 1 = it would ship broken.
import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join, normalize } from 'node:path'

const repoRoot = process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? process.cwd()
const failures = []

// npm prints the notice block to STDERR, so the two streams must be merged —
// piping stdout alone yields just the tarball filename. `--loglevel=notice` is
// forced because npm exports its own loglevel to child processes: invoked from a
// `npm run --silent` wrapper, an inherited `silent` reduces the output to the
// tarball filename and the parse below would fail on a perfectly good artifact.
let notice
try {
  notice = execSync('npm pack --dry-run --ignore-scripts --loglevel=notice 2>&1', { cwd: repoRoot, encoding: 'utf8' })
} catch (error) {
  notice = `${error.stdout ?? ''}${error.stderr ?? ''}`
  if (!notice) {
    console.error(`could not run npm pack: ${error.message}`)
    process.exit(1)
  }
}

const lines = notice.split('\n')
const start = lines.findIndex(line => line.includes('Tarball Contents'))
const end = lines.findIndex(line => line.includes('Tarball Details'))
if (start === -1 || end === -1 || end <= start) {
  console.error('could not locate the Tarball Contents block in npm pack output')
  console.error(lines.slice(0, 10).join('\n'))
  process.exit(1)
}

const shipped = new Set()
for (const line of lines.slice(start + 1, end)) {
  const hit = /^npm notice\s+[\d.]+(?:B|kB|MB|GB)?\s+(.+?)\s*$/.exec(line)
  if (hit) shipped.add(hit[1])
}

const totalLine = lines.find(line => line.includes('total files:'))
console.log(`artifact entries: ${shipped.size}${totalLine ? `  (${totalLine.trim()})` : ''}`)

if (shipped.size === 0) {
  console.error('parsed 0 shipped files — the parser broke, refusing to report success')
  process.exit(1)
}

// `.d.ts` / `.d.ts.map` are legitimate published declarations; a bare `.ts` or
// `.tsx` is a build leftover that should never reach consumers.
const strayTs = [...shipped].filter(path => (path.endsWith('.ts') || path.endsWith('.tsx')) && !path.endsWith('.d.ts'))
if (strayTs.length > 0) {
  failures.push(`stray TypeScript sources in the artifact (${strayTs.length}): ${strayTs.slice(0, 5).join(', ')}`)
} else {
  console.log('ok   no stray .ts/.tsx sources')
}

// `cordis.patch.yml` is this bundle's patch entry point; a plain library
// package would ship none, so the requirement keys off its presence.
const isBundle = existsSync(join(repoRoot, 'cordis.patch.yml'))
const required = isBundle ? ['package.json', 'cordis.patch.yml'] : ['package.json']
for (const file of required) {
  if (!shipped.has(file)) failures.push(`mandatory file missing from the artifact: ${file}`)
}
if (required.every(file => shipped.has(file))) {
  console.log(`ok   mandatory manifests present (${required.join(', ')})`)
}

// The scan set is the shipped `.js` files themselves, so it assumes nothing
// about the directory layout. `types/` output is excluded: its imports of
// client `.module.css` files are not runtime loads of the plugin entry points.
const jsFiles = [...shipped].filter(path => path.endsWith('.js') && !/(^|\/)types\//.test(path))

let checked = 0
const missing = []
for (const file of jsFiles) {
  let source
  try {
    source = readFileSync(join(repoRoot, file), 'utf8')
  } catch {
    continue
  }
  for (const match of source.matchAll(/(?:require\(|from\s+)['"](\.[^'"]+)['"]/g)) {
    checked += 1
    const target = normalize(join(dirname(file), match[1]))
    const candidates = [target, `${target}.js`, `${target}.json`, `${target}.cjs`, `${target}.mjs`, join(target, 'index.js')]
    if (!candidates.some(candidate => shipped.has(candidate))) missing.push(`${file} -> ${match[1]}`)
  }
}
if (missing.length > 0) {
  failures.push(`relative imports with no shipped target (${missing.length}): ${missing.slice(0, 5).join(' | ')}`)
} else {
  console.log(`ok   all ${checked} runtime relative imports resolve to shipped files`)
}

if (failures.length > 0) {
  console.error(`\nARTIFACT WOULD SHIP BROKEN (${failures.length} problem(s)):`)
  for (const failure of failures) console.error(`  x ${failure}`)
  console.error('\nFix `files` in package.json or remove the offending file, rebuild, then re-run.')
  process.exit(1)
}
console.log('\nArtifact is complete and clean.')
