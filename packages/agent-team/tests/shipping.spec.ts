import { createRequire } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { HUMAN_PROFILE_SETTINGS_NAMESPACE, HUMAN_PROFILE_SETTINGS_SCHEMA } from '../src/human-profile.ts'
import { TEAM_HOST_ROW_SETTINGS_SCHEMA } from '../src/index.ts'
// @ts-expect-error untyped shared resolution module
import { dshPeerRanges } from '../../../scripts/dsh-peers.mjs'

const root = resolve(import.meta.dirname, '../../../')

// The shipped bundle patch stack resolves against the SAME harness checkout
// the rest of the build uses (env override for certification rounds, then the
// .generated-harness marker, then the daily sibling) — never a hardcoded
// name, or a compat round would sweep the daily checkout's rows instead of
// the candidate's.
async function shippedHarnessName(): Promise<string> {
  const marker = resolve(root, '.generated-harness')
  try {
    return process.env.DSH_HARNESS_DIR?.trim() || (await readFile(marker, 'utf8')).trim() || 'deepseek-harness'
  } catch {
    return process.env.DSH_HARNESS_DIR?.trim() || 'deepseek-harness'
  }
}

// The persona is injected into every Member turn and ships to every user, so its
// size is a reviewed budget rather than a measurement: raising this number is a
// deliberate act in the same change that edits the text. Silent accretion is what
// this test exists to stop. The 2026-09-14 markdown rewrite (communication
// discipline, Decision-needed template removed, progress nudges deleted in the
// same change) moved the reviewed size up once, with headroom for wording that
// earns its characters. The 2026-09-15 Thread entry/re-entry rule moved it up
// again on the operator's instruction, to stop leaving every wording-only
// improvement squeezed into the last few characters.
const PERSONA_CHARACTER_BUDGET = 15000

// The team-member preset rides the shipped patch as one declarative definition
// row; these assertions scope to exactly that row, from its `- id:` marker to
// the group's host row that follows it.
function teamMemberPresetText(patch: string): string {
  const start = patch.indexOf('        - id: wowyuarm-agent-team-preset-team-member')
  const end = patch.indexOf('        - id: wowyuarm-agent-team-host')
  return start >= 0 && end > start ? patch.slice(start, end) : ''
}

// The YAML block-scalar bodies under `prefix:`/`suffix:`, de-indented the way YAML
// reads them. The block ends at the first line that is not more indented than its
// key, so a renamed config key yields an empty string — which is why the budget
// test also asserts the extraction found the persona at all.
function personaInstructionText(preset: string): string {
  const lines = preset.replaceAll('\r\n', '\n').split('\n')
  const blocks: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const key = /^(\s*)(?:prefix|suffix):\s*\|-?\s*$/.exec(lines[index] ?? '')
    if (key === null || key[1] === undefined) continue
    const keyIndent = key[1].length
    const body: string[] = []
    let contentIndent = -1
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line === undefined) break
      if (line.trim() === '') {
        body.push('')
        continue
      }
      const indent = line.length - line.trimStart().length
      if (indent <= keyIndent) break
      if (contentIndent === -1) contentIndent = indent
      body.push(line.slice(contentIndent))
    }
    blocks.push(body.join('\n').replace(/\n+$/, ''))
  }
  return blocks.join('')
}

