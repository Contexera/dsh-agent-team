/**
 * Per-Member runtime state split out of the Host service: the maps and methods that must dispose together across activation, edit, suspend, and removal (tool-policy restriction, private skill mounts, capability warnings, private-memory provisioning). Host-side by design: the turn-boundary wait subscribes to Host-level agent events. The service keeps orchestration (ledger, handles, notifications, recovery).
 * @module @contexera/dsh-agent-team/member-runtime
 */

import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { scopeOf, scopeParentOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {
  AgentTeamAgentMember,
  AgentTeamCapabilityWarning,
  AgentTeamMemberCapabilities,
  AgentTeamMemberId,
} from './types.ts'
import * as memberSkills from './member-skills.ts'
import type { MemberSkillProviderMount } from './member-skills.ts'
import { sanitizeExtraToolGrants } from './member-tool-grants.ts'

/** Result of waiting for a turn boundary: `waited` if a running turn had to finish first, `idle` if the Member was already between turns. */
export type TurnBoundary = 'waited' | 'idle'

/** Read-only core skills shipped beside the preset (meta skill first: its description routes skill-management work to itself), resolved from this module's emitted location so it follows the installed plugin. */
const BUNDLED_SKILLS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../core-skills')

/** The one Team tool a Host switch can withdraw from a Member's declared surface. */
export const WORKER_TOOL_NAME = 'team_worker'

/** Model-facing capabilities every Team-enabled preset must publish. */
export const AGENT_TEAM_TOOL_NAMES = Object.freeze([
  'team_inbox',
  'team_thread',
  'team_attention',
  'team_message',
  'team_dm',
  'team_task',
  'team_view',
  'team_subscription',
  'team_reminder',
  'team_worker',
] as const)

/** Copy a Remote-supplied capability overlay into owned frozen storage. */
export function deepCopyCapabilities(capabilities: AgentTeamMemberCapabilities): AgentTeamMemberCapabilities {
  const copyAllow = (allow: readonly string[] | undefined): { allow?: readonly string[] } =>
    allow === undefined ? {} : { allow: [...allow] }
  return {
    ...(capabilities.tools === undefined ? {} : { tools: copyAllow(capabilities.tools.allow) }),
    ...(capabilities.skills === undefined ? {} : { skills: copyAllow(capabilities.skills.allow) }),
  }
}

/** Directory segment for a Member's private memory. The `member:<uuid>` ref must never appear in a path: Windows rejects `:` in a path segment (NTFS reads it as an Alternate Data Stream separator). */
export function memberMemoryDirectoryName(memberId: AgentTeamMemberId): string {
  return memberId.replaceAll(':', '-')
}

/** The sanitized absolute private-memory path for one Member, regardless of what the ledger recorded. */
export function memberMemoryDirectoryPath(member: Pick<AgentTeamAgentMember, 'memberId' | 'privateMemoryPath'>): string {
  // Only the recorded final segment can carry the ledger's member-identity colon, so only it is rewritten. A Windows drive-letter colon is not an identity and must survive: a colon-free final segment keeps the recorded path verbatim.
  const separator = Math.max(member.privateMemoryPath.lastIndexOf('/'), member.privateMemoryPath.lastIndexOf('\\'))
  const finalSegment = separator === -1 ? member.privateMemoryPath : member.privateMemoryPath.slice(separator + 1)
  if (!finalSegment.includes(':')) return member.privateMemoryPath
  const prefix = separator === -1 ? '' : member.privateMemoryPath.slice(0, separator + 1)
  return prefix + memberMemoryDirectoryName(member.memberId)
}

/** Everything the runtime needs from its owning Host service. */
export interface MemberRuntimeDeps {
  /** Host context for agent events, tool schemas, and the workspace registry. */
  readonly ctx: Context
  /** Resolve one Member's live agent context, or throw when it has none. */
  readonly liveMemberContext: (memberId: AgentTeamMemberId) => Context
  /** Agent ids with a turn in flight; shared by reference with the service. */
  readonly runningAgents: ReadonlySet<SessionId>
}

/** One Member's durable policy intent at the instant its next turn opens. */
export interface MemberToolPolicySnapshot {
  readonly member: AgentTeamAgentMember
  readonly workerEnabled: boolean
  readonly grants: readonly string[]
}

/** Read the current intent synchronously: this runs from `session/event`, which cannot await. */
export type MemberToolPolicyReader = () => MemberToolPolicySnapshot

/** The names that keep their existing Member-baseline rules and are never extra grants. */
const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([...AGENT_TEAM_TOOL_NAMES, 'working_directory'])

/** Whether one tool name is owned by the Team baseline and cannot be reopened by a profile grant. */
export function isReservedToolName(name: string): boolean {
  return RESERVED_TOOL_NAMES.has(name)
}

/** Per-Member runtime state: every map here is keyed by Member and released together with that Member. */
export class MemberRuntime {
  /** Per-Member tool restriction disposers: activation registers, disposal releases, edits swap at a turn boundary. */
  private readonly memberRestrictions = new Map<AgentTeamMemberId, () => void>()
  /** The allow-list enforced behind `memberRestrictions`: the rollback source when a swap fails, so a failed apply never leaves the Member less restricted. */
  private readonly enforcedToolAllow = new Map<AgentTeamMemberId, ReadonlySet<string>>()
  private readonly memberToolBindings = new Map<AgentTeamMemberId, ReadonlyMap<string, ToolDefinition>>()
  /** The exact extra names frozen for this Member's current turn; a settings edit waits for the next `turn/start`. */
  private readonly turnToolGrants = new Map<AgentTeamMemberId, ReadonlySet<string>>()
  /** A synchronous turn-start or pre-step refresh failure; `agent/pre-step` turns it into a fail-closed step, i.e. no model request. */
  private readonly turnToolPolicyFailures = new Map<AgentTeamMemberId, string>()
  /** The last successfully read durable intent, used to tighten to the Member baseline if the next synchronous read fails. */
  private readonly lastToolPolicy = new Map<AgentTeamMemberId, { readonly member: AgentTeamAgentMember; readonly workerEnabled: boolean }>()
  /** Capability intent the live surface is known to reflect: presence is the proof, a stored `undefined` means applied with no capabilities. Never persisted; absent when unprovable, so an unknown surface re-applies. */
  private readonly appliedCapabilities = new Map<AgentTeamMemberId, AgentTeamMemberCapabilities | undefined>()
  /** Capability warnings, recomputed at every activation and never persisted: stored ones would lie after a Host restart or a Harness upgrade that renames tools. */
  private readonly capabilityWarnings = new Map<AgentTeamMemberId, readonly AgentTeamCapabilityWarning[]>()
  /** Per-Member skill provider mounts. One entry holds the selection swap and the disposer, so a catalog re-filter and the unmount never disagree about which provider is live. */
  private readonly skillProviderMounts = new Map<AgentTeamMemberId, MemberSkillProviderMount>()

  constructor(private readonly deps: MemberRuntimeDeps) {}

  /** Tool names supplied by activated Member presets, rather than discovered foreign registrations. */
  baselineToolNames(): ReadonlySet<string> {
    const names = new Set<string>()
    for (const bindings of this.memberToolBindings.values()) {
      for (const name of bindings.keys()) names.add(name)
    }
    return names
  }

  /** Own-scope registrations can stay visible despite the execution guard. */
  visibleDeniedToolNames(agentCtx: Context, memberId: AgentTeamMemberId): readonly string[] {
    const scope = scopeOf(agentCtx)
    if (scope === undefined) throw new Error('Member tool guidance requires a mounted Agent scope')
    const grants = this.turnToolGrants.get(memberId)
    const bindings = this.memberToolBindings.get(memberId)
    return this.deps.ctx.tools.schemas(scope)
      .map(tool => tool.name)
      .filter(name => {
        if (grants?.has(name) && !isReservedToolName(name)) return false
        return bindings === undefined || this.baselineToolDenial(memberId, scope, name, bindings) !== undefined
      })
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  }

  /** One Member's live capability warnings, if any; runtime-derived, never persisted. */
  capabilityWarningsFor(memberId: AgentTeamMemberId): readonly AgentTeamCapabilityWarning[] | undefined {
    return this.capabilityWarnings.get(memberId)
  }

  /**
   * Restrict every Member to its preset tools plus the profile's exact name
   * grants. The stored Member allow-list narrows the baseline; an explicit
   * non-reserved grant can reopen a baseline name. `workerEnabled` stays the
   * Host's own switch: while it is off, `team_worker` is not declared at all,
   * so a grant cannot recreate a tool the Host would refuse.
   */
  applyMemberToolPolicy(
    agentCtx: Context,
    member: AgentTeamAgentMember,
    workerEnabled: boolean,
    grants: readonly string[] = [],
  ): void {
    const bindings = this.memberToolBindings.get(member.memberId) ?? this.mountMemberToolBindings(agentCtx, member.memberId)
    this.installMemberToolPolicy(agentCtx, member, workerEnabled, grants, bindings)
  }

  /**
   * Install the per-turn restriction synchronously from `turn/start`. The
   * session event itself is observe-only (the Harness contains its exceptions
   * and does not await it), so failure is recorded here and rejected later by
   * `agent/pre-step`; it must never be mistaken for asynchronous turn blocking.
   */
  observeMemberToolPolicyTurns(
    agentCtx: Context,
    agent: Agent,
    memberId: AgentTeamMemberId,
    readPolicy: MemberToolPolicyReader,
  ): void {
    agentCtx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'turn/start') {
        this.freezeMemberToolPolicyForTurn(agentCtx, memberId, readPolicy)
      }
    })
  }

  /**
   * Whether this turn's policy installation or per-step refresh failed.
   * `agent/pre-step` uses it only to refuse the step and spend no model
   * request; it never selects tools.
   */
  turnToolPolicyFailure(memberId: AgentTeamMemberId): string | undefined {
    return this.turnToolPolicyFailures.get(memberId)
  }

  private freezeMemberToolPolicyForTurn(
    agentCtx: Context,
    memberId: AgentTeamMemberId,
    readPolicy: MemberToolPolicyReader,
  ): void {
    let snapshot: MemberToolPolicySnapshot
    try {
      snapshot = readPolicy()
      this.lastToolPolicy.set(memberId, { member: snapshot.member, workerEnabled: snapshot.workerEnabled })
    } catch (error) {
      // A settings read cannot be replaced with an invented list. The last
      // accepted Member intent is still enough to establish the no-grants
      // baseline; only a failed baseline closes the turn.
      const previous = this.lastToolPolicy.get(memberId)
      if (previous === undefined) {
        // No confirmed baseline exists to install. Drop any older surface so a
        // stale grant-bearing allow-list cannot become the fallback authority;
        // the pre-step rejection still prevents a model request.
        this.releaseMemberToolPolicy(memberId)
        this.turnToolGrants.set(memberId, new Set())
        this.turnToolPolicyFailures.set(memberId, `could not read the Member tool policy: ${errorMessage(error)}`)
        return
      }
      snapshot = { ...previous, grants: [] }
    }
    const bindings = this.memberToolBindings.get(memberId)
    if (bindings === undefined) {
      this.releaseMemberToolPolicy(memberId)
      this.turnToolGrants.set(memberId, new Set())
      this.turnToolPolicyFailures.set(memberId, 'Member tool bindings are unavailable at the turn boundary')
      return
    }
    try {
      this.installMemberToolPolicy(agentCtx, snapshot.member, snapshot.workerEnabled, snapshot.grants, bindings)
    } catch (error) {
      this.turnToolGrants.set(memberId, new Set())
      this.turnToolPolicyFailures.set(memberId, `could not establish the Member tool baseline: ${errorMessage(error)}`)
    }
  }

  /**
   * Re-materialize the current turn's restriction against the tool names that
   * exist now. `tools.restrict()` snapshots global names when installed, so a
   * selected name first registered after turn start would otherwise stay hidden.
   * This runs from `agent/pre-step`, after the Harness resolved this step's
   * tools but before it can send the model request: the current step keeps its
   * assembly, a successful refresh serves the following step, and a failed
   * baseline is still visible to the existing pre-step failure gate.
   */
  refreshMemberToolPolicyForStep(agentCtx: Context, memberId: AgentTeamMemberId): void {
    const grants = this.turnToolGrants.get(memberId)
    const accepted = this.lastToolPolicy.get(memberId)
    if (grants === undefined || grants.size === 0 || accepted === undefined) return
    const bindings = this.memberToolBindings.get(memberId)
    if (bindings === undefined) {
      this.turnToolGrants.set(memberId, new Set())
      this.turnToolPolicyFailures.set(memberId, 'Member tool bindings are unavailable at the step boundary')
      return
    }
    try {
      this.installMemberToolPolicy(
        agentCtx,
        accepted.member,
        accepted.workerEnabled,
        [...grants],
        bindings,
      )
    } catch (error) {
      this.turnToolGrants.set(memberId, new Set())
      this.turnToolPolicyFailures.set(memberId, `could not refresh the Member tool baseline: ${errorMessage(error)}`)
    }
  }

  /**
   * Derive and install one complete restriction. A failed grant-bearing apply
   * tightens to the current Member baseline, never to the previous restriction
   * which may still contain a revoked grant. A failed baseline leaves no
   * old-grant restore behind.
   */
  private installMemberToolPolicy(
    agentCtx: Context,
    member: AgentTeamAgentMember,
    workerEnabled: boolean,
    grants: readonly string[],
    bindings: ReadonlyMap<string, ToolDefinition>,
  ): void {
    const configured = member.capabilities?.tools?.allow
    // Drop unknown names instead of failing activation: a Harness upgrade renaming a tool must not make the Member unavailable. The warning carries the known-name digest for diagnosing drift.
    const known = [...bindings.keys()]
    const knownSet = new Set(known)
    const dropped = (configured ?? []).filter(name => !knownSet.has(name))
    this.setCapabilityWarnings(member.memberId, dropped.map(name => ({ name, knownNames: known })))
    const baseline = [...new Set([
      ...(configured ?? known).filter(name => knownSet.has(name) && (workerEnabled || name !== WORKER_TOOL_NAME)),
      ...AGENT_TEAM_TOOL_NAMES.filter(name => workerEnabled || name !== WORKER_TOOL_NAME),
      // An allow-list narrows capability, not the checkout the Member works in, so `working_directory` survives like the Team tools.
      ...knownSet.has('working_directory') ? ['working_directory'] : [],
    ])]
    const inherited = this.inheritedToolNames(agentCtx)
    const grantNames = sanitizeExtraToolGrants(grants)
      .filter(name => !isReservedToolName(name))
    const desired = [...new Set([
      ...baseline,
      ...grantNames.filter(name => inherited.has(name)),
    ])]
    const intent = Object.freeze({ member, workerEnabled })
    this.lastToolPolicy.set(member.memberId, intent)
    try {
      this.installRestriction(agentCtx, member.memberId, desired, grantNames)
      return
    } catch (error) {
      // Only a grant-bearing surface has a no-grant fallback. A failed baseline
      // apply keeps the prior surface and surfaces the failure as before.
      if (!desired.some(name => !baseline.includes(name))) throw error
      // A grant-bearing replacement may leave the old grant surface installed
      // when it fails. Remove it before tightening, so a revoked grant cannot
      // survive by rolling back to that old restriction.
      this.memberRestrictions.get(member.memberId)?.()
      this.memberRestrictions.delete(member.memberId)
      this.enforcedToolAllow.delete(member.memberId)
      let fallbackError: unknown
      try {
        this.installRestriction(agentCtx, member.memberId, baseline, [])
      } catch (next) {
        fallbackError = next
      }
      if (fallbackError !== undefined) {
        this.memberRestrictions.get(member.memberId)?.()
        this.memberRestrictions.delete(member.memberId)
        this.enforcedToolAllow.delete(member.memberId)
        this.turnToolGrants.set(member.memberId, new Set())
        throw new AggregateError(
          [error, fallbackError],
          `failed to establish the Team Member tool baseline for '${member.memberId}'`,
        )
      }
      const message = `extra tool policy failed and was tightened to the Member baseline: ${errorMessage(error)}`
      this.deps.ctx.logger.warn(`agent-team: member '${member.memberId}' ${message}`)
    }
  }

  /** Swap one scoped restriction, recording exactly what it permits. */
  private installRestriction(
    agentCtx: Context,
    memberId: AgentTeamMemberId,
    allow: readonly string[],
    grants: readonly string[],
  ): void {
    // `tools.restrict()` requires a scoped context and rejects names outside the
    // inherited surface; either error fails this installation, never widens it.
    const dispose = agentCtx.tools.restrict({ allow })
    const previous = this.memberRestrictions.get(memberId)
    this.memberRestrictions.set(memberId, dispose)
    this.enforcedToolAllow.set(memberId, new Set(allow))
    this.turnToolGrants.set(memberId, new Set(grants))
    this.turnToolPolicyFailures.delete(memberId)
    previous?.()
  }

  /** The names `tools.restrict()` can mask: inherited global and ancestor registrations. */
  private inheritedToolNames(agentCtx: Context): ReadonlySet<string> {
    const scope = scopeOf(agentCtx)
    const presetScope = scope === undefined ? undefined : scopeParentOf(scope)
    if (presetScope === undefined) throw new Error('Member tool policy requires a mounted preset scope')
    return new Set(this.deps.ctx.tools.schemas(presetScope).map(tool => tool.name))
  }

  private mountMemberToolBindings(agentCtx: Context, memberId: AgentTeamMemberId): ReadonlyMap<string, ToolDefinition> {
    const scope = scopeOf(agentCtx)
    if (scope === undefined) throw new Error('Member tool policy requires a mounted Agent scope')
    const presetScope = scopeParentOf(scope)
    if (presetScope === undefined) throw new Error('Member tool policy requires a mounted preset scope')
    const tools = this.deps.ctx.tools
    const bindings = new Map<string, ToolDefinition>()
    for (const { name } of tools.schemas(presetScope)) {
      const definition = tools.get(name, presetScope)
      // The preset view also inherits Host tools. Only its own definitions and
      // the explicitly shared directory tool belong to the Member's baseline.
      if (definition !== undefined && (name === 'working_directory' || definition !== tools.get(name))) {
        bindings.set(name, definition)
      }
    }
    this.memberToolBindings.set(memberId, bindings)
    agentCtx.tools.guard(execution => {
      if (execution.agent !== scope) return undefined
      const name = execution.name
      const grants = this.turnToolGrants.get(memberId)
      if (grants?.has(name) && !isReservedToolName(name)) {
        // Grant execution follows exactly the registration DSH admitted for this
        // Member and step. It never compares definition identity or infers origin.
        if (execution.toolSet === undefined) return `Tool "${name}" requires step admission for this Team Member`
        return execution.toolSet.view(scope).get(name) === undefined
          ? `Tool "${name}" is not admitted for this Team Member`
          : undefined
      }
      const denial = this.baselineToolDenial(memberId, scope, name, bindings)
      if (denial === 'not-declared') return `Tool "${execution.name}" is not declared for this Team Member`
      if (denial === 'replaced') return `Team Member tool replaced: ${name}`
      return undefined
    })
    // `restrict` above is what shapes this Member's declared tools: 0.2.2 builds
    // a request's declarations from the step's admitted set, which reads the
    // scope's restricted view, so an assembly-time filter no longer exists.
    return bindings
  }

  /** The execution guard for a name outside the current turn's grant set; prompt guidance reports the same denial. */
  private baselineToolDenial(
    memberId: AgentTeamMemberId,
    scope: ScopeKey,
    name: string,
    bindings: ReadonlyMap<string, ToolDefinition>,
  ): 'not-declared' | 'replaced' | undefined {
    if (!this.enforcedToolAllow.get(memberId)?.has(name)) return 'not-declared'
    const binding = bindings.get(name)
    return binding === undefined || this.deps.ctx.tools.get(name, scope) !== binding ? 'replaced' : undefined
  }

  /** Whether the live surface is known to reflect exactly this capability intent; an absent record never matches. */
  appliedCapabilitiesMatch(memberId: AgentTeamMemberId, capabilities: AgentTeamMemberCapabilities | undefined): boolean {
    if (!this.appliedCapabilities.has(memberId)) return false
    return isDeepStrictEqual(this.appliedCapabilities.get(memberId), capabilities)
  }

  /** Record the capability intent the live surface now reflects; callers invoke it only after every effect of the apply succeeded. */
  recordAppliedCapabilities(memberId: AgentTeamMemberId, capabilities: AgentTeamMemberCapabilities | undefined): void {
    this.appliedCapabilities.set(memberId, capabilities)
  }

  /** Swaps a live Member's tool policy at a turn boundary; a failed swap leaves the no-grants baseline, never the previous grant-bearing restriction. */
  reapplyMemberToolPolicy(member: AgentTeamAgentMember, workerEnabled: boolean, grants: readonly string[] = []): void {
    const agentCtx = this.deps.liveMemberContext(member.memberId)
    this.applyMemberToolPolicy(agentCtx, member, workerEnabled, grants)
  }

  /** Release one Member's restriction disposer and warning state; safe to call twice. */
  releaseMemberToolPolicy(memberId: AgentTeamMemberId): void {
    const dispose = this.memberRestrictions.get(memberId)
    if (dispose !== undefined) {
      this.memberRestrictions.delete(memberId)
      dispose()
    }
    this.enforcedToolAllow.delete(memberId)
    this.turnToolGrants.delete(memberId)
    this.turnToolPolicyFailures.delete(memberId)
    this.lastToolPolicy.delete(memberId)
    this.capabilityWarnings.delete(memberId)
    this.appliedCapabilities.delete(memberId)
  }

  private setCapabilityWarnings(memberId: AgentTeamMemberId, warnings: readonly AgentTeamCapabilityWarning[]): void {
    if (warnings.length === 0) this.capabilityWarnings.delete(memberId)
    else this.capabilityWarnings.set(memberId, Object.freeze([...warnings]))
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

  /** Registers the Member-private skill provider on the created agent's exact scope layer (the traceable-service seam, like the tool restriction): bundled core skills plus the Member's private directory. Without a skill registry nothing is registered. The sanitized directory is authoritative; activateMember migrates any legacy colon directory onto it first. */
  mountMemberSkillProvider(
    member: AgentTeamAgentMember,
    agentCtx: Context,
    initialSelection: readonly string[] | undefined,
  ): void {
    const mount = memberSkills.mountMemberSkillProvider(agentCtx, {
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

  /**
   * Provisions a Member's private memory namespace: notes/, skills/, and a first-run memory.md scaffold. The per-Member skill provider scans exactly this root.
   *
   * `privateMemoryPath` is a durable Member fact that cannot be rewritten, so a legacy colon directory recorded in the ledger is renamed onto the sanitized path once (same-parent, atomic) rather than orphaning existing memory. A recorded path in a different DSH home is never acted on (see `migrateLegacyMemoryDirectory`).
   *
   * A colon-form twin directory is merged too: the branded `member:<uuid>` ref shown by every Team tool result leads Members to hand-assemble colon paths, which Linux accepts silently (two directories for one Member) and Windows rejects. `memory.md` cannot merge, so the sanitized copy wins and twin-only notes/skills move in without overwriting.
   */
  async initializePrivateMemory(path: string, legacyPath?: string): Promise<void> {
    if (legacyPath !== undefined && legacyPath !== path) {
      const migration = await migrateLegacyMemoryDirectory(legacyPath, path)
            // A refusal means the record names a directory in another DSH home: provision fresh here rather than take that directory out of its home.
      if (migration === 'refused-foreign-home') this.deps.ctx.logger.warn(`agent-team: refused to migrate the recorded Member private memory '${legacyPath}' into '${path}': they are not in the same directory, so the recorded directory names a different DSH home and is left untouched`)
    }
    const twinPath = twinMemoryDirectoryPath(path)
    if (twinPath !== undefined) await mergeTwinMemoryDirectory(twinPath, path)
    await mkdir(join(path, 'notes'), { recursive: true })
    await mkdir(join(path, 'skills'), { recursive: true })
    try {
      await writeFile(join(path, 'memory.md'), '# Member memory\n\nBounded routing index. Writing, compaction, and demotion rules: the bundled `member-memory-manager` skill.\n\n## Identity and role\n- <scope>\n\n## Durable rules\n- <rule>\n\n## In hand\n- <work in hand>\n\n## Notes index\n- <cluster>: `notes/<cluster>/README.md`\n', { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  /** Irreversibly remove one Member: archive its Session and delete its private namespace. */
  async cleanupRemovedMember(member: AgentTeamAgentMember): Promise<void> {
        // The ledger path may still name the legacy colon directory: remove both spellings (rm tolerates the missing one). Every target must sit inside this process's members root: the recorded path is a durable absolute fact, and a process resolving another DSH home would otherwise delete the real Member's private memory.
    const sanitized = memberMemoryDirectoryPath(member)
    const targets = sanitized === member.privateMemoryPath ? [sanitized] : [sanitized, member.privateMemoryPath]
    const owned = targets.filter(target => isInsideMembersRoot(target))
    const refused = targets.filter(target => !isInsideMembersRoot(target))
    if (refused.length > 0) this.deps.ctx.logger.warn(`agent-team: refused to delete recorded Member private memory outside this DSH home: ${refused.map(target => `'${target}'`).join(', ')}`)
    const results = await Promise.allSettled([
      this.deps.ctx.workspaceRegistry.archiveSession(member.sessionId),
      ...owned.map(target => rm(target, { recursive: true, force: true })),
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
    this.releaseMemberToolPolicy(memberId)
    this.memberToolBindings.delete(memberId)
  }

    /** Every Member id any per-Member map holds, so a release path cannot miss one only a single map knows. */
  private trackedMemberIds(): readonly AgentTeamMemberId[] {
    return [...new Set([
      ...this.memberRestrictions.keys(),
      ...this.enforcedToolAllow.keys(),
      ...this.memberToolBindings.keys(),
      ...this.turnToolGrants.keys(),
      ...this.turnToolPolicyFailures.keys(),
      ...this.lastToolPolicy.keys(),
      ...this.appliedCapabilities.keys(),
      ...this.capabilityWarnings.keys(),
      ...this.skillProviderMounts.keys(),
    ])]
  }

  /** Dispose every registered per-Member seam; service shutdown only. */
  disposeAll(): void {
    for (const memberId of this.trackedMemberIds()) this.forgetMember(memberId)
  }
}

/**
 * One-time in-place migration of a colon-named private memory directory onto its sanitized path. An existing sanitized target wins (idempotent across restarts); a missing legacy source is the fresh-install case.
 *
 * The rename is confined to one parent directory: a process resolving a different DSH home (isolated test home, second instance) holds a sanitized target in its own tree while the record names the real one, and renaming across trees would silently take a Member's private memory out of its home. Such a source is left in place and only that refusal is reported.
 */
async function migrateLegacyMemoryDirectory(legacyPath: string, path: string): Promise<'refused-foreign-home' | undefined> {
  let legacy: Awaited<ReturnType<typeof stat>>
  try {
    legacy = await stat(legacyPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!legacy.isDirectory()) throw new Error(`legacy Member memory path '${legacyPath}' exists but is not a directory`)
  if (dirname(legacyPath) !== dirname(path)) return 'refused-foreign-home'
  try {
    await stat(path)
    return undefined // Sanitized directory already present: migration already done or a new install.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await rename(legacyPath, path)
  return undefined
}

/** Whether an absolute path names a Member directory inside this process's members root; only such a path is this process's to delete. */
function isInsideMembersRoot(candidate: string): boolean {
  const fromRoot = relative(dshHomePath('agent-team', 'members'), resolve(candidate))
  // '' is the members root itself and '..' escapes it: only a real descendant is authorized.
  return fromRoot.length > 0 && !fromRoot.startsWith('..') && !isAbsolute(fromRoot)
}

/** The colon-form twin path of one sanitized Member memory directory, when the segment form admits one. */
function twinMemoryDirectoryPath(sanitizedPath: string): string | undefined {
  const separator = Math.max(sanitizedPath.lastIndexOf('/'), sanitizedPath.lastIndexOf('\\'))
  const prefix = separator === -1 ? '' : sanitizedPath.slice(0, separator + 1)
  const finalSegment = separator === -1 ? sanitizedPath : sanitizedPath.slice(separator + 1)
    // Only the exact sanitized identity segment (`member-<uuid>`) has a colon twin (`member:<uuid>`).
  if (!/^member-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(finalSegment)) return undefined
  return `${prefix}member:${finalSegment.slice('member-'.length)}`
}

/** The colon-twin trace name for one conflicting file: `note.md` → `note.colon-twin.md`. */
function colonTwinTraceName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? `${name}.colon-twin` : `${name.slice(0, dot)}.colon-twin${name.slice(dot)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Merges a hand-created colon-form twin into the sanitized Member memory directory. Unlike the legacy migration this is a merge: the sanitized directory is the live root, so on conflict its copy wins and the twin's copy is kept beside it under a `.colon-twin` name. Twin-only files move in under their own names, then the emptied twin is removed. */
async function mergeTwinMemoryDirectory(twinPath: string, path: string): Promise<void> {
  let twin: Awaited<ReturnType<typeof stat>>
  try {
    twin = await stat(twinPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return
  }
  if (!twin.isDirectory()) return
  await mergeDirectoryContents(twinPath, path)
  await rm(twinPath, { recursive: true, force: true })
}

/** Recursively move every twin file into the live root; an existing live file wins, its twin copy traced beside it. */
async function mergeDirectoryContents(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    if (entry.isDirectory()) {
      await mergeDirectoryContents(sourcePath, targetPath)
    } else if (entry.isFile()) {
            // rename(2) silently replaces an existing target on POSIX (EEXIST exists only on Windows, where the twin cannot exist), so probe first. Activation is the single serialized writer, so the probe-to-rename window has no race.
      let liveFilePresent = true
      try {
        await stat(targetPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        liveFilePresent = false
      }
            // The live root stays authoritative; the twin's losing copy stays traceable beside it.
      await rename(sourcePath, liveFilePresent ? join(target, colonTwinTraceName(entry.name)) : targetPath)
    }
  }
}
