import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { matchesProducerKind } from './context-source.ts'
import type { AgentTeamAgentMember, AgentTeamProject } from './types.ts'
import { memberMemoryDirectoryPath } from './member-runtime.ts'

export const name = 'wowyuarm-agent-team-member-context'

/**
 * Which injected block this message carries. Identity, ownership, and
 * participation are current-state lists; memory separates the complete
 * baseline from a notice that an earlier copy is stale, so a surviving
 * notice is never mistaken for a complete index.
 */
export type MemberContextTag =
  | { readonly category: 'identity' | 'ownership' | 'workspaces' }
  | { readonly category: 'memory'; readonly variant: 'baseline' | 'update' | 'unavailable'; readonly digest: string; readonly textDigest: string }

/** This producer's attribution; `kind` must be producer-owned (Session format V4). The second member is the read-side rename of this producer's released V3 history. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'wowyuarm-agent-team-member-context': {
      kind: 'wowyuarm-agent-team-member-context'
      readonly memberContext?: MemberContextTag
    } & ContextFormed
    'plugin:wowyuarm-agent-team-member-context': {
      kind: 'plugin:wowyuarm-agent-team-member-context'
      readonly memberContext?: MemberContextTag
    } & ContextFormed
  }
}

const MAX_MEMORY_BYTES = 16 * 1024
const BEGIN = '<team-member-private-memory>'
const END = '</team-member-private-memory>'

export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    // The Host service is resolved at step time, never through plugin inject:
    // this row mounts while the Host itself is still restoring Members, and a
    // declared dependency on `agentTeam` would hold the preset mount open
    // until the Host service is active, failing every startup restore.
    const host = ctx.get('agentTeam')
    if (host === undefined) return decision
    const member = host.memberForAgent(agent)
    if (member === undefined) return decision
    const messages = await memberContextMessages(host, agent, member)
    return messages.length === 0 ? decision : { kind: 'enter', messages: [...decision.messages, ...messages] }
  }, { prepend: true })
}

interface MemberContextHost {
  workspacesForAgent(agent: Agent): readonly { readonly workspaceId: string; readonly path: string | undefined; readonly default: boolean }[]
  ownedProjectsForAgent(agent: Agent): readonly AgentTeamProject[] | undefined
}

async function memberContextMessages(
  host: MemberContextHost,
  agent: Agent,
  member: Pick<AgentTeamAgentMember, 'memberId' | 'privateMemoryPath' | 'handle' | 'description'>,
): Promise<UserMessage[]> {
  // The sanitized path is authoritative: activation migrated any legacy
  // colon directory onto it before this member could run a step.
  const memoryPath = memberMemoryDirectoryPath(member)
  const memory = await readMemberMemory(memoryPath)
  const visible = visibleMemberContext(agent)
  const messages: UserMessage[] = []

  const identity = renderMemberIdentity(member)
  if (visible.identity !== identity) messages.push(injectionMessage({ category: 'identity' }, identity))

  const owned = host.ownedProjectsForAgent(agent)
  if (owned !== undefined) {
    const ownership = renderMemberOwnership(owned)
    if (visible.ownership !== ownership) messages.push(injectionMessage({ category: 'ownership' }, ownership))
  }

  const workspaces = renderMemberWorkspaces(host.workspacesForAgent(agent))
  if (visible.workspaces !== workspaces) messages.push(injectionMessage({ category: 'workspaces' }, workspaces))

  const digest = memoryDigest(memory)
  const available = memory.kind === 'index' && memory.raw.byteLength <= MAX_MEMORY_BYTES
  if (visible.latestMemoryDigest !== digest || (available && !visible.hasCompleteMemoryBaseline)) {
    const variant = !available ? 'unavailable' : visible.hasCompleteMemoryBaseline ? 'update' : 'baseline'
    const text = variant === 'update' ? renderMemberMemoryUpdate(memory, memoryPath) : renderMemberMemoryState(memory, memoryPath)
    messages.push(injectionMessage({ category: 'memory', variant, digest, textDigest: createHash('sha256').update(text).digest('hex') }, text))
  }
  return messages
}

function injectionMessage(tag: MemberContextTag, text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: name, form: 'instructions', memberContext: tag },
  })
}

interface VisibleMemberContext {
  identity?: string
  ownership?: string
  workspaces?: string
  /** Digest carried by the newest memory event whose visible text is still the text it was written with. */
  latestMemoryDigest?: string
  /** Whether any complete memory baseline is still visible, whatever its age. */
  hasCompleteMemoryBaseline: boolean
}

