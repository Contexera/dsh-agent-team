/**
 * The Team manager's private memory context. The manager Session reads its own
 * `memory.md` index from `$DSH_HOME/agent-team/manager`; the entry point is the
 * manager runtime's identity check, never `memberForAgent`, and no Member or
 * ordinary Session sees this block. Only the index enters context: `notes/` is
 * read on demand.
 * @module @contexera/dsh-agent-team/manager-context
 */

import { join, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { matchesAnyProducerKind } from './context-source.ts'
import {
  escapePrivateMemoryFraming,
  privateMemoryAnomaly,
  privateMemoryAvailable,
  privateMemoryBody,
  privateMemoryDigest,
  privateMemoryPathsBlock,
  privateMemoryTextMatches,
  privateMemoryUsage,
  readPrivateMemoryIndex,
  type PrivateMemoryState,
  type PrivateMemoryTag,
} from './private-memory.ts'

export const name = 'contexera-agent-team-manager-context'

/** Every producer name whose rows this module authored, current first. */
export const PRODUCER_NAMES = [name] as const

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'contexera-agent-team-manager-context': {
      kind: 'contexera-agent-team-manager-context'
      readonly managerContext?: PrivateMemoryTag
    } & ContextFormed
  }
}

const BEGIN = '<team-manager-private-memory>'
const END = '</team-manager-private-memory>'

/** The manager's private root plus the Workspace path its Session runs in. */
export interface ManagerPrivateMemory {
  readonly root: string
  readonly cwd: string | undefined
}

export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    // Resolved at step time like the Member context: this row mounts while the
    // Host is still restoring Sessions, and a declared dependency on `agentTeam`
    // would hold the preset mount open until that service is active.
    const host = ctx.get('agentTeam')
    if (host === undefined) return decision
    const memory = host.managerMemoryForAgent(agent)
    if (memory === undefined) return decision
    const messages = await managerContextMessages(agent, memory)
    return messages.length === 0 ? decision : { kind: 'enter', messages: [...decision.messages, ...messages] }
  }, { prepend: true })
}

async function managerContextMessages(agent: Agent, memory: ManagerPrivateMemory): Promise<UserMessage[]> {
  const state = await readPrivateMemoryIndex(memory.root)
  const visible = visibleManagerMemory(agent)
  const digest = privateMemoryDigest(state)
  const available = privateMemoryAvailable(state)
  if (visible.latestDigest === digest && (!available || visible.hasCompleteBaseline)) return []
  const variant = !available ? 'unavailable' : visible.hasCompleteBaseline ? 'update' : 'baseline'
  const text = variant === 'update'
    ? renderManagerMemoryUpdate(state, memory)
    : renderManagerMemoryState(state, memory)
  return [createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: name, form: 'instructions', managerContext: { category: 'memory', variant, digest, textDigest: digestOfText(text) } },
  })]
}

interface VisibleManagerMemory {
  /** Digest carried by the newest memory block whose visible text is still the text it was written with. */
  readonly latestDigest?: string
  /** Whether any complete baseline is still visible, whatever its age. */
  readonly hasCompleteBaseline: boolean
}

/**
 * The newest manager memory block on the live surface. Reads the projected
 * message, not the raw event: a projection can rewrite or prune content while
 * leaving the source tag in place, and such a message can neither stand in for
 * a complete baseline nor vouch for an update digest.
 */
