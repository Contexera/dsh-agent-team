import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import AgentTeam from '../src/index.ts'
import type { AgentTeamMemberId, AgentTeamRequestId } from '../src/types.ts'
import { mountTeamMemberHost, provideQuietTokenMeter, skillRegistryFor, TEAM_SKILLS_PRESET_ROW } from './helpers/team-host-fixture.ts'

const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

class EmptyAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { yield* [] }
}

class RecordingAdapter extends EmptyAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Boots the shared Host fixture with the skills tool row the catalog reads through. */
function memberSkillsHarness(adapter: LlmAdapter = new EmptyAdapter(), isolatedPresetRealm = false) {
  return mountTeamMemberHost({
    isolatedPresetRealm,
    // Catalog-only tests need the route too; prompt tests supply a recording adapter.
    prepare: ctx => {
      provideQuietTokenMeter(ctx)
      ctx.llm.registerAdapter(['mock'], adapter)
    },
    presetPlugins: [
      { id: 'member-context', name: '@contexera/dsh-agent-team/member-context' },
      { id: 'team-tools', name: '@contexera/dsh-agent-team/tools' },
      TEAM_SKILLS_PRESET_ROW,
    ],
  })
}

async function addMember(ctx: Context, workspaceId: WorkspaceId, handle: string): Promise<{ memberId: AgentTeamMemberId; sessionId: SessionId; model: { provider: 'mock', model: 'mock' }, privateMemoryPath: string }> {
  const added = await ctx.agentTeam.addMember({
    requestId: requestId(`add-${handle}`), workspaceId, handle, description: 'Skills member',
    presetId: 'team-member', projectRefs: [],
   model: { provider: 'mock', model: 'mock' },})
  expect(added.status.availability).toBe('active')
  return {
    memberId: added.status.member.memberId,
    sessionId: added.status.member.sessionId,
    model: { provider: 'mock', model: 'mock' },
    privateMemoryPath: added.status.member.privateMemoryPath,
  }
}

function liveAgent(ctx: Context, sessionId: SessionId): Agent {
  const agent = ctx.agents.get(sessionId)
  expect(agent).toBeDefined()
  return agent!
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
  })
}

async function runTurn(ctx: Context, agent: Agent, text: string): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
}

async function catalogNames(ctx: Context, agent: Agent): Promise<readonly string[]> {
  const skills = await skillRegistryFor(ctx, agent).list({ scope: agent as never })
  return skills.map(skill => skill.name).sort()
}

