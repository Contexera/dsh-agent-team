// Mechanical gate for the certified-DSH baseline as it appears on PUBLIC
// surfaces — the copies no build step reads.
//
// Why this exists: the pinned `#4303` discussion body carries hand-maintained
// `Certified against` / `认证基线` rows, and both READMEs restate the baseline in
// prose. Nothing syncs them with the manifest, so after the 0.1.10 hard cut the
// discussion kept advertising `0.1.2-rc.1` — a public falsehood on the post we
// send every visitor to — while every local check stayed green. Memory is not a
// sync mechanism; this script is.
//
// Source of truth: the `@deepseek-ai/dsh-*` entries of `peerDependencies`, which
// must reduce to ONE range (the same invariant `packages/agent-team/tests/
// shipping.spec.ts` asserts), whose lower bound is the certified baseline.
//
// A surface that cannot be PARSED is a FAILURE, never a skip: this goes red
// when the marker that names the baseline has disappeared, or when the line it
// sits on has been split, rather than quietly dropping the surface out of
// coverage.
//
// The anchor rule — the same shape `check-version-consistency.mjs` applies to
// these same README sentences, since one sentence read by two gates can only
// fail as a union — is: the marker is the WHOLE phrase or clause that qualifies
// the baseline, and the gap starts BEFORE its token, stays on one line, and
// crosses no other inline-code span. Only prose after the marker is free; words
// inserted inside the marker phrase stop the match. That last case is the
// accepted cost of anchoring on the declaration, not a bug. Fix the pattern
// together with the prose.
//
// Needs `gh` (authenticated) for the discussion body; `--offline` skips that
// surface and is for local iteration only — never run it offline before a
// publish.
//
// Usage:  npm run check:public-baseline        (or: node scripts/check-public-baseline.mjs [repoRoot] [--offline])
// Exit:   0 = every surface states the current certified baseline, 1 = drift.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { dshPeerRanges } from './dsh-peers.mjs'

const args = process.argv.slice(2)
const offline = args.includes('--offline')
const repoRoot = args.find(arg => !arg.startsWith('--')) ?? process.cwd()

const failures = []
const noted = []
const fail = (surface, message) => failures.push(`${surface}: ${message}`)
const note = message => noted.push(message)

// ---- 1. Source of truth -----------------------------------------------------
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const ranges = dshPeerRanges(manifest)
if (ranges.size !== 1) {
  fail('package.json', `expected exactly ONE @deepseek-ai/dsh-* peer range, found ${ranges.size}: ${[...ranges].join(' | ')}`)
}
const peerRange = [...ranges][0] ?? ''
const parsed = /^>=([^ ]+) <([^ ]+)$/.exec(peerRange)
if (!parsed) fail('package.json', `peer range is not in ">=X <Y" form: ${JSON.stringify(peerRange)}`)
const baseline = parsed?.[1] ?? ''
console.log(`source of truth: peers ${peerRange}  ->  certified baseline ${baseline}   (package ${manifest.version})\n`)

// ---- 2. Local surfaces ------------------------------------------------------
const localSurfaces = [
  {
    name: 'README.md',
    file: 'README.md',
    // "This release is certified against DSH `0.1.5-rc.1`."
    pattern: /certified against DSH[^\n`]*`([^`]+)`/i,
    shown: value => `certified against DSH \`${value}\``,
  },
  {
    name: 'README.zh.md',
    file: 'README.zh.md',
    // "当前版本已针对 DSH `0.1.5-rc.1` 完成认证。"
    pattern: /针对 DSH[^\n`]*`([^`]+)`/,
    shown: value => `针对 DSH \`${value}\` 完成认证`,
  },
]

for (const surface of localSurfaces) {
  let text
  try {
    text = readFileSync(join(repoRoot, surface.file), 'utf8')
  } catch (error) {
    fail(surface.name, `unreadable (${error.code ?? error.message})`)
    continue
  }
  const hit = surface.pattern.exec(text)
  if (!hit) {
    fail(surface.name, `no certified-baseline statement matched ${surface.pattern} — surface silently dropped out of coverage, fix the pattern`)
    continue
  }
  if (hit[1] !== baseline) fail(surface.name, `states \`${hit[1]}\`, expected \`${baseline}\` (found: ${surface.shown(hit[1])})`)
  else console.log(`ok   ${surface.name.padEnd(14)} ${surface.shown(hit[1])}`)
}

// ---- 3. The pinned compatibility discussion ---------------------------------
const DISCUSSION_OWNER = 'deepseek-ai'
const DISCUSSION_REPO = 'deepseek-harness'
const DISCUSSION_NUMBER = 4303

if (offline) {
  note('#4303 body NOT checked (--offline). Run without --offline before publishing.')
} else {
  const query = `query{repository(owner:"${DISCUSSION_OWNER}",name:"${DISCUSSION_REPO}"){discussion(number:${DISCUSSION_NUMBER}){url updatedAt body}}}`
  let body
  try {
    const raw = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    body = JSON.parse(raw).data.repository.discussion.body
  } catch (error) {
    const detail = (error.stderr ?? '').toString().trim() || error.message
    fail('#4303 body', `unreadable — ${detail.split('\n')[0]}`)
  }
  if (body != null) {
    // Each language table states the baseline twice over: version AND full range.
    const rows = [
      { name: '#4303 body (en)', pattern: /Certified against\**\s*\|?\s*(.+?)\s*\|?\s*$/m },
      { name: '#4303 body (zh)', pattern: /^\|\s*\*\*认证基线\*\*\s*\|(.+)\|\s*$/m },
    ]
    for (const row of rows) {
      const hit = row.pattern.exec(body)
      if (!hit) {
        fail(row.name, 'no baseline row matched — row renamed or removed, fix the pattern')
        continue
      }
      const cells = [...hit[1].matchAll(/`([^`]+)`/g)].map(match => match[1])
      const [statedVersion, ...rest] = cells
      // Only `>=X <Y`-shaped tokens are ranges to compare; anything else (for
      // example the "0.1.5-rc.2 is certified on the same peers" mention) is a
      // separate claim, reported for a human glance rather than machine-
      // compared — deciding whether a prerelease is admitted needs npm's own
      // semver rules, and re-implementing those here is the trap that has fooled
      // us before.
      const statedRanges = rest.filter(token => /^>=.*<.*$/.test(token))
      for (const other of rest.filter(token => !statedRanges.includes(token))) {
        note(`${row.name}: also mentions \`${other}\` — confirm it is admitted by \`${peerRange}\``)
      }
      if (statedVersion !== baseline) fail(row.name, `states \`${statedVersion}\`, expected \`${baseline}\``)
      for (const range of statedRanges) {
        if (range !== peerRange) fail(row.name, `states range \`${range}\`, expected \`${peerRange}\``)
      }
      if (statedVersion === baseline && statedRanges.every(range => range === peerRange)) {
        console.log(`ok   ${row.name.padEnd(14)} \`${statedVersion}\` (requires \`${peerRange}\`)`)
      }
    }
  }
}

// ---- 4. Verdict -------------------------------------------------------------
console.log()
for (const entry of noted) console.log(`note ${entry}`)
if (failures.length > 0) {
  console.error(`\nDRIFT in ${failures.length} surface(s):`)
  for (const failure of failures) console.error(`  x ${failure}`)
  console.error('\nFix the surface (for #4303 use the GraphQL `updateDiscussion` mutation with `discussionId`), then re-run.')
  process.exit(1)
}
console.log('All public surfaces state the current certified baseline.')
