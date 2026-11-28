import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {
  AgentTeamAgentMember,
  AgentTeamMemberCapabilities,
  AgentTeamMemberId,
} from './types.ts'
import * as memberSkills from './member-skills.ts'
import type { MemberSkillProviderMount } from './member-skills.ts'
import { MemberToolPolicy } from './member-tool-policy.ts'
import { memberMemoryDirectoryPath, prepareMemberPrivateMemoryRemoval } from './private-assets.ts'

/** Result of waiting for a turn boundary: `waited` if a running turn had to finish first, `idle` if the Member was already between turns. */
export type TurnBoundary = 'waited' | 'idle'

/** Read-only core skills shipped beside the preset (meta skill first: its description routes skill-management work to itself), resolved from this module's emitted location so it follows the installed plugin. */
const BUNDLED_SKILLS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../core-skills')

export function deepCopyCapabilities(capabilities: AgentTeamMemberCapabilities): AgentTeamMemberCapabilities {
  const copyAllow = (allow: readonly string[] | undefined): { allow?: readonly string[] } =>
    allow === undefined ? {} : { allow: [...allow] }
  return {
    ...(capabilities.tools === undefined ? {} : { tools: copyAllow(capabilities.tools.allow) }),
    ...(capabilities.skills === undefined ? {} : { skills: copyAllow(capabilities.skills.allow) }),
  }
}

interface MemberRuntimeDeps {
  /** Host context for agent events, tool schemas, and the workspace registry. */
  readonly ctx: Context
  /** Resolve one Member's live agent context, or throw when it has none. */
  readonly liveMemberContext: (memberId: AgentTeamMemberId) => Context
  /** Agent ids with a turn in flight; shared by reference with the service. */
  readonly runningAgents: ReadonlySet<SessionId>
}

export class MemberRuntime {
  readonly toolPolicy: MemberToolPolicy
  /** Per-Member skill provider mounts. One entry holds the selection swap and the disposer, so a catalog re-filter and the unmount never disagree about which provider is live. */
  private readonly skillProviderMounts = new Map<AgentTeamMemberId, MemberSkillProviderMount>()

  constructor(private readonly deps: MemberRuntimeDeps) {
    this.toolPolicy = new MemberToolPolicy(deps)
  }

  /** Outstanding boundary waits, held so Host shutdown can release them all. */
  private readonly turnWaitResolvers = new Set<() => void>()

  /** Waits until a live Member's current turn ends or its Session is disposed; returns whether a running turn had to be awaited. The running turn keeps its schemas and catalog; the swap happens once idle so the next step sees the new restriction and skill selection on the same Session. Suspend/remove resolves the wait (the disposed handle already released the restriction); Host shutdown resolves every wait through `releaseTurnWaits`. */
  async awaitTurnBoundary(active: AgentHandle): Promise<TurnBoundary> {
    if (!this.deps.runningAgents.has(active.agent.id)) return 'idle'
    await new Promise<void>(resolve => {
      const disposers: Array<() => void> = []
      const settle = (): void => {
        this.turnWaitResolvers.delete(settle)
        for (const dispose of disposers.splice(0)) dispose()
        resolve()
      }
      this.turnWaitResolvers.add(settle)
      disposers.push(
        this.deps.ctx.on('agent/status', (payload: { agent: Agent; status: string }) => {
          if (payload.agent !== active.agent) return
          // A turn ending, cleanly or by error, is the boundary.
          if (payload.status !== 'running') settle()
        }),
        // Disposal resolves the wait: the restriction went with the disposed scope, leaving only the ledger intent for the next activation.
        this.deps.ctx.on('session/disposed', (session: { id: SessionId }) => {
          if (session.id === active.agent.session.id) settle()
        }),
      )
    })
    return 'waited'
  }

  /** Host-shutdown exit: resolves every boundary wait so the Member's lifecycle chain drains; `settle` removes each wait's listeners, so nothing survives shutdown. */
  releaseTurnWaits(): void {
    // Snapshot: every `settle` removes its own entry from the set.
    for (const settle of Array.from(this.turnWaitResolvers)) settle()
  }

  /** Mounts bundled core skills plus the Member's private directory behind the exact Agent entry in its preset's isolated skills router. Without that Team registry nothing is registered. The sanitized directory is authoritative; activateMember migrates any legacy colon directory onto it first. */
  mountMemberSkillProvider(
    member: AgentTeamAgentMember,
    agentCtx: Context,
    initialSelection: readonly string[] | undefined,
  ): void {
    const mount = memberSkills.mountMemberSkillProvider(agentCtx, this.deps.ctx.agentPresets, {
      skillsDirectory: join(memberMemoryDirectoryPath(member), 'skills'),
      bundledSkillsDirectory: BUNDLED_SKILLS_DIRECTORY,
      initialSelection,
    })
    if (mount === undefined) return
    this.skillProviderMounts.set(member.memberId, mount)
  }

  /** Live-apply a capability edit to a mounted provider; a no-op when this Member has none. */
  swapSkillSelection(memberId: AgentTeamMemberId, allow: readonly string[] | undefined): void {
    this.skillProviderMounts.get(memberId)?.swap(allow)
  }

  /** Irreversibly remove one Member: archive its Session and delete its private namespace. */
  async cleanupRemovedMember(member: AgentTeamAgentMember): Promise<void> {
    const removeMemory = prepareMemberPrivateMemoryRemoval(member, message => this.deps.ctx.logger.warn(message))
    const results = await Promise.allSettled([
      this.deps.ctx.workspaceRegistry.archiveSession(member.sessionId),
      ...removeMemory(),
    ])
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, `failed to clean up removed Member '${member.memberId}'`)
  }

  /** Drop one Member's transient selection/disposer state after its handle is gone; safe to call twice. */
  forgetMember(memberId: AgentTeamMemberId): void {
    const mount = this.skillProviderMounts.get(memberId)
    if (mount !== undefined) {
      this.skillProviderMounts.delete(memberId)
      mount.dispose()
    }
    this.toolPolicy.forgetMember(memberId)
  }

  /** Dispose every registered per-Member seam; service shutdown only. */
  disposeAll(): void {
    const members = new Set([...this.toolPolicy.memberIds(), ...this.skillProviderMounts.keys()])
    for (const memberId of members) this.forgetMember(memberId)
  }
}
