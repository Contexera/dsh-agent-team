/**
 * Desktop-strip boot verification for GitHub issue #28.
 *
 * Simulates what a DSH Desktop generation installer does to this bundle —
 * delete every `@deepseek-ai/*` copy from the plugin generation, leaving host
 * packages to resolve from the host closure (which ships no
 * `dsh-storage-sqlite`) — then performs a real Loader boot of the storage
 * stack against that stripped layout and round-trips a record through the
 * `agent_team` sqlite route.
 *
 * Layout under a temp dir (never the live profile or Host):
 *   gen/cordis.yml                                  rows under test
 *   gen/node_modules/@contexera/dsh-agent-team/      REAL COPY of our packed
 *     package.json + packages/agent-team/lib        files (a symlink would
 *                                                   resolve back into this
 *                                                   repo and defeat the strip)
 *   gen/node_modules/@deepseek-ai/<pkg>             symlinks standing in for
 *                                                   the host closure
 *
 * Run: `npm run build && node scripts/verify-desktop-strip-boot.mjs`
 * (`--keep` leaves the sandbox for inspection.) Exits nonzero on failure;
 * every step logs, so the output is the acceptance evidence.
 */
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const keep = process.argv.includes('--keep')

// Host-closure stand-ins: everything the booted rows may reach, resolved to
// the same bits the host ships. Deliberately absent:
// `@deepseek-ai/dsh-storage-sqlite` — the host closure has no such package,
// which is the whole of issue #28.
const HOST_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/schemastery',
]

const step = text => console.log(`[strip-boot] ${text}`)
const sandbox = await mkdtemp(join(tmpdir(), 'dsh-desktop-strip-'))
const gen = join(sandbox, 'gen')
const genModules = join(gen, 'node_modules')

try {
  const builtBackend = join(root, 'packages/agent-team/lib/vendor/storage-sqlite/index.js')
  try {
    await readFile(builtBackend)
  } catch {
    throw new Error(`missing built output at ${builtBackend} — run \`npm run build\` first`)
  }

  // 1. Our own files enter the generation as a real copy.
  const ownTarget = join(genModules, '@contexera/dsh-agent-team')
  await mkdir(ownTarget, { recursive: true })
  await cp(join(root, 'package.json'), join(ownTarget, 'package.json'))
  await cp(join(root, 'cordis.patch.yml'), join(ownTarget, 'cordis.patch.yml'))
  await cp(join(root, 'packages/agent-team/lib'), join(ownTarget, 'packages/agent-team/lib'), { recursive: true })
  step(`1. copied our package files into stripped generation (${sandbox})`)

  // 2. Host closure stand-ins; the sqlite package must NOT be among them.
  for (const name of HOST_PACKAGES) {
    const target = require.resolve(`${name}/package.json`)
    const link = join(genModules, ...name.split('/'))
    await mkdir(dirname(link), { recursive: true })
    await symlink(dirname(target), link, 'junction')
  }
  step(`2. planted ${HOST_PACKAGES.length} host-closure stand-ins, no dsh-storage-sqlite`)

  // 3. Negative control: the missing package really is missing from here.
  let absent = false
  try {
    require.resolve('@deepseek-ai/dsh-storage-sqlite', { paths: [gen] })
  } catch {
    absent = true
  }
  if (!absent) throw new Error('negative control failed: dsh-storage-sqlite resolves from the sandbox')
  step('3. negative control holds: @deepseek-ai/dsh-storage-sqlite is unresolvable from the sandbox')

  // 4. Real Loader boot of the storage stack from the stripped baseUrl.
  const storages = join(sandbox, 'storages')
  await mkdir(storages, { recursive: true })
  const configPath = join(gen, 'cordis.yml')
  await writeFile(configPath, [
    '- id: storage',
    "  name: '@deepseek-ai/dsh-storage'",
    '- id: storage-json',
    "  name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(storages)}`,
    '- id: storage-sqlite',
    "  name: '@contexera/dsh-agent-team/sqlite-backend'",
    '  config:',
    `    path: ${JSON.stringify(join(storages, 'agent_team.sqlite'))}`,
    '    journalMode: delete',
    '- id: storage-domain',
    "  name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    '    routes:',
    '      agent_team: sqlite',
    '',
  ].join('\n'))
  const ctx = new Context()
  try {
    ctx.baseUrl = pathToFileURL(gen).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    if (unloaded.length > 0) throw new Error(`rows failed to load: ${unloaded.join(', ')}`)
    step('4. real Loader boot green: storage, storage-json, storage-sqlite, storage-domain all loaded')

    // 5. The routed backend is live: open agent_team on sqlite and round-trip.
    const backend = ctx.get(storageBackendServiceKey('sqlite'))
    if (backend === undefined) throw new Error('sqlite backend did not register on the storage hub')
    const unit = await backend.kv.open({ name: 'agent_team', version: 1, tables: ['operations'], hasGlobal: false })
    await unit.putRecord('operations', 'op:strip-1', { kind: 'team/message-sent', body: 'strip-boot probe' })
    const loaded = await unit.loadAll()
    const record = loaded.tables['operations']?.['op:strip-1']
    if (record === undefined || JSON.stringify(record) !== JSON.stringify({ kind: 'team/message-sent', body: 'strip-boot probe' })) {
      throw new Error(`record round-trip mismatch: ${JSON.stringify(record)}`)
    }
    await ctx.fiber.dispose()
    step('5. agent_team sqlite round-trip green through the stripped generation')
  } finally {
    if (!ctx.fiber.disposed) await ctx.fiber.dispose().catch(() => {})
  }
  step('PASS: Desktop-strip simulation boots and serves agent_team on sqlite')
} finally {
  if (keep) {
    step(`sandbox kept at ${sandbox}`)
  } else {
    await rm(sandbox, { recursive: true, force: true })
  }
}
