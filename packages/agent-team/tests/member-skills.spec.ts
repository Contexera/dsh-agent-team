import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import AgentTeam from '../src/index.ts'
import type { AgentTeamMemberId, AgentTeamRequestId } from '../src/types.ts'
import { MemoryStorageBackend } from './helpers/memory-backend.ts'

const cleanups: Array<() => Promise<void>> = []
const originalDshHome = process.env.DSH_HOME
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
})

class EmptyAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { yield* [] }
}

async function memberSkillsHarness(): Promise<{
  readonly ctx: Context
  readonly workspaceId: WorkspaceId
  readonly root: string
  readonly teamFiber: Awaited<ReturnType<Context['plugin']>>
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-team-skills-'))
  const project = join(root, 'project')
  const persistence = join(root, 'sessions')
  await Promise.all([mkdir(project), mkdir(persistence)])
  process.env.DSH_HOME = join(root, 'dsh-home')
  // The team-member definition as one declarative row; bare internal loader
  // names resolve through the linked node_modules (the bundle self-link plus
  // harness checkout links).
  const teamMemberPlugins = [
    { id: 'member-context', name: '@contexera/dsh-agent-team/member-context' },
    { id: 'team-tools', name: '@contexera/dsh-agent-team/tools' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
  ]

  const ctx = new Context()
  // rc.1: preset health resolves package rows by walking node_modules above
  // ctx.baseUrl — point at this repository, where the harness and bundle
  // packages are linked, as a real profile install would.
  ctx.baseUrl = pathToFileURL(resolve(import.meta.dirname, '../../../')).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], new EmptyAdapter())
  await ctx.plugin(SessionStore)
  // The registry injects 'sessionProjections'; the roster stays PENDING without it.
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  await ctx.plugin(JsonlSessionPersistence, { root: persistence })
  await ctx.plugin(AgentPresetRegistry, { default: 'team-member' })
  await ctx.plugin(AgentPreset, { id: 'team-member', plugins: teamMemberPlugins })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const workspaceId = WorkspaceId('workspace:skills-test')
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === workspaceId ? { id, path: project, attachSession: async () => {} } : undefined,
    list: () => [],
    archiveSession: async () => {},
  })
  const teamFiber = await ctx.plugin(AgentTeam)
  cleanups.push(async () => { await ctx.fiber.dispose(); await facility.closeAll(); await rm(root, { recursive: true, force: true }) })
  return { ctx, workspaceId, root, teamFiber }
}

async function addMember(ctx: Context, workspaceId: WorkspaceId, handle: string): Promise<{ memberId: AgentTeamMemberId; sessionId: SessionId; privateMemoryPath: string }> {
  const added = await ctx.agentTeam.addMember({
    requestId: requestId(`add-${handle}`), workspaceId, handle, description: 'Skills member',
    presetId: 'team-member', channelRefs: [],
  })
  expect(added.status.availability).toBe('active')
  return {
    memberId: added.status.member.memberId,
    sessionId: added.status.member.sessionId,
    privateMemoryPath: added.status.member.privateMemoryPath,
  }
}

function liveAgent(ctx: Context, sessionId: SessionId): Agent {
  const agent = ctx.agents.get(sessionId)
  expect(agent).toBeDefined()
  return agent!
}

async function catalogNames(ctx: Context, agent: Agent): Promise<readonly string[]> {
  const skills = await ctx.skills.list({ scope: agent as never })
  return skills.map(skill => skill.name).sort()
}

