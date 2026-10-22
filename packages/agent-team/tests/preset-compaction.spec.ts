import { readFileSync } from 'node:fs'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { resolveConfig } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

const root = resolve(import.meta.dirname, '../../..')
const ROUTE = 'team-route'
const SUMMARY_ROUTE = 'team-summary'

interface Row {
  readonly id?: string
  readonly name?: string
  readonly config?: Record<string, unknown>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

/** The preset's `compaction-basic` row, read through the shipped patch loader. */
function shippedRow(): Row {
  const visit = (entry: unknown): Row | undefined => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const row = entry as Row
    if (row.id === 'compaction-basic') return row
    for (const value of Object.values(entry)) {
      const nested = Array.isArray(value)
        ? value.map(visit).find(found => found !== undefined)
        : visit(value)
      if (nested !== undefined) return nested
    }
    return undefined
  }
  const found = loadOverlayPatches('preset compaction', resolve(root, 'cordis.patch.yml'))
    .map(visit).find(row => row !== undefined)
  if (found === undefined) throw new Error('cordis.patch.yml no longer declares a compaction-basic row')
  return found
}

class KeylessAdapter extends LlmAdapter {
  readonly summaries: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 8000 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const trailing = options.messages.at(-1)?.content
      .map(block => (block.type === 'text' ? block.text : '')).join('') ?? ''
    const summarizing = trailing.includes('acting as a compaction engine')
    if (summarizing) this.summaries.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: summarizing ? 'Earlier work completed.' : 'TASK COMPLETE' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('the preset compaction row', () => {
  it('names the Harness engine and keeps the shipped waterline', () => {
    const row = shippedRow()
    expect(row.name).toBe('@deepseek-ai/dsh-compaction-basic')
    const exports = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { exports: Record<string, unknown> }
    expect(exports.exports['./team-compaction-engine']).toBeUndefined()
    const resolution = createRequire(pathToFileURL(join(root, 'package.json')).href)
    expect(JSON.parse(readFileSync(resolution.resolve(`${row.name}/package.json`), 'utf8')) as { name: string })
      .toMatchObject({ name: row.name })

    // The Loader validates a row against the plugin's Config before mounting,
    // so the shipped text has to be a legal engine config on its own. `auto`
    // is upstream's default now, which is what turns automatic compaction on
    // without a bundle-owned field.
    const resolved = resolveConfig(BasicCompactionEngine.Config(row.config ?? {}) as never)
    expect(resolved).toMatchObject({
      auto: true,
      thresholdRatio: 0.256,
      retainRatio: 0.08,
      headroomTokens: 65_536,
      summarizationProvider: '',
      summarizationModel: '',
    })
  })

  it('runs one automatic compaction that keeps the profile policy over a route', async () => {
    const adapter = new KeylessAdapter()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TokenMeter)
    ctx.llm.registerAdapter([ROUTE, SUMMARY_ROUTE], adapter)

    const row = shippedRow()
    const profile = await mkdtemp(join(tmpdir(), 'dsh-preset-compaction-'))
    cleanups.push(() => rm(profile, { recursive: true, force: true }))
    await symlink(join(root, 'node_modules'), join(profile, 'node_modules'), 'dir')
    const configPath = join(profile, 'cordis.yml')
    await writeFile(configPath, yaml.stringify([{
      ...row,
      // A deployment keeps the preset's config and adds its route policy at
      // the profile level, as the shipped comment instructs.
      config: {
        ...row.config,
        modelPolicies: [{
          provider: ROUTE,
          model: ROUTE,
          thresholdRatio: 0.2,
          headroomTokens: 1024,
          retainRatio: 0.02,
          summarizationProvider: SUMMARY_ROUTE,
          summarizationModel: SUMMARY_ROUTE,
          maxTokens: 256,
        }],
      },
    }]))
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === row.name)
    expect(entry?.fiber?.state, 'the preset row did not activate').toBeDefined()
    // The row composed the module's own default class, not a subclass: the
    // instance's prototype IS the prototype of what the Loader imported.
    const Engine = (entry?.moduleNamespace as { default?: typeof BasicCompactionEngine } | undefined)?.default
    expect(Engine).toBeDefined()
    expect(ctx.get('compaction')).toBeInstanceOf(Engine)
    expect(Object.getPrototypeOf(ctx.get('compaction'))).toBe(Engine!.prototype)

    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('preset-auto-compaction'), { provider: ROUTE, model: ROUTE })
    const compacted = (): boolean => agent.session.snapshotEvents()
      .some(event => event.type === 'compaction/summary')
    // Ordinary turns until the engine decides pressure crossed its own trigger;
    // nothing here drives compaction directly.
    for (let turn = 1; turn <= 12 && !compacted(); turn += 1) {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: `Turn ${turn}. ` + 'Old context evidence. '.repeat(60) }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
    }
    expect(compacted()).toBe(true)

    // The route policy chose the summary target and cap, not the engine default.
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.summaries[0]).toMatchObject({
      provider: SUMMARY_ROUTE, model: SUMMARY_ROUTE, maxTokens: 256, purpose: 'compaction',
    })
    const instruction = adapter.summaries[0]?.messages.at(-1)?.content
      .map(block => (block.type === 'text' ? block.text : '')).join('') ?? ''
    expect(instruction).toContain('## Primary Request and Intent')

    const events = agent.session.snapshotEvents()
    expect(events.find(event => event.type === 'compaction/summary')).toMatchObject({
      type: 'compaction/summary',
      data: { provider: SUMMARY_ROUTE, model: SUMMARY_ROUTE, maxTokens: 256 },
    })
    expect(events.some(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text.includes('<compacted-summary>')))).toBe(true)
    expect(events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
  })
})