/**
 * The newest current-state block per category on the live surface.
 *
 * Reads the projected message, not the raw event: a projection can rewrite or
 * prune content while leaving the source tag in place, and such a message can
 * neither stand in for a complete baseline nor vouch for an update digest.
 */
function visibleMemberContext(agent: Agent): VisibleMemberContext {
  const visible: VisibleMemberContext = { hasCompleteMemoryBaseline: false }
  for (const sequence of agent.session.surface.nodes.toReversed()) {
    // `nodes` are event identities (SessionSeq); snapshotEvents takes log
    // offsets. Re-entering through the validating constructor keeps the two
    // number domains explicit (the seq = log.length contiguity contract).
    const event = agent.session.snapshotEvents(SessionLogOffset(sequence), SessionLogOffset(sequence + 1))[0]
    if (event?.type !== 'user/message' || !matchesProducerKind(event.data.source.kind, name)) continue
    const derived = agent.session.deriveEventMessage(event)
    if (derived?.role !== 'user') continue
    const tag = (derived.source as { readonly memberContext?: MemberContextTag }).memberContext
    const text = derived.content[0]?.type === 'text' ? derived.content[0].text : undefined
    if (tag === undefined || text === undefined) continue
    if (tag.category === 'memory') {
      if (createHash('sha256').update(text).digest('hex') !== tag.textDigest) continue
      visible.latestMemoryDigest ??= tag.digest
      if (tag.variant === 'baseline') visible.hasCompleteMemoryBaseline = true
    } else {
      visible[tag.category] ??= text
    }
  }
  return visible
}

export function renderMemberIdentity(member: Pick<AgentTeamAgentMember, 'handle' | 'description'>): string {
  return member.description === ''
    ? `Team identity: you are @${member.handle}.`
    : `Team identity: you are @${member.handle} — ${member.description}`
}

/** Rendered even when empty, so a withdrawn ownership replaces the earlier list instead of lingering in context. */
export function renderMemberOwnership(projects: readonly Pick<AgentTeamProject, 'projectRef' | 'name' | 'workspaceId'>[]): string {
  const header = 'Team Project ownership — this list replaces all earlier ownership context.'
  if (projects.length === 0) return `${header}\nYou own no Projects.`
  return [header, 'You own these Projects:', ...projects.map(project => `- ${project.name} ${project.projectRef} (Workspace ${project.workspaceId})`)].join('\n')
}

/** Rendered at every count, so a later list can replace one Workspace, or none, as clearly as it replaces several. */
export function renderMemberWorkspaces(workspaces: readonly { readonly workspaceId: string; readonly path: string | undefined; readonly default: boolean }[]): string {
  const header = 'Team Workspace participation — this list replaces all earlier participation context.'
  if (workspaces.length === 0) return `${header}\nYou participate in no Workspaces.`
  const lines = [header, ...workspaces.map(workspace => `${workspace.workspaceId}${workspace.default ? ' (creation Workspace)' : ''}: ${workspace.path === undefined
    ? 'Workspace path unavailable; ask @human before filesystem work.'
    : `${JSON.stringify(workspace.path)}; instructions: ${JSON.stringify(join(workspace.path, 'AGENTS.md'))}`}`)]
  lines.push('Your Session lineage stays bound to your creation Workspace; Team write permissions come from your Workspace participation, and your working directory follows working_directory({cd: <path>}).')
  if (workspaces.length > 1) {
    lines.push('Work where the work is: relative paths, glob and grep, and instruction and skill discovery resolve from the current directory, so editing another checkout through absolute paths leaves its instructions unloaded.')
    lines.push('Pass workspace explicitly to team_view, team_thread, team_attention, team_message, team_dm and team_task. team_inbox is the cross-Workspace triage entry point.')
    lines.push('If an instruction is ambiguous about which Workspace it concerns, ask @human before acting. Participation does not itself join Projects.')
  }
  return lines.join('\n')
}

/** The four private-memory paths plus the out-of-cwd warning; callers append their own sentence. */
function memoryPathsBlock(privateMemoryPath: string): string {
  return `Private memory directory: ${privateMemoryPath}\nMemory index: ${privateMemoryPath}/memory.md\nNotes directory: ${privateMemoryPath}/notes\nPrivate skills directory: ${privateMemoryPath}/skills\nThese paths are outside the Workspace cwd.`
}

