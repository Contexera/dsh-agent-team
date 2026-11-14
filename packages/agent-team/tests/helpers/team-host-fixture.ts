import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import * as ToolWorkingDirectory from '@deepseek-ai/dsh-tool-working-directory'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import AgentTeam from '../../src/index.ts'
import { MemoryStorageBackend } from './memory-backend.ts'

/** The repository root, the walk a preset-health resolution and a real profile install both start from. */
const REPOSITORY_ROOT = pathToFileURL(resolve(import.meta.dirname, '../../../../')).href + '/'

const dshHomeStack: Array<{ readonly previous: string | undefined; active: boolean }> = []
const testCleanupStack: Array<() => Promise<void>> = []

/** Run every cleanup step sequentially so one failure never skips later releases or env restoration. */
export async function runCleanupSteps(steps: ReadonlyArray<() => Promise<void> | void>): Promise<void> {
  const errors: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Multiple cleanup steps failed')
}

/** Drain a file-level cleanup list in LIFO order with exception isolation. */
export async function drainCleanups(cleanups: Array<() => Promise<void>>): Promise<void> {
  const errors: unknown[] = []
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()!
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Multiple cleanups failed')
}

/** Override `process.env.DSH_HOME` and return an idempotent LIFO restorer. */
export function pushDshHome(home: string): () => void {
  const entry = { previous: process.env.DSH_HOME, active: true }
  dshHomeStack.push(entry)
  process.env.DSH_HOME = home
  let restored = false
  return () => {
    if (restored) return
    restored = true
    entry.active = false
    let popped: { readonly previous: string | undefined; active: boolean } | undefined
    while (dshHomeStack.length > 0 && !dshHomeStack[dshHomeStack.length - 1]!.active) {
      popped = dshHomeStack.pop()
    }
    if (popped === undefined) return
    if (popped.previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = popped.previous
  }
}

/** Register an idempotent cleanup with a caller-supplied registrar (`beforeAll`) or Vitest `onTestFinished` in LIFO order. */
export function registerAutoCleanup(
  close: () => Promise<void>,
  registerCleanup?: (fn: () => Promise<void>) => void,
): void {
  if (registerCleanup !== undefined) {
    registerCleanup(close)
    return
  }
  testCleanupStack.push(close)
  onTestFinished(async () => {
    const next = testCleanupStack.pop()
    if (next !== undefined) await next()
  })
}

export interface TeamMemberHost {
  readonly ctx: Context
  readonly root: string
  readonly workspaceId: WorkspaceId
  readonly teamFiber: Awaited<ReturnType<Context['plugin']>>
  /** One throwaway checkout per requested extra: directories a Member can be invited into. */
  readonly otherCheckouts: readonly string[]
  readonly close: () => Promise<void>
}

/**
 * How the boot supplies `workingDirectory`. Every Member surface injects it;
 * the stub answers without touching disk, while `real` mounts the shipped
 * owner and `working_directory` tool so a test can enter a directory and read
 * the Session back through the same service a deployment uses.
 */
export type WorkingDirectorySeat = 'stub' | 'real'

export interface TeamMemberHostOptions {
  /**
   * The team-member preset's own declarative rows. A caller names package rows
   * or `file:` URLs to fixtures beside its spec; this helper owns everything
   * else the preset needs to mount.
   */
  readonly presetPlugins: ReadonlyArray<{ readonly id: string; readonly name: string }>
  /** Optional module-level disposers a `beforeAll` spec drains in its `afterAll`; omit for automatic `onTestFinished` cleanup. */
  readonly cleanups?: Array<() => Promise<void>> | undefined
  /** Optional explicit cleanup registrar for `beforeAll` / `afterAll` callers. */
  readonly registerCleanup?: ((fn: () => Promise<void>) => void) | undefined
  /**
   * Runs against the Context after every service but before the Team mounts, so
   * a spec can name the fakes its own assertions depend on (see
   * {@link provideQuietTokenMeter}).
   */
  readonly prepare?: ((ctx: Context) => void) | undefined
  /** Sibling checkouts to create beside the checkout, for a Member invited into a second directory. */
  readonly otherCheckouts?: number
  readonly workingDirectory?: WorkingDirectorySeat
  /** Parent for the throwaway tree, for a spec that owns the directory it inspects after cleanup. */
  readonly tempParent?: string
  /** Which tool executor the composition selects; the native one is the shipped default. */
  readonly toolExecutor?: 'native' | 'ptc'
}

/**
 * Boots a whole Host over a throwaway tree with the team-member preset mounted:
 * the shared boot every policy/skills spec in this package pays once, kept in
 * one place so a lane that stretches one boot cannot stretch N hand-written
 * copies. The caller registers its own LLM adapter afterwards — `registerAdapter`
 * throws on duplicate routes, so the adapter is per-test, not per-host.
 */
export async function mountTeamMemberHost(options: TeamMemberHostOptions): Promise<TeamMemberHost> {
  const registrar = options.registerCleanup ?? (options.cleanups !== undefined ? fn => options.cleanups!.push(fn) : undefined)
  let root: string | undefined
  let restoreDshHome: (() => void) | undefined
  let ctx: Context | undefined
  let facility: DomainFacility | undefined
  let closed = false

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await runCleanupSteps([
      () => ctx?.fiber.dispose(),
      () => facility?.closeAll(),
      () => {
        if (root !== undefined) return rm(root, { recursive: true, force: true })
        return undefined
      },
      () => { restoreDshHome?.() },
    ])
  }

  registerAutoCleanup(close, registrar)

  try {
    root = await mkdtemp(join(options.tempParent ?? tmpdir(), 'dsh-agent-team-host-'))
    const checkout = join(root, 'checkout')
    const persistence = join(root, 'sessions')
    const otherCheckouts = Array.from({ length: options.otherCheckouts ?? 0 }, (_, index) => join(root!, `other-checkout-${index + 1}`))
    await Promise.all([mkdir(checkout), mkdir(persistence), ...otherCheckouts.map(directory => mkdir(directory))])
    restoreDshHome = pushDshHome(join(root, 'dsh-home'))

    ctx = new Context()
    ctx.baseUrl = REPOSITORY_ROOT
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.group = Group
    if (options.workingDirectory === 'real') {
      await ctx.plugin(FsLocal)
      await ctx.plugin(WorkingDirectory)
    } else {
      provideWorkingDirectoryFixture(ctx)
    }
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    // The registry injects 'sessionProjections'; the roster stays PENDING without it.
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // 0.2.2 moved tool execution behind a selected executor plugin, so a composition that runs tools must name one.
    if (options.toolExecutor === 'ptc') await ctx.plugin(PtcToolExecutor)
    else await ctx.plugin(NativeToolExecutor)
    // The Harness mounts `working_directory` globally in every shipped profile,
    // outside any preset; this boot composes no bundle, so it mounts the tool
    // itself where a test needs the allow-list union to have something real.
    if (options.workingDirectory === 'real') await ctx.plugin(ToolWorkingDirectory)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
    options.prepare?.(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: persistence })
    await ctx.plugin(AgentPresetRegistry, { default: 'team-member' })
    await ctx.plugin(AgentPreset, { id: 'team-member', plugins: options.presetPlugins })
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend())
    facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    const workspaceId = WorkspaceId('workspace:fixture')
    ctx.provide('workspaceRegistry', {
      get: (id: WorkspaceId) => id === workspaceId ? { id, path: checkout, attachSession: async () => {} } : undefined,
      list: () => [],
      archiveSession: async () => {},
    })
    const teamFiber = await ctx.plugin(AgentTeam)
    return { ctx, root, workspaceId, teamFiber, otherCheckouts, close }
  } catch (initError) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([initError, cleanupError], 'mountTeamMemberHost initialization and cleanup both failed')
    }
    throw initError
  }
}

/** A token meter that always reports zero usage, so pressure is never the input under test. */
export function provideQuietTokenMeter(ctx: Context): void {
  ctx.provide('tokenMeter', { estimateMessage: () => 0, measure: () => ({ totalTokens: 0, nodes: [] }) })
}
