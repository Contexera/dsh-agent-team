/**
 * Model-facing context-management tools for Team Members.
 *
 * All four are the published engine's tools, built by `createContinuityTools`:
 * the engine owns their argument contract, the anti-forgery gate on a cited ref,
 * the `concludeTurn()` timing, and the render shapes, while the Team supplies
 * its own vocabulary (`TEAM_CONTINUITY_TEXT`) and the mechanism behind
 * `ContinuityToolAdapter`. Hand-written copies of those descriptions used to
 * live here and drifted from the engine's defaults, so the Team's guidance now
 * travels only through the engine's text seams — including the Team glossary the
 * engine splices into `context_status` as `timelineGuidance`.
 *
 * One Team rule survives only in the adapter: for a row the engine renders as
 * not restorable it prints that row's `ref` verbatim (`brief` truncates at 120
 * characters, and a Team ref is 83), and a printed ref is exactly what a model
 * copies into `checkpointRef`. The adapter therefore answers such a row with a
 * short digest instead of its ref — the same digest that keeps two rows sharing
 * a label and a price apart — so no non-selectable row carries a citable string.
 * @module @contexera/dsh-agent-team/context-tools
 */

import { createHash } from 'node:crypto'
import {
  compactibleNow,
  createContinuityTools,
  type CheckpointToolRequest,
  type ContextCompactionScope,
  type ContextTimelineItem,
  type ContinuityToolAdapter,
  type ContinuityToolText,
  type RolloverToolRequest,
} from '@contexera/dsh-context-continuity'
import type { AgentTeamContextCheckpointRef } from '@contexera/dsh-agent-team/types'
import { MAX_TIMELINE_LIMIT, type AgentTeamTimelineItem } from '@contexera/dsh-agent-team/host'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { member, service } from './host-access.ts'

/**
 * Short stable identifier for one timeline row: a digest of the anchor's own
 * ref. Rows routinely share a label (`Team message` is a constant) and a price
 * (the same completed turn prices both), so without it two distinct anchors
 * read as one duplicated row. It is also what a row that is NOT restorable
 * answers as its `ref`, because the engine's render prints that field for every
 * row: a ref only means something on a restorable row, which prints it in full
 * for `context_rollover`.
 */
function anchorId(checkpointRef: string): string {
  return createHash('sha256').update(checkpointRef).digest('hex').slice(0, 6)
}

function agentOf(exec: ToolRunContext) {
  const agent = exec.agent
  if (agent === undefined) throw new Error('context tool requires an Agent session')
  return agent
}

/**
 * The compaction capability in one calling Agent's preset scope, priced by the
 * same meter the pressure policy reads. The Host owns the address: a preset
 * revision publishes its services behind its own isolate, so the engine is asked
 * for through the one method that knows which realm holds it. A Member whose
 * composition mounts none reports "not available in this scope" — never a
 * failure, never a silent no-op.
 *
 * The meter travels with the scope because two engine decisions read it: how
 * much of the newest surface a compaction keeps verbatim, and the price a status
 * reports for a compaction started now. A scope without one still compacts —
 * keeping the newest instruction and everything after it — and prices nothing.
 */
function compactionScopeFor(agent: Agent): ContextCompactionScope | undefined {
  const engine = service(agent).compactionForAgent(agent)
  if (engine === undefined) return undefined
  const meter = agent.ctx.get('tokenMeter')
  return { engine, ...(meter === undefined ? {} : { meter }) }
}

export function engineTimelineItems(items: readonly AgentTeamTimelineItem[]): ContextTimelineItem[] {
  return items.map(item => ({
    ref: item.restorable ? item.checkpointRef : anchorId(item.checkpointRef),
    label: item.name,
    source: item.source === 'agent' ? 'checkpoint' as const : item.source === 'head' ? 'head' as const : 'boundary' as const,
    ...(item.source === 'handoff' || item.source === 'compaction' ? { kind: item.source } : {}),
    retainedTokens: item.retainedTokens,
    discardedTokens: item.discardedTokens,
    affectedTopics: [...item.affectedThreads],
    restorable: item.restorable,
    ...(item.reason === undefined ? {} : { reason: item.reason }),
  }))
}