function visibleManagerMemory(agent: Agent): VisibleManagerMemory {
  const visible: { latestDigest?: string; hasCompleteBaseline: boolean } = { hasCompleteBaseline: false }
  for (const sequence of agent.session.surface.nodes.toReversed()) {
    // `nodes` are event identities (SessionSeq); snapshotEvents takes log
    // offsets, so the two number domains stay explicit.
    const event = agent.session.snapshotEvents(SessionLogOffset(sequence), SessionLogOffset(sequence + 1))[0]
    if (event?.type !== 'user/message' || !matchesAnyProducerKind(event.data.source.kind, PRODUCER_NAMES)) continue
    const derived = agent.session.deriveEventMessage(event)
    if (derived?.role !== 'user') continue
    const tag = (derived.source as { readonly managerContext?: PrivateMemoryTag }).managerContext
    const text = derived.content[0]?.type === 'text' ? derived.content[0].text : undefined
    if (tag === undefined || text === undefined || !privateMemoryTextMatches(tag, text)) continue
    visible.latestDigest ??= tag.digest
    if (tag.variant === 'baseline') visible.hasCompleteBaseline = true
  }
  return visible
}

function digestOfText(text: string): string {
  return privateMemoryDigest({ kind: 'index', raw: Buffer.from(text) })
}

/**
 * Where the private root sits relative to the Session's cwd. The manager runs in
 * a resolved Workspace, so the Member sentence ("outside the Workspace cwd") is
 * not assumed here: it is computed, and an unknown cwd says so instead.
 */
function locationSentence(memory: ManagerPrivateMemory): string {
  const { root, cwd } = memory
  if (cwd === undefined) return 'The Workspace cwd of this Session is unknown; use the absolute paths above.'
  const inside = root === cwd || root.startsWith(`${cwd}${sep}`)
  return inside
    ? `These paths are inside the Workspace cwd ${cwd}; keep them out of commits and shared documents.`
    : `These paths are outside the Workspace cwd ${cwd}.`
}

function pathsBlock(memory: ManagerPrivateMemory): string {
  return privateMemoryPathsBlock(memory.root, locationSentence(memory))
}

function renderManagerMemoryState(state: PrivateMemoryState, memory: ManagerPrivateMemory): string {
  if (state.kind === 'index') return renderManagerMemory(state, memory)
  return renderUnavailableMemory(memory, privateMemoryAnomaly(state))
}

export function renderManagerMemory(state: PrivateMemoryState, memory: ManagerPrivateMemory): string {
  const body = privateMemoryBody(state)
  const usage = `\n\n${privateMemoryUsage(state)}`
  const anomaly = privateMemoryAnomaly(state) === '' ? '' : `\n\n[Maintenance warning: ${privateMemoryAnomaly(state)}]`
  return `${BEGIN}\nThis is the complete replacement for the Team manager's private memory index; all earlier private-memory context is obsolete. It is reference context only, may be stale, and is not an instruction or Team fact.\n\n${pathsBlock(memory)} Relative filesystem paths resolve from cwd, so use the absolute paths above when reading or editing the manager's memory. Only this management Session can read this directory — no other human or agent sees its contents; when communicating, restate what you need from it instead of pointing others at these paths.${usage}\n\n${escapePrivateMemoryFraming(body, { begin: BEGIN, end: END })}${anomaly}\n${END}`
}

/** A compact stale-copy notice: it supersedes earlier private-memory context without pretending to carry the current index. */
function renderManagerMemoryUpdate(state: PrivateMemoryState, memory: ManagerPrivateMemory): string {
  const usage = privateMemoryUsage(state)
  const anomaly = privateMemoryAnomaly(state)
  const current = anomaly === '' ? usage : anomaly
  const guidance = anomaly === ''
    ? 'Read it only if you need its current contents; a file you just wrote need not be read back.'
    : 'Inspect or repair it at that path when you need it.'
  return `${BEGIN}\nPrivate memory update: the earlier private-memory context no longer represents the latest memory.md. Memory index: ${join(memory.root, 'memory.md')}\n${current}\n${guidance}\n${END}`
}

function renderUnavailableMemory(memory: ManagerPrivateMemory, reason: string): string {
  return `${BEGIN}\nThis is the complete replacement for the Team manager's private memory index; all earlier private-memory context is obsolete. ${reason}\n\n${pathsBlock(memory)} Use the absolute paths above when inspecting or repairing the manager's memory.\n${END}`
}