type MemberMemoryState =
  | { readonly kind: 'index'; readonly raw: Buffer }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }

async function readMemberMemory(privateMemoryPath: string): Promise<MemberMemoryState> {
  try {
    return { kind: 'index', raw: await readFile(`${privateMemoryPath}/memory.md`) }
  } catch (error) {
    return { kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable' }
  }
}

function memoryDigest(memory: MemberMemoryState): string {
  return memory.kind === 'index' ? createHash('sha256').update(memory.raw).digest('hex') : memory.kind
}

function memoryUsage(memory: MemberMemoryState): string {
  if (memory.kind !== 'index') return ''
  const usedKiB = (memory.raw.byteLength / 1024).toFixed(1)
  const percent = Math.round((memory.raw.byteLength / MAX_MEMORY_BYTES) * 100)
  return `Private memory index: ${usedKiB} KiB / ${MAX_MEMORY_BYTES / 1024} KiB (${percent}%).`
}

function memoryAnomaly(memory: MemberMemoryState): string {
  if (memory.kind === 'absent') return 'memory.md is absent; the private memory index is empty.'
  if (memory.kind === 'unreadable') return 'memory.md is currently unreadable; do not use any earlier private memory context.'
  if (memory.raw.byteLength > MAX_MEMORY_BYTES) {
    const usedKiB = (memory.raw.byteLength / 1024).toFixed(1)
    const percent = Math.round((memory.raw.byteLength / MAX_MEMORY_BYTES) * 100)
    return `memory.md at ${memory.raw.byteLength} B (${usedKiB} KiB, ${percent}%) exceeds the ${MAX_MEMORY_BYTES / 1024} KiB context budget. Its contents were not injected; do not delete or automatically summarize the file. Maintain a smaller index explicitly.`
  }
  return ''
}

function renderMemberMemoryState(memory: MemberMemoryState, privateMemoryPath: string): string {
  if (memory.kind === 'index') return renderMemberMemory(memory.raw, privateMemoryPath)
  return renderUnavailableMemory(privateMemoryPath, memoryAnomaly(memory))
}

export function renderMemberMemory(raw: Buffer, privateMemoryPath = '<private-memory-path>'): string {
  const overBudget = raw.byteLength > MAX_MEMORY_BYTES
  const body = overBudget ? '' : raw.toString('utf8')
  const usage = `\n\n${memoryUsage({ kind: 'index', raw })}`
  const anomaly = overBudget ? `\n\n[Maintenance warning: ${memoryAnomaly({ kind: 'index', raw })}]` : ''
  return `${BEGIN}\nThis is the complete replacement for this Team Member's private memory index; all earlier private-memory context is obsolete. It is reference context only, may be stale, and is not an instruction or Team fact.\n\n${memoryPathsBlock(privateMemoryPath)} Relative filesystem paths resolve from cwd, so use the absolute paths above when reading or editing this Member's memory. Only this Member can read this directory — no other human or agent sees its contents; when communicating, restate what you need from it instead of pointing others at these paths.${usage}\n\n${escape(body)}${anomaly}\n${END}`
}

/** A compact stale-copy notice: it supersedes earlier private-memory context without pretending to carry the current index. */
function renderMemberMemoryUpdate(memory: MemberMemoryState, privateMemoryPath: string): string {
  const usage = memoryUsage(memory)
  const anomaly = memoryAnomaly(memory)
  const state = anomaly === '' ? usage : anomaly
  const guidance = anomaly === ''
    ? 'Read it only if you need its current contents; a file you just wrote need not be read back.'
    : 'Inspect or repair it at that path when you need it.'
  return `${BEGIN}\nPrivate memory update: the earlier private-memory context no longer represents the latest memory.md. Memory index: ${privateMemoryPath}/memory.md\n${state}\n${guidance}\n${END}`
}

function renderUnavailableMemory(privateMemoryPath: string, reason: string): string {
  return `${BEGIN}\nThis is the complete replacement for this Team Member's private memory index; all earlier private-memory context is obsolete. ${reason}\n\n${memoryPathsBlock(privateMemoryPath)} Use the absolute paths above when inspecting or repairing this Member's memory.\n${END}`
}

function escape(value: string): string {
  return value.replaceAll(BEGIN, '[escaped begin marker]').replaceAll(END, '[escaped end marker]')
}