const adapter: ContinuityToolAdapter = {
  /**
   * One policy, two readers: a ref is restorable exactly when the Team timeline
   * — the same list the model picked from — offers it as such. The walk is asked
   * for the widest window `context_status` can show, so any ref a status read
   * could have printed is answered here.
   */
  async isRestorableRef(checkpointRef, exec) {
    const agent = agentOf(exec)
    const current = member(agent)
    const timeline = await service(agent).contextTimelineForAgent(agent, { memberId: current.memberId, limit: MAX_TIMELINE_LIMIT })
    return timeline.items.some(item => item.checkpointRef === checkpointRef && item.restorable)
  },
  async requestRollover(request: RolloverToolRequest, exec) {
    const agent = agentOf(exec)
    const current = member(agent)
    const outcome = await service(agent).requestNewContext(agent, {
      memberId: current.memberId,
      ...(request.checkpointRef === undefined ? {} : { checkpointRef: request.checkpointRef as AgentTeamContextCheckpointRef }),
      ...(request.relatedFiles.length === 0 ? {} : { relatedFiles: [...request.relatedFiles] }),
    })
    return { mode: outcome.mode }
  },
  async recordCheckpoint(request: CheckpointToolRequest, exec) {
    const agent = agentOf(exec)
    const current = member(agent)
    // The Host validates binding, running-turn fencing, and the name budget;
    // the durable checkpoint is the successful call/result pair the Session
    // projection folds, and the ref derives from the tool call id.
    const outcome = service(agent).recordCheckpointForAgent(agent, { memberId: current.memberId, callId: request.callId, name: request.name })
    return { checkpointRef: outcome.checkpointRef, name: outcome.name }
  },
  async timeline(request, exec) {
    const agent = agentOf(exec)
    const current = member(agent)
    const result = await service(agent).contextTimelineForAgent(agent, {
      memberId: current.memberId,
      ...(request.limit === undefined ? {} : { limit: request.limit }),
    })
    // "This scope cannot price a compaction" and "a compaction would replace
    // nothing" are different facts, and only the second is worth showing, so an
    // unpriced scope omits the field and the status omits its line.
    const scope = compactionScopeFor(agent)
    const compactible = scope === undefined ? undefined : compactibleNow(agent.session, scope)
    return {
      usageTokens: result.usageTokens,
      handoffAt: result.handoffAt,
      hardLimit: result.hardLimit,
      ...(compactible === undefined ? {} : { compactible }),
      items: engineTimelineItems(result.items),
      ...(result.incompleteFrom === undefined ? {} : { incompleteFrom: result.incompleteFrom }),
    }
  },
  compactionFor(agent) {
    return compactionScopeFor(agent)
  },
}

const TEAM_CONTINUITY_TEXT: ContinuityToolText = {
  subjectNoun: 'Team Member',
  carriedContext: 'You stay the same Team Member: your @handle and role, your private memory index, your skills catalog, and the Team and Workspace instructions carry across a rollover — they are re-injected at birth — and the Team ledger (Threads, Tasks, Claims, your inbox, your owner jobs) is one query away (team_view, team_inbox). Do not restate any of it.',
  rolloverChecklist: 'the objective and the atomic action in flight; facts and evidence not already recorded elsewhere; which items you verified and which you only trusted; inferences and unresolved conflicts; current external side effects and their verification state (files, git, jobs, browser state, remote calls); one explicit next step',
  timelineGuidance: ' Team rows carry Team sources: `checkpoint` is one you recorded, `boundary` is a Team boundary this Host contributed — a committed team_message, a successful team_claim mutation, or a follow/unfollow, rendered as `Team message`, `Team task claim change`, `Team attention change` — and `head` is the current generation. A Thread\'s first delivered notice is a boundary too, rendered `First arrival: <refs>`; later re-deliveries and reminders produce none. A Team boundary is a selectable default exactly when the retained prefix through it stays inside one Thread and the return would shrink the working set below the handoff budget; a boundary spanning several Threads, or attributable to none, states its reason instead. The `anchor` shown on a row that is not restorable is a short digest, never a ref: cite only a ref printed on a restorable row.',
  topicNoun: 'Thread',
  topicNounPlural: 'Threads',
}

const engineTools = createContinuityTools(adapter, TEAM_CONTINUITY_TEXT)

export function registerContextTools(ctx: { readonly tools: { register(tool: unknown): void } }): void {
  ctx.tools.register(engineTools.rollover)
  ctx.tools.register(engineTools.checkpoint)
  ctx.tools.register(engineTools.status)
  ctx.tools.register(engineTools.compact)
}