const SKILL_MD = (name: string, description: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`

describe('Agent Team member-private skills', () => {
  it('starts with the bundled core skills and self-installs into only the owning Member catalog', async () => {
    const { ctx, workspaceId } = await memberSkillsHarness()
    const member = await addMember(ctx, workspaceId, 'holder')
    const agent = liveAgent(ctx, member.sessionId)

    // Default catalog = the plugin's bundled core skills (the two meta
    // skills); no project/user/global roots leak in. Ordinary sessions see
    // nothing.
    expect(await catalogNames(ctx, agent)).toEqual(['member-memory-manager', 'member-skill-manager'])
    const ordinary = await ctx.agents.create({ sessionId: SessionId('ordinary-skills') })
    cleanups.push(async () => { await ordinary.dispose() })
    expect(await catalogNames(ctx, ordinary.agent)).toEqual([])

    // Self-install: a SKILL.md written into the private directory is
    // discovered by the next catalog query of that Member alone. The
    // filesystem watcher needs its stability window, so wait for the
    // discovery rather than racing it.
    await writeFile(join(member.privateMemoryPath, 'skills', 'code-review.md'), SKILL_MD('code-review', 'Review changes', 'Review the diff carefully.'))
    await vi.waitFor(async () => {
      expect(await catalogNames(ctx, agent)).toEqual(['code-review', 'member-memory-manager', 'member-skill-manager'])
    })

    // A sibling Member keeps exactly the bundled set — neither the private
    // skill nor the directory is shared.
    const sibling = await addMember(ctx, workspaceId, 'sibling')
    const siblingAgent = liveAgent(ctx, sibling.sessionId)
    expect(await catalogNames(ctx, siblingAgent)).toEqual(['member-memory-manager', 'member-skill-manager'])

    // The installed skill loads with its full body for the owner alone.
    const loaded = await ctx.skills.get('code-review', { scope: agent as never })
    expect(loaded?.content).toContain('Review the diff carefully.')
    expect(await ctx.skills.get('code-review', { scope: siblingAgent as never })).toBeUndefined()
  })

  it('ships the bundled member-skill-manager with its references and directory form', async () => {
    const { ctx, workspaceId } = await memberSkillsHarness()
    const member = await addMember(ctx, workspaceId, 'reader')
    const agent = liveAgent(ctx, member.sessionId)
    const skills = await ctx.skills.list({ scope: agent as never })
    const meta = skills.find(skill => skill.name === 'member-skill-manager')
    expect(meta).toBeDefined()
    // Directory form: the candidate's resource base is the skill directory,
    // so relative references inside the skill resolve beside SKILL.md.
    // Directory form: the summary's resource base is the skill directory.
    const resourceBase = meta?.resourceBase
    expect(resourceBase?.kind).toBe('directory')
    const directory = resourceBase?.kind === 'directory' ? resourceBase : undefined
    expect(directory?.path.endsWith('member-skill-manager')).toBe(true)
    expect(meta?.description).toContain('private skills')
    const loaded = await ctx.skills.get('member-skill-manager', { scope: agent as never })
    expect(loaded?.content).toContain('## Configuration and credentials')
    // The reference file the skill links actually exists on disk, resolved
    // beside the SKILL.md inside the skill directory.
    const reference = join(directory!.path, 'references', 'writing-great-skills.md')
    expect((await readFile(reference, 'utf8'))).toContain('The description is the skill')
  })

  it('ships the bundled member-memory-manager with the index craft in directory form', async () => {
    const { ctx, workspaceId } = await memberSkillsHarness()
    const member = await addMember(ctx, workspaceId, 'memory-reader')
    const agent = liveAgent(ctx, member.sessionId)
    const skills = await ctx.skills.list({ scope: agent as never })
    const memory = skills.find(skill => skill.name === 'member-memory-manager')
    expect(memory).toBeDefined()
    const resourceBase = memory?.resourceBase
    expect(resourceBase?.kind).toBe('directory')
    const directory = resourceBase?.kind === 'directory' ? resourceBase : undefined
    expect(directory?.path.endsWith('member-memory-manager')).toBe(true)
    // The description is the only index entry a Member routes by, so it names
    // the real triggers: the injected block, the budget, and note upkeep.
    expect(memory?.description).toContain('memory.md')
    expect(memory?.description).toContain('maintenance warning')
    const loaded = await ctx.skills.get('member-memory-manager', { scope: agent as never })
    expect(loaded?.content).toContain('## Three tiers')
    // The craft states the boundary the persona only points at.
    expect(loaded?.content).toContain('past 16 KiB the index is not injected at all')
    expect(loaded?.content).toContain('Demote, do not delete')
  })

  it('filters an explicit selection and live-applies selection edits', async () => {
    const { ctx, workspaceId } = await memberSkillsHarness()
    // auto Member: two skills installed, no selection.
    const member = await addMember(ctx, workspaceId, 'picky')
    const agent = liveAgent(ctx, member.sessionId)
    await writeFile(join(member.privateMemoryPath, 'skills', 'alpha.md'), SKILL_MD('alpha', 'Alpha skill', 'Alpha body.'))
    await writeFile(join(member.privateMemoryPath, 'skills', 'beta.md'), SKILL_MD('beta', 'Beta skill', 'Beta body.'))
    await vi.waitFor(async () => {
      expect(await catalogNames(ctx, agent)).toEqual(['alpha', 'beta', 'member-memory-manager', 'member-skill-manager'])
    })

    // Explicit selection: only the listed name is listed or loadable. The
    // unselected skill stays on disk (filtering is list()-output, not
    // scanning).
    const selected = await ctx.agentTeam.updateMember({
      requestId: requestId('select-alpha'), memberId: member.memberId, handle: 'picky', description: 'Skills member',
      capabilities: { skills: { allow: ['alpha'] } },
    })
    expect(selected.status.member.capabilities).toEqual({ skills: { allow: ['alpha'] } })
    expect(await catalogNames(ctx, agent)).toEqual(['alpha'])
    expect(await ctx.skills.get('beta', { scope: agent as never })).toBeUndefined()
    expect(await catalogNames(ctx, agent)).not.toContain('beta')

    // Widening the selection live-swaps in the same Session.
    await ctx.agentTeam.updateMember({
      requestId: requestId('select-both'), memberId: member.memberId, handle: 'picky', description: 'Skills member',
      capabilities: { skills: { allow: ['alpha', 'beta'] } },
    })
    expect(await catalogNames(ctx, agent)).toEqual(['alpha', 'beta'])

    // Clearing the override returns to auto (bundled plus discovered).
    await ctx.agentTeam.updateMember({
      requestId: requestId('select-auto'), memberId: member.memberId, handle: 'picky', description: 'Skills member',
    })
    expect(await catalogNames(ctx, agent)).toEqual(['alpha', 'beta', 'member-memory-manager', 'member-skill-manager'])
  })

  it('provisions skills/ on activation and removes it with the Member', async () => {
    const { ctx, workspaceId } = await memberSkillsHarness()
    const member = await addMember(ctx, workspaceId, 'shortlived')
    const skillsDir = join(member.privateMemoryPath, 'skills')
    await writeFile(join(skillsDir, 'ephemeral.md'), SKILL_MD('ephemeral', 'Ephemeral', 'Gone with the Member.'))
    const agent = liveAgent(ctx, member.sessionId)
    await vi.waitFor(async () => {
      expect(await catalogNames(ctx, agent)).toEqual(['ephemeral', 'member-memory-manager', 'member-skill-manager'])
    })

    // Removal deletes the whole private namespace, skills included.
    await ctx.agentTeam.removeMember({ requestId: requestId('remove'), memberId: member.memberId })
    await expect(writeFile(join(skillsDir, 'probe.md'), 'x')).rejects.toThrow()
  })

  it('restores the same catalog across suspend, resume, and Host restart', async () => {
    const { ctx, workspaceId, teamFiber } = await memberSkillsHarness()
    const member = await addMember(ctx, workspaceId, 'durable')
    await writeFile(join(member.privateMemoryPath, 'skills', 'keeper.md'), SKILL_MD('keeper', 'Keeper', 'Survives restarts.'))
    const agent = liveAgent(ctx, member.sessionId)
    await vi.waitFor(async () => {
      expect(await catalogNames(ctx, agent)).toEqual(['keeper', 'member-memory-manager', 'member-skill-manager'])
    })

    await ctx.agentTeam.suspendMember({ requestId: requestId('suspend'), memberId: member.memberId })
    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('resume'), memberId: member.memberId })
    expect(resumed.status.availability).toBe('active')
    expect(await catalogNames(ctx, liveAgent(ctx, member.sessionId))).toEqual(['keeper', 'member-memory-manager', 'member-skill-manager'])

    // Host restart: the provider remounts at activation and re-discovers.
    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)
    const restored = ctx.agentTeam.membersForClient({ workspaceId }).find(item => item.member.memberId === member.memberId)
    expect(restored?.availability).toBe('active')
    expect(await catalogNames(ctx, liveAgent(ctx, member.sessionId))).toEqual(['keeper', 'member-memory-manager', 'member-skill-manager'])
  })
})