describe('Agent Team shipping contract', () => {
  it('ships an opt-in Host patch and one explicit team-member preset', async () => {
    const [patch, manifestText] = await Promise.all([
      readFile(resolve(root, 'cordis.patch.yml'), 'utf8'),
      readFile(resolve(root, 'package.json'), 'utf8'),
    ])
    const preset = teamMemberPresetText(patch)
    // Extraction guard: a renamed definition-row id would silently empty the
    // slice and make every preset assertion below vacuous.
    expect(preset).toContain("name: '@deepseek-ai/dsh-agent-preset'")
    expect(patch).toContain('id: wowyuarm-agent-team-scope')
    expect(patch).toContain("name: '@deepseek-ai/dsh-agent-preset-registry'")
    expect(patch).toContain('default: team-member')
    expect(patch).toContain('id: wowyuarm-agent-team-preset-team-member')
    expect(patch).toContain('id: team-member')
    expect(patch).toContain('agentPresets: true')
    expect(patch).toContain("name: '@wowyuarm/dsh-agent-team/host'")
    expect(patch).toContain("name: '@wowyuarm/dsh-agent-team'")
    // The upstream registry row must stay gone: the Harness line after rc.2
    // removes `@deepseek-ai/dsh-invariants` wholesale, and the companion now
    // validates the ledger from its own fiber (src/invariant.ts).
    expect(patch).not.toContain("name: '@deepseek-ai/dsh-invariants'")
    expect(patch).toContain("name: '@wowyuarm/dsh-agent-team/invariant'")
    // The Team ledger medium: only agent_team routes to SQLite through the
    // public per-domain route table. The backend is vendored under our own
    // package name (see packages/agent-team/src/vendor/storage-sqlite/):
    // DSH Desktop generation installers strip `@deepseek-ai/*` copies, so a
    // loader row naming that package blocks boot (GitHub issue #28).
    // Simulate the real layer stack (the shipped Web bundle patch, then this
    // bundle's) because insert blocks append rather than override: a
    // colliding id inside an insert list would duplicate the shipped row and
    // fail the boot sweep.
    expect(patch).toContain("name: '@wowyuarm/dsh-agent-team/sqlite-backend'")
    // The old host-package row must stay gone: re-adding it reintroduces the
    // Desktop boot block this vendoring exists to fix (GitHub issue #28).
    expect(patch).not.toContain('@deepseek-ai/dsh-storage-sqlite')
    const composed = applyEntryPatches([], [
      // rc.1 moved the storage rows from web-app into the base bundle; the
      // real layer stack is base → web-app → this bundle. The stack resolves
      // against the harness checkout this run was generated against, so a
      // certification round sweeps the CANDIDATE's rows, not the daily ones.
      ...loadOverlayPatches('shipping contract', resolve(root, `../${await shippedHarnessName()}/packages/bundle/base/cordis.patch.yml`)),
      ...loadOverlayPatches('shipping contract', resolve(root, `../${await shippedHarnessName()}/packages/bundle/web-app/cordis.patch.yml`)),
      ...loadOverlayPatches('shipping contract', resolve(root, 'cordis.patch.yml')),
    ], () => {})
    const ids = composed.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(composed.find(entry => entry.id === 'storage-domain')?.config).toMatchObject({
      backend: 'json',
      routes: { agent_team: 'sqlite' },
    })
    expect(patch).not.toContain('dsh-tool-agent-team')
    // The Human profile rides the Host row's own Config, and the settings
    // namespace IS that row's id: a form, a write, and the profile-document
    // patch all address it by the constant, so the two must not drift.
    // The row also has to stay the isolating group's nested row — a second
    // top-level row with this id duplicates it and fails the boot sweep.
    const scopeStart = patch.indexOf('    - id: wowyuarm-agent-team-scope')
    const scopeEnd = patch.indexOf('    - id: wowyuarm-agent-team-client')
    expect(scopeStart).toBeGreaterThanOrEqual(0)
    expect(scopeEnd).toBeGreaterThan(scopeStart)
    expect(patch.slice(scopeStart, scopeEnd)).toMatch(new RegExp(`^ {8}- id: ${HUMAN_PROFILE_SETTINGS_NAMESPACE}$`, 'm'))
    // The composition mounts it as that group's nested row, with no `config`
    // of its own: the schema defaults are the profile until the Human edits it.
    const scopeGroup = composed.find(entry => entry.id === 'wowyuarm-agent-team-scope')
    const nestedRows = (Array.isArray(scopeGroup?.config) ? scopeGroup.config : []) as { id?: string; name?: string; config?: unknown }[]
    const hostRow = nestedRows.find(entry => entry.id === HUMAN_PROFILE_SETTINGS_NAMESPACE)
    expect(hostRow?.name).toBe('@wowyuarm/dsh-agent-team/host')
    expect(hostRow?.config).toBeUndefined()
    // Both fields must be volatile: rc.1 derives one settings form per ACTIVE
    // plugin instance from that instance's Config schema, and a non-volatile
    // field yields no form at all while a write to it throws. This is the
    // precondition of the derivation, asserted on the schema the Host ships.
    const profileFields = HUMAN_PROFILE_SETTINGS_SCHEMA.dict ?? {}
    expect(profileFields.name?.meta.volatile).toBe(true)
    expect(profileFields.avatarRef?.meta.volatile).toBe(true)
    // The same row carries the long-gap gate. It is volatile like the rest,
    // because a non-volatile field is one the settings service can neither show
    // nor write — it would exist only in a deployment's patch layer, and the
    // deadline a judge can answer within is a property of the endpoint rather
    // than of the bundle. Its three thresholds stay optional, so an omitted one
    // keeps the engine's own default.
    const rowFields = TEAM_HOST_ROW_SETTINGS_SCHEMA.dict ?? {}
    expect(rowFields.gate?.meta.volatile).toBeUndefined()
    const gateFields = rowFields.gate?.dict ?? {}
    expect(Object.keys(gateFields)).toEqual(['tokens', 'idleMs', 'judgeTimeoutMs'])
    for (const field of Object.values(gateFields)) expect(field.meta.volatile).toBe(true)
    // The judge's own fields are the volatile kind, because the Team settings
    // surface is where a Human enables the gate: every field has to reach the
    // running Host, and the key alone is a secret — so a read reports that it is
    // set and never its value.
    const judgeFields = rowFields.jev?.dict ?? {}
    expect(Object.keys(judgeFields)).toEqual(['apiKey', 'apiKeyEnv', 'model', 'apiBase'])
    for (const field of Object.values(judgeFields)) expect(field.meta.volatile).toBe(true)
    expect(judgeFields.apiKey?.meta.role).toBe('secret')

    expect(preset).toContain("name: '@wowyuarm/dsh-agent-team/tools'")
    expect(preset).toContain("name: '@deepseek-ai/dsh-agent-tool-presentation'")
    expect(preset).toContain('mode: native')
    expect(preset).toContain("name: '@wowyuarm/dsh-agent-team/member-context'")
    expect(preset).toContain("name: '@deepseek-ai/dsh-command-compact'")
    // Every lib directory that can enter the pack must be cleaned, so a
    // deleted source module cannot leave stale output behind.
    const cleanScript = await readFile(resolve(root, 'scripts/clean-build-outputs.mjs'), 'utf8')
    const cleanTargets = [...cleanScript.matchAll(/['"](packages\/[^'"]+\/lib)['"]/g)].map(match => match[1])
    const shippedLibDirs = (JSON.parse(manifestText) as { files: string[] }).files
      .filter(pattern => pattern.startsWith('packages/') && pattern.endsWith('/lib/**/*'))
      .map(pattern => pattern.slice(0, -'/**/*'.length))
    expect(cleanTargets).toEqual(shippedLibDirs)
    const buildCommand = (JSON.parse(manifestText) as { scripts: { build: string } }).scripts.build
    expect(buildCommand.indexOf('npm run clean:build-outputs')).toBeGreaterThanOrEqual(0)
    expect(buildCommand.indexOf('npm run generate:typert')).toBeGreaterThan(buildCommand.indexOf('npm run clean:build-outputs'))
    for (const capability of [
      '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-tool-jobs', '@deepseek-ai/dsh-tool-skill',
      '@deepseek-ai/dsh-tool-web',
    ]) expect(preset).toContain(`name: '${capability}'`)
    // Skills are per-Member (Host-mounted private-directory provider), so the
    // shared filesystem row is deliberately absent from the preset.
    expect(preset).not.toContain('@deepseek-ai/dsh-skill-filesystem')
    // Members plan through the ledger, so the session-local todo tool is
    // deliberately absent. The web bundle disables that row on the host plane,
    // which makes this preset's list the whole surface: removing the row really
    // removes the tool, and re-adding it should be a reviewed decision.
    expect(preset).not.toContain('@deepseek-ai/dsh-tool-todo')
    const bundleManifest = JSON.parse(manifestText) as {
      peerDependencies: Record<string, string>
      exports: Record<string, { default?: string }>
      dsh: { client: { platform: string; inject: string[] } }
    }
    expect(bundleManifest.peerDependencies['@deepseek-ai/dsh-tool-web']).toBe('>=0.2.0-rc.2 <0.2.1')
    expect(bundleManifest.peerDependencies['@deepseek-ai/dsh-command-compact']).toBe('>=0.2.0-rc.2 <0.2.1')
    expect(bundleManifest.peerDependencies['@deepseek-ai/dsh-agent-preset']).toBe('>=0.2.0-rc.2 <0.2.1')
    expect(bundleManifest.peerDependencies['@deepseek-ai/dsh-agent-preset-registry']).toBe('>=0.2.0-rc.2 <0.2.1')
    expect(bundleManifest.peerDependencies['@deepseek-ai/dsh-agent-presets']).toBeUndefined()
    // The certified baseline moves as one cut: every DSH peer carries the same
    // range, or an install resolves two DSH generations at once. No host-scope
    // package may sit in `dependencies` (see the host-scope gate below).
    expect([...dshPeerRanges(bundleManifest)]).toEqual(['>=0.2.0-rc.2 <0.2.1'])
    expect(preset).toContain('compaction: true')
    expect(preset).toContain('toolResultPruner: true')
    expect(preset).toContain('team_inbox, team_thread, team_message, team_claim, and team_view')
    // The one token story has exactly two legal surfaces: a fully drained
    // read hands off the next-write token, and a committed public mutation's
    // returned token may serve as the basis for the next deliberate mutation.
    expect(preset).toContain('copy the next-write token that fully drained read renders')
    expect(preset).toContain("a successful public mutation's returned token may serve as the basis for the next deliberate mutation")
    // The persona distinguishes the two reply channels: direct session talk
    // with the Human answers in plain text; ledger-backed Team Threads are
    // what team_message.reply is for.
    expect(preset).toContain('reply in plain text')
    expect(preset).toContain('not a reply channel for it')
    // The message contract is conclusion-first with one mention rule: the
    // Human is mentioned exactly when they must know or decide (that mention
    // is the Human's notification), a decision owed states what needs
    // deciding and the default in plain words (no fixed template), and
    // mechanical detail moves below the conclusion rather than being dropped.
    expect(preset).toContain('Lead with the conclusion or state; put mechanical detail')
    expect(preset).toContain('never drop detail a peer Member needs, move it below')
    expect(preset).toContain('mention the Human as @human — that is how they are notified')
    expect(preset).toContain('what needs deciding and what happens by default')
    // Autonomy is the default and the escalation bar is a closed list. The
    // 2026-10-05 ledger scan is why these lines exist: 836 of 1,502 Member
    // messages mentioned the Human, 51% drew an immediate reply, and the
    // median reply was 29 characters ("可以", "合吧", "分支删了吧") — the
    // Human was rubber-stamping work the Member already had grounds to
    // settle, and in 17% of replies was merely routing to another Member.
    // Each assertion below pins one of the three behaviours that scan found
    // missing; deleting one silently restores the escalation habit.
    expect(preset).toContain('Decide and act by default')
    expect(preset).toContain('Never close a message with a question whose answer you could determine yourself')
    expect(preset).toContain('Mention the Human only when one of these holds')
    expect(preset).toContain('A finished piece of work is reported, not submitted for approval')
    expect(preset).toContain('The Human is not a router')
    // Progress chatter is opt-in: an expected step earns no message, and a
    // taken Task is announced without waiting for anyone to bless the plan.
    expect(preset).toContain('Do not wait for anyone to confirm the plan')
    expect(preset).toContain('silence while working is normal and correct')
    // Disagreement resolves inside the team by function ownership (operator
    // approved this default on 2026-10-05), and an unverified claim is the
    // Member's gap to close rather than a decision handed upward.
    expect(preset).toContain('the Member whose function owns the area decides and the work continues')
    expect(preset).toContain('A gap in your own verification is yours to close')
    // One mention rule, and it is body-authored: the `@` is what makes a
    // mention, `@all` reaches the Channel, and a Member an existing Thread has
    // never carried is reported back rather than silently enrolled or refused.
    expect(preset).toContain('Mention a Member by writing `@Handle` in the Message body')
    expect(preset).toContain('`@all` reaches every Member of the Channel')
    expect(preset).toContain('never carried still commits your message, but delivers nothing to that Member')
    expect(preset).not.toContain('pass structured Member refs in the mentions parameter')
    // The persona keeps only the physical facts of the private space
    // (absolute paths, memory/notes discipline, reusable-assets boundary);
    // skill craft itself lives in the bundled member-skill-manager and its
    // description routes skill work to it.
    expect(preset).toContain('use the injected absolute paths')
    expect(preset).toContain('formal deliverables')
    expect(preset).toContain('your own judgment per task')
    expect(preset).not.toContain('SKILL.md')
    expect(preset).not.toContain('YAML front matter')
    // Memory upkeep follows the same split: the persona carries only the
    // resident rule (bounded index, detail in the note it names) and routes
    // the craft to the bundled member-memory-manager core skill.
    expect(preset).toContain('Keep `memory.md` a bounded index, not a store')
    expect(preset).toContain('past 16 KiB it is not injected at all')
    expect(preset).toContain('the bundled `member-memory-manager` skill')
    const toolSource = await readFile(resolve(root, 'packages/tool-agent-team/src/index.ts'), 'utf8')
    expect([...toolSource.matchAll(/name: '(team_[a-z]+)'/g)].map(match => match[1])).toEqual([
      'team_inbox', 'team_thread', 'team_message', 'team_claim', 'team_view',
    ])
    // Validation errors teach the same two token surfaces as the descriptions,
    // never a single-source story.
    expect(toolSource).toContain('or reuse the one your own last committed mutation rendered')
    expect(toolSource).not.toContain('the revision is not shown anywhere else')
    // The body parameter restates the opening rule where the model composes the
    // message, so the contract is visible at composition time, not only in the
    // per-turn persona.
    expect(toolSource).toContain('Mention the Human only when they must know or decide')
    expect(toolSource).toContain('mechanical detail follows below')

    const manifest = JSON.parse(manifestText) as {
      name: string
      files: string[]
      dependencies: Record<string, string>
      dsh: { bundle: { patch: string } }
    }
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    // The preset directory no longer ships: the declarative definition row in
    // the patch is its only carrier.
    expect(manifest.files).not.toContain('packages/agent-team/preset/**/*')
    expect(manifest.files).toContain('packages/agent-team/core-skills/**/*')
    expect(manifest.files).toContain('packages/agent-team/lib/**/*')
    expect(manifest.files).toContain('packages/client-agent-team/lib/**/*')
    expect(manifest.name).toBe('@wowyuarm/dsh-agent-team')
    // The context-continuity engine rides as a regular dependency, never a
    // peer: profiles set autoInstallPeers: false, so a peer nothing else
    // provides resolves for nobody — the external-layout e2e crashed exactly
    // there before this was fixed (0.1.14 gate, 2026-09-22). The jev judge
    // rides the same way for the same reason, and one more: the Host mounts it
    // itself from the row's key, so its code has to be in the tree.
    expect(manifest.dependencies).toEqual({
      '@wowyuarm/dsh-context-continuity': '^0.3.0',
      '@wowyuarm/dsh-jev': '^0.1.1',
      yaml: '^2.9.1',
      zod: '^4.4.3',
    })
    expect(bundleManifest.dsh.client).toEqual({
      platform: 'web',
      // The Client half classifies a stream end with the Gateway's carrier-error
      // class, so the module table has to answer for that request: the bundle
      // purity gate rejects the value import without this row.
      external: ['@deepseek-ai/dsh-api-gateway/client'],
      inject: expect.not.arrayContaining(['@wowyuarm/dsh-agent-team/host']),
    })
    // An ordering hint for a package DSH no longer publishes is dead weight in
    // the manifest and a hard install failure as a peer.
    expect(bundleManifest.dsh.client.inject).not.toContain('@deepseek-ai/dsh-client-runtime')
    expect(bundleManifest.peerDependencies['@deepseek-ai/dsh-client-runtime']).toBeUndefined()
    expect(bundleManifest.exports['./client']?.default).toBe('./packages/client-agent-team/lib/client.js')

    // Every declared subpath is also mirrored in the resolution facades, which
    // scripts/sync-paths.mjs builds from its own hardcoded maps — the script
    // never reads package.json, so a subpath added to `exports` alone resolves
    // at runtime (the Loader reads the real map) while any source import of it
    // fails to compile, and `--check` stays green because the script is its own
    // source of truth. `.` is the bare package name and `./package.json` is not
    // a module; neither earns a facade row.
    const syncPaths = await readFile(resolve(root, 'scripts/sync-paths.mjs'), 'utf8')
    const facaded = new Set([...syncPaths.matchAll(/'@wowyuarm\/dsh-agent-team\/([a-z-]+)'/g)].map(match => match[1]!))
    for (const subpath of Object.keys(bundleManifest.exports)) {
      if (subpath === '.' || subpath === './package.json') continue
      expect(
        facaded.has(subpath.replace(/^\.\//, '')),
        `subpath '${subpath}' is declared in package.json exports but missing from scripts/sync-paths.mjs`,
      ).toBe(true)
    }

    // Row health: every package row the declarative definition names must
    // resolve from this repository's linked node_modules — the same walk a
    // real profile install performs above its composition base. The
    // composition-level mount of this exact definition is exercised by the
    // browser lane against the assembled bundle.
    const resolution = createRequire(pathToFileURL(join(root, 'package.json')).href)
    const rows = [...preset.matchAll(/name:\s*'([^']+)'/g)].map(match => match[1]!)
    expect(rows.length).toBeGreaterThanOrEqual(15)
    for (const row of rows) {
      if (row === 'cordis:group') continue
      expect(() => resolution.resolve(row), `preset row '${row}' does not resolve`).not.toThrow()
    }
    // Resolution against this repository's node_modules is necessary, never
    // sufficient: the Loader resolves a row from the *profile*, which links this
    // bundle and the host closure and nothing nested inside this bundle's
    // dependency tree. A dependency's subpath therefore resolves here and fails
    // in a real profile — the row reports `never started` and every Member is
    // left unavailable, which is what the browser lane caught. Only a host
    // package or this bundle's own name is reachable from a row.
    for (const row of rows) {
      expect(
        row.startsWith('@deepseek-ai/') || row === '@wowyuarm/dsh-agent-team' || row.startsWith('@wowyuarm/dsh-agent-team/'),
        `preset row '${row}' is neither a host-closure package nor this bundle's own subpath, so a real profile cannot resolve it`,
      ).toBe(true)
    }
  })
})

// Boot-critical host-closure surface (GitHub issue #28): DSH Desktop
// generation installers strip `@deepseek-ai/*` copies from the plugin
// generation and resolve them from the host closure. A `dependencies` entry
// would be deleted with the generation, so no host-scope package may sit
// there; every other reachable root must already be host-side. This test pins
// that surface: adding a root is a deliberate act in the same change that
// needs it. Resolvability itself is proven empirically by the stripped-closure
// boot check, not here.
describe('Boot-critical host closure surface', () => {
  // The vendored sqlite backend's only runtime roots beyond our peers (see
  // packages/agent-team/src/vendor/storage-sqlite/): the kv facet types live
  // in dsh-storage, the Config validator in schemastery.
  const SQLITE_VENDOR_EXTRA_RUNTIME_ROOTS = ['@deepseek-ai/dsh-storage', '@deepseek-ai/schemastery']
  // Pre-existing preset building blocks the host provides outside our peers
  // (persona text, instruction budget, compaction rows). Pinned, not open:
  // a new preset row outside peers fails below just like a new import does.
  const PRESET_HOST_ROWS = [
    '@deepseek-ai/dsh-persona',
    '@deepseek-ai/dsh-agent-instructions',
    '@deepseek-ai/dsh-compaction-tool-result-pruner',
  ]

  // Value imports survive the build into the shipped bundle; `import type`
  // erases and can never break the loader, so only value imports count.
  function valueImportSpecifiers(source: string): string[] {
    const found: string[] = []
    for (const pattern of [
      /import\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
      /export\s+(?!type\b)(?:[^'"]*?\sfrom\s+)['"]([^'"]+)['"]/g,
      /[^.\w$]import\(\s*['"]([^'"]+)['"]\s*\)/g,
    ]) {
      for (const match of source.matchAll(pattern)) {
        if (match[1] !== undefined) found.push(match[1])
      }
    }
    return found
  }

  function packageRoot(specifier: string): string | undefined {
    if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return undefined
    const segments = specifier.split('/')
    return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  }

  it('keeps every reachable runtime root and loader row inside the host closure', async () => {
    const [manifestText, patch] = await Promise.all([
      readFile(resolve(root, 'package.json'), 'utf8'),
      readFile(resolve(root, 'cordis.patch.yml'), 'utf8'),
    ])
    const preset = teamMemberPresetText(patch)
    const manifest = JSON.parse(manifestText) as {
      dependencies: Record<string, string>
      peerDependencies: Record<string, string>
    }
    expect(
      Object.keys(manifest.dependencies).filter(name => name.startsWith('@deepseek-ai/')),
      'host-scope packages in dependencies are deleted from the Desktop generation with no host fallback',
    ).toEqual([])

    const reachable = new Map<string, string>()
    const note = (name: string, via: string) => {
      if (!reachable.has(name)) reachable.set(name, via)
    }
    // The Client ships under a separate bundled contract; only the Host-side
    // sources whose imports enter the generation matter here.
    for (const dir of ['packages/agent-team/src', 'packages/tool-agent-team/src']) {
      const absolute = resolve(root, dir)
      for (const entry of await readdir(absolute, { recursive: true })) {
        if (!entry.endsWith('.ts')) continue
        const file = join(absolute, entry)
        for (const specifier of valueImportSpecifiers(await readFile(file, 'utf8'))) {
          // Self-references resolve inside our own installed copy, which the
          // Desktop strip does not touch. Pinned to our own package name so a
          // typo'd sibling scope still fails below.
          if (specifier === '@wowyuarm/dsh-agent-team' || specifier.startsWith('@wowyuarm/dsh-agent-team/')) continue
          const name = packageRoot(specifier)
          if (name !== undefined) note(name, file)
        }
      }
    }
    // Loader rows resolve package names from the same closure, so patch and
    // preset `name:` rows are reachable roots too. Own-scope rows ship inside
    // this tarball; Desktop only strips `@deepseek-ai/*`.
    for (const [text, via] of [[patch, 'cordis.patch.yml'], [preset, 'team-member preset definition']] as const) {
      for (const match of text.matchAll(/name:\s*['"]([^'"]+)['"]/g)) {
        const row = match[1]
        if (row === undefined || row.startsWith('@wowyuarm/')) continue
        const name = packageRoot(row)
        if (name !== undefined && name.startsWith('@deepseek-ai/')) note(name, via)
      }
    }

    const allowed = new Set([
      ...Object.keys(manifest.peerDependencies),
      ...Object.keys(manifest.dependencies),
      ...SQLITE_VENDOR_EXTRA_RUNTIME_ROOTS,
      ...PRESET_HOST_ROWS,
    ])
    const outside = [...reachable.entries()]
      .filter(([name]) => !allowed.has(name))
      .map(([name, via]) => `${name} (via ${via})`)
      .sort()
    expect(outside, 'reachable roots outside peers and the pinned extras would not resolve from a stripped Desktop generation').toEqual([])
    // Non-vacuous: the vendored extras must actually be reached, or the
    // allowlist is dead weight hiding a removed fork.
    for (const extra of SQLITE_VENDOR_EXTRA_RUNTIME_ROOTS) {
      expect([...reachable.keys()], `the vendored sqlite backend no longer reaches ${extra}`).toContain(extra)
    }
  })

  it('keeps the removed sqlite package out of every shipped source import', async () => {
    // The gate above sees value imports; a type-only import would erase at
    // build and stay harmless, but it would still tie shipped sources to the
    // package this vendoring exists to escape — forbid every import kind.
    // (The compat spec imports it deliberately and lives outside src.)
    const offenders: string[] = []
    for (const dir of ['packages/agent-team/src', 'packages/tool-agent-team/src']) {
      const absolute = resolve(root, dir)
      for (const entry of await readdir(absolute, { recursive: true })) {
        if (!entry.endsWith('.ts')) continue
        const file = join(absolute, entry)
        if (/(?:import|export)[^'"]*from\s*['"]@deepseek-ai\/dsh-storage-sqlite['"]/.test(await readFile(file, 'utf8'))) {
          offenders.push(file)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

// The persona above the tool rows is the one instruction surface every Member
// pays for on every turn, in every Workspace, on every install. These two tests
// are the mechanical half of "workflow discipline": they cannot judge wording,
// but they stop the text from growing silently and from losing a rule whole.
describe('Agent Team Member persona', () => {
  it('stays inside the reviewed prompt budget', async () => {
    const preset = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8').then(teamMemberPresetText)
    const persona = personaInstructionText(preset)
    // Extraction guard: a renamed config key would empty the text and make the
    // budget assertion meaningless, so prove the persona was actually found.
    expect(persona).toContain('You are an Agent Team Member')
    expect(
      persona.length,
      `The Member persona is ${persona.length} characters; the reviewed budget is ${PERSONA_CHARACTER_BUDGET}. `
      + 'Trim it back to the budget, or raise PERSONA_CHARACTER_BUDGET in this file deliberately — every Member '
      + 'pays this text on every turn.',
    ).toBeLessThanOrEqual(PERSONA_CHARACTER_BUDGET)
  })

  // Token-level anchors, not sentences: rewording is Cole's issue 07 territory and
  // must stay free, while losing a whole rule has to fail. These are the rules the
  // persona is the only carrier of, chosen to not overlap the sentence assertions
  // in the shipping contract above (reply channels, the token story, the two
  // message tiers, the private space).
  it('keeps the rules only the persona carries', async () => {
    const preset = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8').then(teamMemberPresetText)
    const persona = personaInstructionText(preset)
    for (const rule of [
      // The Team tool family, named in prose so a Member knows the surface exists.
      'team_view', 'team_inbox', 'team_thread', 'team_message', 'team_claim',
      // The context lifecycle: park, anchor, read where you stand, shorten in place.
      'context_rollover', 'context_checkpoint', 'context_status', 'context_compact',
      // Branded refs are written with exactly one colon.
      'never a double colon',
      // Work on a Task is announced with a Claimed direction before it starts.
      'Claim a Direction',
      // A decision owed states what needs deciding and the default outcome.
      'what needs deciding and what happens by default',
    ]) {
      expect(persona, `the Member persona no longer carries the "${rule}" rule`).toContain(rule)
    }
  })
})
