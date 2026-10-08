// Regenerates the resolution facades from the sibling deepseek-harness checkout.
// Harness imports resolve against its source or declarations; this external bundle's
// public subpaths resolve to their maintained implementation directories.
// `--check` compares the committed facades against what this run would write and
// fails on any difference without touching the files.
import { readFileSync, writeFileSync } from 'node:fs'
import { harnessName } from './harness-dir.mjs'

// scripts/harness-dir.mjs owns the checkout pointer (env override for
// certification runs, daily sibling default, fail-fast on a missing dir).
const HARNESS_NAME = harnessName
const HARNESS = new URL(`../../${HARNESS_NAME}/`, import.meta.url)
const raw = readFileSync(new URL('tsconfig.base.json', HARNESS), 'utf8')
const cleaned = raw
  .split('\n')
  .filter(line => !/^\s*\/\//.test(line))
  .join('\n')
  .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
const base = JSON.parse(cleaned)

const own = {
  '@contexera/dsh-agent-team/host': ['./packages/agent-team/src/index.ts'],
  '@contexera/dsh-agent-team/invariant': ['./packages/agent-team/src/invariant.ts'],
  '@contexera/dsh-agent-team/types': ['./packages/agent-team/src/types.ts'],
  '@contexera/dsh-agent-team/typert': ['./packages/agent-team/lib/typert.host.d.ts'],
  '@contexera/dsh-agent-team/remote': ['./packages/agent-team/lib/typert.remote-client.js'],
  '@contexera/dsh-agent-team/sqlite-backend': ['./packages/agent-team/src/vendor/storage-sqlite/index.ts'],
  '@contexera/dsh-agent-team/compaction-engine': ['./packages/agent-team/src/compaction-engine.ts'],
  '@contexera/dsh-agent-team/member-context': ['./packages/agent-team/src/member-context.ts'],
  '@contexera/dsh-agent-team/member-time-context': ['./packages/agent-team/src/member-time-context.ts'],
  '@contexera/dsh-agent-team/time-format': ['./packages/agent-team/src/time-format.ts'],
  '@contexera/dsh-agent-team/mentions': ['./packages/agent-team/src/mentions.ts'],
  '@contexera/dsh-agent-team/member-skills': ['./packages/agent-team/src/member-skills.ts'],
  '@contexera/dsh-agent-team/tools': ['./packages/tool-agent-team/src/index.ts'],
  '@contexera/dsh-agent-team/client': ['./packages/client-agent-team/src/client/index.ts'],
}

const ownTypes = {
  ...own,
  '@contexera/dsh-agent-team/remote': ['./packages/agent-team/lib/typert.remote-client.d.ts'],
}

const harnessSrc = {
  '@deepseek-ai/dsh-storage-sqlite': [`../${HARNESS_NAME}/packages/storage/storage-sqlite/src/index.ts`],
  '@deepseek-ai/dsh-skill': [`../${HARNESS_NAME}/packages/skill/skill/src/index.ts`],
  '@deepseek-ai/dsh-skill-filesystem': [`../${HARNESS_NAME}/packages/skill/skill-filesystem/src/index.ts`],
}
for (const [key, value] of Object.entries(base.compilerOptions.paths)) {
  harnessSrc[key] = (Array.isArray(value) ? value : [value])
    .map(path => path.replace(/^\.\//, `../${HARNESS_NAME}/`))
}
// dsh-client-locale is the one client package whose source dictionaries are
// reachable only through its verified "./src/*" export (the test harness
// loads the zh/en tables from source). The bare-name mapping above is
// exact-match only, so deep imports need a wildcard mirroring the export.
harnessSrc['@deepseek-ai/dsh-client-locale/src/*'] = [`../${HARNESS_NAME}/packages/client/locale/src/*`]
// The v3→v4 migration test reads its source rewrite through this package's
// same verified "./src/*" export, so its wildcard mirrors that export too.
harnessSrc['@deepseek-ai/dsh-session-format-v3-to-v4/src/*'] = [`../${HARNESS_NAME}/packages/session/session-format-v3-to-v4/src/*`]

const toTypes = path => path
  .replace(/\/src\/(.+)\.ts$/, '/lib/types/$1.d.ts')
  .replace(/\/src\/(.+)$/, '/lib/types/$1')
  .replace(/\/src$/, '/lib/types')

const harnessTypes = Object.fromEntries(
  Object.entries(harnessSrc).map(([key, value]) => [key, value.map(toTypes)]),
)

const buildOwn = {
  '@contexera/dsh-agent-team/host': ['./packages/agent-team/lib/types/index.d.ts'],
  '@contexera/dsh-agent-team/invariant': ['./packages/agent-team/lib/types/invariant.d.ts'],
  '@contexera/dsh-agent-team/types': ['./packages/agent-team/lib/types/types.d.ts'],
  '@contexera/dsh-agent-team/typert': ['./packages/agent-team/lib/typert.host.d.ts'],
  '@contexera/dsh-agent-team/remote': ['./packages/agent-team/lib/typert.remote-client.d.ts'],
  '@contexera/dsh-agent-team/sqlite-backend': ['./packages/agent-team/lib/types/vendor/storage-sqlite/index.d.ts'],
  '@contexera/dsh-agent-team/compaction-engine': ['./packages/agent-team/lib/types/compaction-engine.d.ts'],
  '@contexera/dsh-agent-team/member-context': ['./packages/agent-team/lib/types/member-context.d.ts'],
  '@contexera/dsh-agent-team/member-time-context': ['./packages/agent-team/lib/types/member-time-context.d.ts'],
  '@contexera/dsh-agent-team/time-format': ['./packages/agent-team/lib/types/time-format.d.ts'],
  '@contexera/dsh-agent-team/mentions': ['./packages/agent-team/lib/types/mentions.d.ts'],
  '@contexera/dsh-agent-team/member-skills': ['./packages/agent-team/lib/types/member-skills.d.ts'],
  '@contexera/dsh-agent-team/tools': ['./packages/tool-agent-team/lib/types/index.d.ts'],
  '@contexera/dsh-agent-team/client': ['./packages/client-agent-team/lib/types/client/index.d.ts'],
}

const shared = {
  target: 'es2024', module: 'esnext', moduleResolution: 'bundler', skipLibCheck: true,
  esModuleInterop: true, allowImportingTsExtensions: true, rewriteRelativeImportExtensions: true,
  verbatimModuleSyntax: false, strict: true, noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true, noImplicitOverride: true, noFallthroughCasesInSwitch: true,
  types: ['node'], noEmit: true,
}

const header = text => `// GENERATED by scripts/sync-paths.mjs against ../${HARNESS_NAME} - edit that script, not this file.\n${text}`

const facade = (label, paths) => `${JSON.stringify({
  compilerOptions: { ...shared, paths },
}, null, 2)}\n`.replace(/^/, header(label))

const outputs = [
  // The marker lets scripts/harness-dir.mjs follow the SAME checkout after a
  // cert-run generation, so tests keep matching the facades without a sticky
  // env var. Regenerating against another checkout (or the daily default)
  // overwrites it.
  ['../.generated-harness', `${HARNESS_NAME}\n`],
  ['../tsconfig.json', facade('// Runtime facade for the external bundle and sibling Harness source.\n', { ...own, ...harnessSrc })],
  ['../tsconfig.types.json', facade('// Typecheck facade for the external bundle and sibling Harness declarations.\n', { ...ownTypes, ...harnessTypes })],
  ['../tsconfig.build-deps.json', facade('// Build facade: own cross-surface imports resolve to emitted declarations.\n', { ...buildOwn, ...harnessTypes })],
]

// A subpath added to the maps above (or a Harness mapping that moved) must land
// with its regenerated facades; hand-edited or stale facades otherwise resolve
// imports that no source declares. Check mode never writes, so a fresh clone
// whose facades still point at their generation-time paths fails loudly here
// instead of having the mismatch papered over.
if (process.argv.includes('--check')) {
  const drifted = outputs
    .filter(([path, text]) => readFileSync(new URL(path, import.meta.url), 'utf8') !== text)
    .map(([path]) => path.replace('../', ''))
  if (drifted.length > 0) {
    console.error(`facade drift: ${drifted.join(', ')} differ from the generated output - run node scripts/sync-paths.mjs`)
    process.exit(1)
  }
  console.log(`facades match the generated output (${Object.keys(harnessSrc).length} Harness mappings)`)
} else {
  for (const [path, text] of outputs) writeFileSync(new URL(path, import.meta.url), text)
  console.log(`wrote tsconfig.json (${Object.keys(harnessSrc).length} Harness mappings), tsconfig.types.json, and tsconfig.build-deps.json`)
}
