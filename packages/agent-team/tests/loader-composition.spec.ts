/** Real-composition proof for the opt-in Agent Team Host row. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import AgentTeam from '../src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function load(pool: MemoryMediaPool): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-team-composition-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: storage',
    "  name: '@deepseek-ai/dsh-storage'",
    '- id: memory',
    '  name: test-memory-storage',
    '- id: storage-domain',
    "  name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: memory',
    '- id: agent-team',
    "  name: '@contexera/dsh-agent-team/host'",
    '',
  ].join('\n'))

  const memoryPlugin = {
    name: 'test-memory-storage',
    inject: ['storage'],
    apply(ctx: Context) {
      const backend = new MemoryStorageBackend(pool)
      ctx.effect(() => {
        const unregister = ctx.storage.backend.register('memory', backend)
        return async () => {
          unregister()
          await backend.close()
        }
      })
      ctx.provide(storageBackendServiceKey('memory'), backend)
    },
  }
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['test-memory-storage', memoryPlugin],
    ['@deepseek-ai/dsh-storage-domain', storageDomain],
    ['@contexera/dsh-agent-team/host', { default: AgentTeam }],
  ])

  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  // Host-side registry in real deployments; the composition under test mounts
  // only the bundle rows, so provide it directly as the host would.
  ctx.provide('workspaceRegistry', {
    get: (id: string) => id.startsWith('workspace:')
      ? { id: id as never, path: root, attachSession: async () => {} }
      : undefined,
    list: () => [],
  })
  ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessions', { flush: async () => true })
  ctx.provide('sessionPersistence', { list: async () => [] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  const unloaded = [...ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  const missing = ['storage', 'storageDomain', 'agentTeam']
    .filter(service => ctx.get(service) === undefined)
  if (missing.length > 0) throw new Error(`composition did not publish: ${missing.join(', ')}`)
  return ctx
}

describe('Agent Team real composition', () => {
  it('boots, reports status, disposes, and replays through Loader rows', async () => {
    const pool = new MemoryMediaPool()
    const first = await load(pool)
    expect(first.agentTeam.status()).toEqual(expect.objectContaining({
      sequence: 1,
      operationCount: 1,
      channelCount: 0,
      agentMemberCount: 0,
    }))
    await first.fiber.dispose()
    expect(first.get('agentTeam')).toBeUndefined()

    const second = await load(pool)
    expect(second.agentTeam.status()).toEqual(expect.objectContaining({ sequence: 1, operationCount: 1 }))
    expect(pool.media.get('agent_team')!.tables.get('operations')!.size).toBe(1)
  })
})
