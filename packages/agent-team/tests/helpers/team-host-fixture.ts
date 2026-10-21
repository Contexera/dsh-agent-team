import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
import * as ToolWorkingDirectory from '@deepseek-ai/dsh-tool-working-directory'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import AgentTeam from '../../src/index.ts'
import { MemoryStorageBackend } from './memory-backend.ts'

/** The repository root, the walk a preset-health resolution and a real profile install both start from. */
const REPOSITORY_ROOT = pathToFileURL(resolve(import.meta.dirname, '../../../../')).href + '/'

export interface TeamMemberHost {
  readonly ctx: Context
  readonly root: string
  readonly workspaceId: WorkspaceId
  readonly teamFiber: Awaited<ReturnType<Context['plugin']>>
  /** One throwaway checkout per requested extra: directories a Member can be invited into. */
  readonly otherProjects: readonly string[]
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
  /** The module-level disposers a spec drains in its `afterAll`. */
  readonly cleanups: Array<() => Promise<void>>
  /**
   * Runs against the Context after every service but before the Team mounts, so
   * a spec can name the fakes its own assertions depend on (see
   * {@link provideQuietTokenMeter}).
   */
  readonly prepare?: ((ctx: Context) => void) | undefined
  /** Sibling checkouts to create beside the project, for a Member invited into a second directory. */
  readonly otherProjects?: number
  readonly workingDirectory?: WorkingDirectorySeat
}

/**
 * Boots a whole Host over a throwaway tree with the team-member preset mounted:
 * the shared boot every policy/skills spec in this package pays once, kept in
 * one place so a lane that stretches one boot cannot stretch N hand-written
 * copies. The caller registers its own LLM adapter afterwards — `registerAdapter`
 * throws on duplicate routes, so the adapter is per-test, not per-host.
 */
export async function mountTeamMemberHost(options: TeamMemberHostOptions): Promise<TeamMemberHost> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-team-host-'))
  const project = join(root, 'project')
  const persistence = join(root, 'sessions')
  const otherProjects = Array.from({ length: options.otherProjects ?? 0 }, (_, index) => join(root, `other-project-${index + 1}`))
  await Promise.all([mkdir(project), mkdir(persistence), ...otherProjects.map(directory => mkdir(directory))])
  process.env.DSH_HOME = join(root, 'dsh-home')

  const ctx = new Context()
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
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const workspaceId = WorkspaceId('workspace:fixture')
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === workspaceId ? { id, path: project, attachSession: async () => {} } : undefined,
    list: () => [],
    archiveSession: async () => {},
  })
  const teamFiber = await ctx.plugin(AgentTeam)
  options.cleanups.push(async () => { await ctx.fiber.dispose(); await facility.closeAll(); await rm(root, { recursive: true, force: true }) })
  return { ctx, root, workspaceId, teamFiber, otherProjects }
}

/** A token meter that always reports zero usage, so pressure is never the input under test. */
export function provideQuietTokenMeter(ctx: Context): void {
  ctx.provide('tokenMeter', { estimateMessage: () => 0, measure: () => ({ totalTokens: 0, nodes: [] }) })
}
