import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const e2eDir = join(root, 'scripts', 'e2e')
const enCatalogPath = join(root, 'docs', 'development', 'e2e-lanes.md')
const zhCatalogPath = join(root, 'docs', 'development', 'e2e-lanes.zh.md')
const scriptsReadmePath = join(root, 'scripts', 'README.md')

const failures = []

const actualFiles = readdirSync(e2eDir)
  .filter(name => name.endsWith('.e2e.ts'))
  .sort()
const actualLanes = new Set(actualFiles.map(name => name.slice(0, -'.e2e.ts'.length)))

const extractBacktickedE2eRefs = text => [...text.matchAll(/`(?:scripts\/e2e\/)?([a-z0-9-]+)\.e2e\.ts`/g)].map(match => match[1])

const checkCatalog = (label, filePath) => {
  const text = readFileSync(filePath, 'utf8')
  const referenced = new Set(extractBacktickedE2eRefs(text))
  for (const lane of actualLanes) {
    if (!referenced.has(lane)) {
      failures.push(`${label}: missing entry for scripts/e2e/${lane}.e2e.ts`)
    }
  }
  for (const lane of referenced) {
    if (!actualLanes.has(lane)) {
      failures.push(`${label}: references nonexistent scripts/e2e/${lane}.e2e.ts`)
    }
  }
  return { text, referenced }
}

const enCatalog = checkCatalog('docs/development/e2e-lanes.md', enCatalogPath)
const zhCatalog = checkCatalog('docs/development/e2e-lanes.zh.md', zhCatalogPath)

if (enCatalog.referenced.size !== zhCatalog.referenced.size
  || [...enCatalog.referenced].some(lane => !zhCatalog.referenced.has(lane))) {
  failures.push('e2e-lanes.md and e2e-lanes.zh.md do not cover the exact same set of lanes')
}

const runnerHelperPath = join(root, 'scripts', 'browser-runner.mjs')
const runnerText = readFileSync(runnerHelperPath, 'utf8')
const aliasBlockMatch = runnerText.match(/const LANE_ALIASES = new Map\(\[([\s\S]*?)\]\)/)
if (aliasBlockMatch) {
  const aliasPairs = [...aliasBlockMatch[1].matchAll(/\['([^']+)',\s*'([^']+)'\]/g)]
  for (const [, alias, target] of aliasPairs) {
    if (!actualLanes.has(target)) {
      failures.push(`scripts/run-browser-test.mjs: laneAliases target '${target}' (from '${alias}') does not exist in scripts/e2e/`)
    }
    if (!enCatalog.text.includes(`\`${alias}\``)) {
      failures.push(`docs/development/e2e-lanes.md: missing documented alias '${alias}' -> '${target}'`)
    }
    if (!zhCatalog.text.includes(`\`${alias}\``)) {
      failures.push(`docs/development/e2e-lanes.zh.md: missing documented alias '${alias}' -> '${target}'`)
    }
  }
}

const scriptsReadme = readFileSync(scriptsReadmePath, 'utf8')
const staleLegacyLanes = [
  'team-main-stream',
  'team-multi-page',
  'team-page-identity',
  'team-project-owners',
  'team-thread-ref-chip',
  'team-bundle-toggle',
  'team-environment-check',
  'team-board-task-focus',
  'team-settings-nav-icon',
]
for (const legacy of staleLegacyLanes) {
  if (new RegExp(`\`${legacy}\``).test(scriptsReadme)) {
    failures.push(`scripts/README.md: still lists legacy removed lane '${legacy}'`)
  }
}
if (!scriptsReadme.includes('docs/development/e2e-lanes.md')) {
  failures.push('scripts/README.md: must link to docs/development/e2e-lanes.md')
}

if (failures.length > 0) {
  console.error('E2E documentation consistency check failed:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log(`E2E documentation check OK: ${actualFiles.length} lane file(s) synced across EN/ZH catalogs, runner aliases, and scripts/README.md.`)