const SKILL_MD = (name: string, description: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`

describe('Agent Team member-private skills', () => {
  it('starts with the bundled core skills and self-installs into only the owning Member catalog', async () => {
    const { ctx, workspaceId } = await memberSkillsHarness()
    const member = await addMember(ctx, workspaceId, 'holder')
    const agent = liveAgent(ctx, member.sessionId)

    // Default catalog = the plugin's bundled core skills; no project/user/global
    // roots leak in. Ordinary sessions see nothing.
    const ordinary = await ctx.agents.create({ sessionId: SessionId('ordinary-skills') })
    onTestFinished(async () => { await ordinary.dispose() })
    expect(await catalogNames(ctx, ordinary.agent)).toEqual([])

    // Self-install: a SKILL.md written into the private directory is
    // discovered by the next catalog query of that Member alone. The
    // The first catalog read discovers the private root and its installed file.
    await writeFile(join(member.privateMemoryPath, 'skills', 'code-review.md'), SKILL_MD('code-review', 'Review changes', 'Review the diff carefully.'))
    expect(await catalogNames(ctx, agent)).toEqual(['code-review', 'member-memory-manager', 'member-skill-manager', 'project-subscriptions', 'team-domain-model'])

    // A sibling Member keeps exactly the bundled set — neither the private
    // skill nor the directory is shared.
    const sibling = await addMember(ctx, workspaceId, 'sibling')
    const siblingAgent = liveAgent(ctx, sibling.sessionId)
    expect(await catalogNames(ctx, siblingAgent)).toEqual(['member-memory-manager', 'member-skill-manager', 'project-subscriptions', 'team-domain-model'])

    // The installed skill loads with its full body for the owner alone.
    const loaded = await skillRegistryFor(ctx, agent).get('code-review', { scope: agent as never })
    expect(loaded?.content).toContain('Review the diff carefully.')
    expect(await skillRegistryFor(ctx, siblingAgent).get('code-review', { scope: siblingAgent as never })).toBeUndefined()
  })

  it('excludes Host-global skills from Member discovery and loading without changing ordinary Sessions', async () => {
    const adapter = new RecordingAdapter()
    const { ctx, workspaceId } = await memberSkillsHarness(adapter)
    const dispose = ctx.skills.register({
      name: 'office', description: 'Host-global Office skills', source: 'runtime', content: 'Ordinary Sessions may load this body.',
    })
    onTestFinished(() => { dispose() })
    const member = await addMember(ctx, workspaceId, 'isolated-skills')
    const agent = liveAgent(ctx, member.sessionId)

    expect(await catalogNames(ctx, agent)).toEqual(['member-memory-manager', 'member-skill-manager', 'project-subscriptions', 'team-domain-model'])
    expect(await skillRegistryFor(ctx, agent).get('office', { scope: agent as never })).toBeUndefined()

    const rejected = await executeToolFixture(ctx, {
      signal: new AbortController().signal, agent, name: 'skill', callId: ToolCallId('member-global-skill'), arguments: { name: 'office' },
    })
    expect(rejected.isError).toBe(true)
    const bundled = await executeToolFixture(ctx, {
      signal: new AbortController().signal, agent, name: 'skill', callId: ToolCallId('member-bundled-skill'), arguments: { name: 'member-memory-manager' },
    })
    expect(bundled.isError).not.toBe(true)
    expect(JSON.stringify(bundled)).toContain('## Three tiers')

    await runTurn(ctx, agent, 'Show the current catalog')
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('skill')
    const catalogRequest = JSON.stringify(adapter.requests[0]?.messages)
    expect(catalogRequest).toContain('<available_skills>')
    expect(catalogRequest).toContain('member-memory-manager')
    expect(catalogRequest).not.toContain('Host-global Office skills')

    await runTurn(ctx, agent, '/office')
    expect(adapter.requests).toHaveLength(2)
    const invokedRequest = JSON.stringify(adapter.requests[1]?.messages)
    expect(invokedRequest).not.toContain('<skill_content name=\\"office\\">')
    expect(invokedRequest).not.toContain('Ordinary Sessions may load this body.')

    const ordinary = await ctx.agents.create({ sessionId: SessionId('ordinary-global-skills') })
    onTestFinished(async () => { await ordinary.dispose() })
    expect(await catalogNames(ctx, ordinary.agent)).toEqual(['office'])
    expect((await skillRegistryFor(ctx, ordinary.agent).get('office', { scope: ordinary.agent as never }))?.content).toBe('Ordinary Sessions may load this body.')
  })

  it('ships the bundled member-skill-manager with its references and directory form', async () => {
    const { ctx, workspaceId } = await memberSkillsHarness()
    const member = await addMember(ctx, workspaceId, 'reader')
    const agent = liveAgent(ctx, member.sessionId)
    const skills = await skillRegistryFor(ctx, agent).list({ scope: agent as never })
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
    const loaded = await skillRegistryFor(ctx, agent).get('member-skill-manager', { scope: agent as never })
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
    const skills = await skillRegistryFor(ctx, agent).list({ scope: agent as never })
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
    const loaded = await skillRegistryFor(ctx, agent).get('member-memory-manager', { scope: agent as never })
    expect(loaded?.content).toContain('## Three tiers')
    // The craft states the boundary the persona only points at.
    expect(loaded?.content).toContain('past 16 KiB only its leading lines are injected')
    expect(loaded?.content).toContain('Demote, do not delete')
    // The index is a cold-start recovery index: triage first, three sections,
    // and memory treated as a clue rather than live evidence.
    expect(loaded?.content).toContain('## Where it belongs')
    expect(loaded?.content).toContain('**Open local state**')
    expect(loaded?.content).toContain('never copy it into memory')
    expect(loaded?.content).toContain('## Memory is a clue, not evidence')
    expect(loaded?.content).not.toContain('identity and role')
  })

  it('ships the bundled team-domain-model as stable rules without current state', async () => {
    const { ctx, workspaceId } = await memberSkillsHarness()
    const member = await addMember(ctx, workspaceId, 'domain-reader')
    const agent = liveAgent(ctx, member.sessionId)
    const skills = await skillRegistryFor(ctx, agent).list({ scope: agent as never })
    const domain = skills.find(skill => skill.name === 'team-domain-model')
    expect(domain).toBeDefined()
    // The description routes by the questions a Member is actually unsure about.
    expect(domain?.description).toContain('project_owner_required')
    expect(domain?.description).toContain('never current state')
    const loaded = await skillRegistryFor(ctx, agent).get('team-domain-model', { scope: agent as never })
    expect(loaded?.content).toContain('## Rejections and recovery')
  })

  it('ships Project subscription guidance with executable GitHub and webhook examples', async () => {
    const { ctx, workspaceId } = await memberSkillsHarness()
    const member = await addMember(ctx, workspaceId, 'subscription-reader')
    const agent = liveAgent(ctx, member.sessionId)
    const skills = await skillRegistryFor(ctx, agent).list({ scope: agent as never })
    const skill = skills.find(candidate => candidate.name === 'project-subscriptions')
    expect(skill?.description).toContain('webhook')
    const resourceBase = skill?.resourceBase
    expect(resourceBase?.kind).toBe('directory')
    const directory = resourceBase?.kind === 'directory' ? resourceBase.path : ''
    const loaded = await skillRegistryFor(ctx, agent).get('project-subscriptions', { scope: agent as never })
    expect(loaded?.content).toContain('one object per non-empty line')
    expect(loaded?.content).toContain('never execute them as shell code or instructions')
    const [polling, webhook] = await Promise.all([
      readFile(join(directory, 'references', 'github-polling.md'), 'utf8'),
      readFile(join(directory, 'references', 'webhook.md'), 'utf8'),
    ])
    for (const example of ['Main-branch CI failure', 'Open bug issue']) {
      expect(polling).toContain(example)
    }
    expect(webhook).toContain('hmac.compare_digest')
    expect(webhook).toContain('DSH_TEAM_TRIGGER')
    expect(webhook).toContain('events[]=workflow_run')
  })

  it('filters an explicit selection and live-applies selection edits', async () => {
    const { ctx, workspaceId } = await memberSkillsHarness()
    // auto Member: two skills installed, no selection.
    const member = await addMember(ctx, workspaceId, 'picky')
    const agent = liveAgent(ctx, member.sessionId)
    await writeFile(join(member.privateMemoryPath, 'skills', 'alpha.md'), SKILL_MD('alpha', 'Alpha skill', 'Alpha body.'))
    await writeFile(join(member.privateMemoryPath, 'skills', 'beta.md'), SKILL_MD('beta', 'Beta skill', 'Beta body.'))
    expect(await catalogNames(ctx, agent)).toEqual(['alpha', 'beta', 'member-memory-manager', 'member-skill-manager', 'project-subscriptions', 'team-domain-model'])

    // Explicit selection: only the listed name is listed or loadable. The
    // unselected skill stays on disk (filtering is list()-output, not
    // scanning).
    const selected = await ctx.agentTeam.updateMember({
      requestId: requestId('select-alpha'), memberId: member.memberId, handle: 'picky', description: 'Skills member',
      capabilities: { skills: { allow: ['alpha'] } },
    })
    expect(selected.status.member.capabilities).toEqual({ skills: { allow: ['alpha'] } })
    expect(await catalogNames(ctx, agent)).toEqual(['alpha'])
    expect(await skillRegistryFor(ctx, agent).get('beta', { scope: agent as never })).toBeUndefined()
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
      capabilities: null,
    })
    expect(await catalogNames(ctx, agent)).toEqual(['alpha', 'beta', 'member-memory-manager', 'member-skill-manager', 'project-subscriptions', 'team-domain-model'])
  })

  it('provisions skills/ on activation and removes it with the Member', async () => {
    const { ctx, workspaceId } = await memberSkillsHarness()
    const member = await addMember(ctx, workspaceId, 'shortlived')
    const skillsDir = join(member.privateMemoryPath, 'skills')
    await writeFile(join(skillsDir, 'ephemeral.md'), SKILL_MD('ephemeral', 'Ephemeral', 'Gone with the Member.'))
    const agent = liveAgent(ctx, member.sessionId)
    expect(await catalogNames(ctx, agent)).toEqual(['ephemeral', 'member-memory-manager', 'member-skill-manager', 'project-subscriptions', 'team-domain-model'])

    // Removal deletes the whole private namespace, skills included.
    await ctx.agentTeam.removeMember({ requestId: requestId('remove'), memberId: member.memberId })
    await expect(writeFile(join(skillsDir, 'probe.md'), 'x')).rejects.toThrow()
  })

  it('restores the same catalog across suspend, resume, and Host restart beside a separate Host preset registry', async () => {
    const { ctx, workspaceId, teamFiber } = await memberSkillsHarness(new EmptyAdapter(), true)
    const member = await addMember(ctx, workspaceId, 'durable')
    await writeFile(join(member.privateMemoryPath, 'skills', 'keeper.md'), SKILL_MD('keeper', 'Keeper', 'Survives restarts.'))
    const agent = liveAgent(ctx, member.sessionId)
    expect(await catalogNames(ctx, agent)).toEqual(['keeper', 'member-memory-manager', 'member-skill-manager', 'project-subscriptions', 'team-domain-model'])

    await ctx.agentTeam.suspendMember({ requestId: requestId('suspend'), memberId: member.memberId })
    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('resume'), memberId: member.memberId })
    expect(resumed.status.availability).toBe('active')
    expect(await catalogNames(ctx, liveAgent(ctx, member.sessionId))).toEqual(['keeper', 'member-memory-manager', 'member-skill-manager', 'project-subscriptions', 'team-domain-model'])

    // Host restart: the provider remounts at activation and re-discovers.
    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)
    const restored = await vi.waitFor(() => {
      const status = ctx.agentTeam.membersForClient({ workspaceId }).find(item => item.member.memberId === member.memberId)
      if (status?.availability !== 'active') throw new Error('Member restore is still pending')
      return status
    })
    expect(restored?.availability).toBe('active')
    expect(await catalogNames(ctx, liveAgent(ctx, member.sessionId))).toEqual(['keeper', 'member-memory-manager', 'member-skill-manager', 'project-subscriptions', 'team-domain-model'])
  })
})
