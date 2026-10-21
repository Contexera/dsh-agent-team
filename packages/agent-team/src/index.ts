/**
 * Durable Agent Team Host capability.
 *
 * The Host owns the append-only collaboration ledger and all Member lifecycle
 * effects. Session history and browser state are projections, never Team facts.
 * @module @contexera/dsh-agent-team
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { stableRequestUuid } from './request-scoped-id.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-app-boot'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-tools'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { ATTACHMENT_MAX_BYTES, attachmentPayloadPath, attachmentsRoot, copyPathAttachment, pathAttachmentId, readAttachment, removeAttachment, sanitizeMediaType, sweepAttachmentCache, validatePathAttachment, writeRequestScopedAttachment } from './attachments.ts'
import { reportEnvironment } from './environment-check.ts'
import { HUMAN_PROFILE_DEFAULT_NAME, HUMAN_PROFILE_REPO_URL, HUMAN_PROFILE_SETTINGS_SCHEMA, HUMAN_PROFILE_VERSION, assertValidHumanName, normalizeHumanName, parseLegacyHumanProfile, planLegacyAdoption, type LegacyHumanProfileFields } from './human-profile.ts'
import { HUMAN_PROFILE_SETTINGS_NAMESPACE } from './human-settings.ts'
import { humanAvatarsRoot, readHumanAvatar, removeHumanAvatar, writeHumanAvatar } from './human-avatar.ts'
import { createHumanUpdateChecker } from './human-update-check.ts'
import { AgentTeamInvariantError } from './invariant.ts'
import { TEAM_CONTEXT_CODEC } from './context-codec.ts'
import { TeamContextManagement, type TeamTransitionPlan } from './team-context-management.ts'
import { decideWakeRecycle, DEFAULT_WAKE_RECYCLE, type WakeRecycleConfig, type WakeRecyclePlan } from './wake-recycle.ts'
import { AGENT_TEAM_PLUGIN_ID, isAgentTeamSource } from './context-source.ts'
import { surfaceVisibilityProbe, NOTIFICATION_BODY_MAX_CHARACTERS, NOTIFICATION_TRUNCATION_MARKER } from './surface-visibility.ts'
import { CONTEXT_CONTINUITY_PROJECTION_KEY, carriedInputOf, createTeamContextProjectionDefinition, foldTeamContextProjection, TeamContextProjectionHost, TEAM_INBOX_NOTICE_SUMMARY, TEAM_RECOVERY_NOTICE_SUMMARY } from './context-projection.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID, AgentTeamLedger, agentTeamHostActor, agentTeamHumanActor } from './ledger.ts'
import { AGENT_TEAM_TOOL_NAMES, deepCopyCapabilities, memberMemoryDirectoryName, MemberRuntime, type TurnBoundary } from './member-runtime.ts'
import { classifyRecoverableError, failureDetail, RecoveryCoordinator, type RecoveryFact } from './recovery.ts'
import { StoredSessionReadError, StoredSessionReader, sessionFailureOf, type StoredSessionInspection } from './stored-session-reader.ts'
import { agentTeamDomainSpec } from './spec.ts'
import { formatTeamTimestamp } from './time-format.ts'
import type {
  AgentTeamAddMemberRequest,
  AgentTeamAddMemberResult,
  AgentTeamAgentMember,
  AgentTeamAgentMemberStatus,
  AgentTeamArchiveChannelRequest,
  AgentTeamArchiveChannelResult,
  AgentTeamArchiveMemberRequest,
  AgentTeamArchiveMemberResult,
  AgentTeamChangeScope,
  AgentTeamChangesRequest,
  AgentTeamChangesResult,
  AgentTeamActivity,
  AgentTeamClaimList,
  AgentTeamClaimRequest,
  AgentTeamClaimResult,
  AgentTeamClientMemberStatus,
  AgentTeamAttachmentId,
  AgentTeamModelSelection,
  AgentTeamCreateChannelRequest,
  AgentTeamCreateChannelResult,
  AgentTeamEnvironmentRequest,
  AgentTeamEnvironmentResult,
  AgentTeamGetAttachmentRequest,
  AgentTeamGetAttachmentResult,
  AgentTeamGetHumanAvatarRequest,
  AgentTeamGetHumanAvatarResult,
  AgentTeamHumanProfileRequest,
  AgentTeamHumanProfileResult,
  AgentTeamPutHumanAvatarRequest,
  AgentTeamPutHumanAvatarResult,
  AgentTeamRemoveHumanAvatarRequest,
  AgentTeamRemoveHumanAvatarResult,
  AgentTeamInbox,
  AgentTeamInboxRequest,
  AgentTeamJoinWorkspaceRequest,
  AgentTeamJoinWorkspaceResult,
  AgentTeamLeaveWorkspaceRequest,
  AgentTeamLeaveWorkspaceResult,
  AgentTeamHumanActor,
  AgentTeamMemberActor,
  AgentTeamMessageAttachment,
  AgentTeamMemberEffect,
  AgentTeamMemberId,
  AgentTeamMemberResult,
  AgentTeamMembersRequest,
  AgentTeamMessageRef,
  AgentTeamResolveMessageRefsRequest,
  AgentTeamResolveMessageRefsResult,
  AgentTeamResolveTaskRefsRequest,
  AgentTeamResolveTaskRefsResult,
  AgentTeamResolveThreadRefsRequest,
  AgentTeamResolveThreadRefsResult,
  AgentTeamTaskRef,
  AgentTeamThreadRef,
  AgentTeamOperation,
  AgentTeamOperationReceipt,
  AgentTeamPromoteThreadRequest,
  AgentTeamPromoteThreadResult,
  AgentTeamPutAttachmentRequest,
  AgentTeamPutAttachmentResult,
  AgentTeamRecoverMemberRequest,
  AgentTeamRecoverMemberResult,
  AgentTeamClearMemberContextRequest,
  AgentTeamClearMemberContextResult,
  AgentTeamDmRequest,
  AgentTeamDmResult,
  AgentTeamOperationId,
  AgentTeamRequestId,
  AgentTeamRemoveMemberRequest,
  AgentTeamRemoveMemberResult,
  AgentTeamReplyRequest,
  AgentTeamMessage,
  AgentTeamMessageReplyContext,
  AgentTeamThreadFact,
  AgentTeamReadMessageRequest,
  AgentTeamReadMessageResult,
  AgentTeamReplyResult,
  AgentTeamSendMessageRequest,
  AgentTeamSendMessageResult,
  AgentTeamSetHumanProfileRequest,
  AgentTeamSetHumanProfileResult,
  AgentTeamSetMemberStateRequest,
  AgentTeamStatus,
  AgentTeamTask,
  AgentTeamTaskRequest,
  AgentTeamTaskResult,
  AgentTeamThreadAttentionRequest,
  AgentTeamThreadAttentionResult,
  AgentTeamThreadAttentionStatus,
  AgentTeamThreadHistory,
  AgentTeamThreadHistoryRequest,
  AgentTeamThreadReadRequest,
  AgentTeamThreadReadResult,
  AgentTeamMemberDiagnostic,
  AgentTeamThreadObservations,
  AgentTeamThreadObservationsRequest,
  AgentTeamUpdateChannelRequest,
  AgentTeamUpdateChannelResult,
  AgentTeamUpdateMemberRequest,
  AgentTeamUpdateMemberResult,
  AgentTeamView,
  AgentTeamViewRequest,
} from './types.ts'

export { agentTeamDomainSpec, agentTeamOperationSchema } from './spec.ts'
export type * from './types.ts'
export { AGENT_TEAM_HUMAN_HANDLE, AGENT_TEAM_HUMAN_MEMBER_ID, AGENT_TEAM_INITIALIZE_REQUEST_ID } from './ledger.ts'
export { HUMAN_PROFILE_DEFAULT_NAME, HUMAN_PROFILE_REPO_URL, HUMAN_PROFILE_SETTINGS_SCHEMA, HUMAN_PROFILE_VERSION, assertValidHumanName, normalizeHumanName } from './human-profile.ts'
export { HUMAN_PROFILE_SETTINGS_NAMESPACE } from './human-settings.ts'
export { humanAvatarsRoot } from './human-avatar.ts'
export { AGENT_TEAM_TOOL_NAMES } from './member-runtime.ts'

/** Process-stable marker carried by the final Team message tool definition. */
export const AGENT_TEAM_PRESET_MARKER = Symbol.for('@wowyuarm/dsh-agent-team.preset')

const ORPHANED_MEMBER_DIAGNOSTIC = 'Member preset composition was lost after a reload; its tools are unavailable. Resume rebuilds the member in place.'

/**
 * A preset mount/validation failure during activation, carrying its own class
 * so the activation diagnostic can route preset-composition failures (the
 * install/runtime split failure mode) without matching message text.
 */
class PresetCompositionError extends Error {
  constructor(message: string, options: ErrorOptions) {
    super(message, options)
    this.name = 'PresetCompositionError'
  }
}

/** One live invalidation subscription, restricted to its declared scope. */
interface ChangeWaiter {
  readonly scope: AgentTeamChangeScope | undefined
  wake(version: number): void
}

/**
 * Why one Inbox wake ran. The business identity that caused it — the committed
 * operation with its request id, or the lifecycle step rederiving the same
 * durable facts — stays separate from the delivery attempt the wake spends: a
 * retry after a failed wake is a new attempt over the same facts, never a new
 * request. A lifecycle cause names the previous Session when the line covers a
 * transition, so both generations stay locatable.
 */
type NotificationCause =
  | { readonly kind: 'commit'; readonly receipt: AgentTeamOperationReceipt; readonly operationKind: AgentTeamOperation['kind'] }
  | { readonly kind: 'transition'; readonly requestId: AgentTeamRequestId; readonly previousSessionId: SessionId }
  | { readonly kind: 'activation'; readonly previousSessionId?: SessionId }
  | { readonly kind: 'running' }

/**
 * One Member's Inbox notice delivery state. `covered` is the durable fact set
 * the queued notice answers; `attempt` counts delivery attempts over that
 * Member, so a retry is visibly the same work tried again rather than a new
 * request. A membership whose last delivery failed keeps its attempt count and
 * drops `covered`, which is what makes the next fact rederive and retry.
 */
interface InboxNoticeDelivery {
  readonly covered: string
  readonly attempt: number
}

function sameChangeScope(left: AgentTeamChangeScope, right: AgentTeamChangeScope): boolean {
  if (left.kind === 'workspace' && right.kind === 'workspace') return left.workspaceId === right.workspaceId
  if (left.kind === 'channel' && right.kind === 'channel') return left.channelRef === right.channelRef
  if (left.kind === 'thread' && right.kind === 'thread') return left.threadRef === right.threadRef
  if (left.kind === 'presence' && right.kind === 'presence') return left.workspaceId === right.workspaceId
  return false
}

/** Mark the preset's `team_message` definition as an Agent Team consumer. */
export function markAgentTeamPreset<T extends object>(definition: T): T {
  Object.defineProperty(definition, AGENT_TEAM_PRESET_MARKER, { value: true })
  return definition
}

/**
 * Whether the running dsh loads workspace packages from source via tsx.
 *
 * The Harness `tsconfig.base.json` maps `@deepseek-ai/*` package names onto
 * `src/` directories; tsx honors those paths, so a CLI launched with
 * `node --import tsx/esm apps/cli/src/bin.ts` imports `@deepseek-ai/dsh-scope`
 * from `src/index.ts` while a profile-installed bundle resolves the compiled
 * `lib/index.js` — two module instances with independent scope keys.
 */
export function isTsxDevMode(): boolean {
  const flags = [...process.execArgv]
  const nodeOptions = process.env.NODE_OPTIONS
  if (nodeOptions !== undefined) flags.push(...nodeOptions.split(/\s+/))
  return flags.some(flag => flag.includes('tsx'))
}

/**
 * The activation diagnostic for a dsh-scope module-instance mismatch.
 *
 * `agentPresets.mount` already rejected an unscoped context, so a scope key
 * the harness sees but this bundle does not can only mean the two sides
 * loaded different physical copies of `@deepseek-ai/dsh-scope`.
 */
export function teamPresetScopeMismatchMessage(tsxDevMode: boolean): string {
  if (tsxDevMode) {
    return 'selected preset is not team-enabled: the dsh CLI is running from source via tsx (tsconfig paths resolve @deepseek-ai/dsh-scope to src/), so the harness and this bundle load different module instances; start dsh with the compiled CLI instead (pnpm dsh, node apps/cli/lib/bin.js, or npx @deepseek-ai/dsh)'
  }
  return 'selected preset is not team-enabled: this bundle and the harness resolved different physical copies of @deepseek-ai/dsh-scope; run pnpm install in the profile directory so node_modules matches the lockfile, then restart'
}

export interface AgentTeamCommitted {
  readonly receipt: AgentTeamOperationReceipt
}

/**
 * A DM was durably recorded but its session injection could not run (no live
 * handle, or the wake itself failed). The recorded DM stays durable; the
 * sender should not blindly retry — the recipient recovers it through its DM
 * history once its session is live again.
 */
export class AgentTeamDmDeliveryError extends Error {
  constructor(readonly recipientMemberId: AgentTeamMemberId, readonly recipientHandle: string, message: string) {
    super(message)
    this.name = 'AgentTeamDmDeliveryError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeam: AgentTeam
  }

  interface Events {
    /** One new Team operation is durable and visible through Host projections. */
    'agent-team/committed'(event: AgentTeamCommitted): void
  }
}

/**
 * Config of the Team Host row: the Human profile (see human-profile.ts). The
 * settings service derives the form from the owning plugin's Config, so the
 * profile is this plugin's own config rather than a section of its own.
 *
 * The settings service offers a form only for volatile fields, so a
 * non-volatile field is invisible AND unwritable — it could only be patched.
 */
export interface Config {
  name: Volatile<string>
  avatarRef: Volatile<string | undefined>
  wakeRecycle: Volatile<WakeRecycleConfig>
}

/**
 * The wake-swap thresholds as one volatile group. The group carries its own
 * defaults so a profile that has never written one still resolves a complete
 * config, and each field is writable without remounting the Host.
 */
export const WAKE_RECYCLE_SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(DEFAULT_WAKE_RECYCLE.enabled),
  idleMs: z.number().min(0).default(DEFAULT_WAKE_RECYCLE.idleMs),
  minContextTokens: z.number().min(0).default(DEFAULT_WAKE_RECYCLE.minContextTokens),
}).default({}).volatile()

/**
 * The Host row's whole schema: the profile fields verbatim, so their volatility
 * and defaults stay owned by {@link HUMAN_PROFILE_SETTINGS_SCHEMA}. A patch
 * layer replaces this row's whole config, so the parts are declared together
 * and nowhere else.
 */
export const TEAM_HOST_ROW_SETTINGS_SCHEMA = z.object({
  ...HUMAN_PROFILE_SETTINGS_SCHEMA.dict,
  wakeRecycle: WAKE_RECYCLE_SETTINGS_SCHEMA,
})

/** Host owner of the single Agent Team in one dshHome. */
export default class AgentTeam extends TypertRemoteService {
  static Config = TEAM_HOST_ROW_SETTINGS_SCHEMA
  static inject = [
    'storageDomain',
    'workspaceRegistry',
    'agents',
    'agentDefaultModel',
    'agentPresets',
    'tools',
    'sessionPersistence',
    'sessionProjections',
  ]

  private domain?: Domain<typeof agentTeamDomainSpec>
  private ledger?: AgentTeamLedger
  private readonly handles = new Map<AgentTeamMemberId, AgentHandle>()
  /** Live Member per session id; drives the root session/event listener. */
  private readonly memberBySessionId = new Map<SessionId, AgentTeamMemberId>()
  /** Live selection refs let model edits take effect without disposing the Session. */
  private readonly modelSelections = new Map<AgentTeamMemberId, ModelSelectionRef>()
  /** Agent ids with a turn in flight; restarts must wait for the boundary. */
  private readonly runningAgents = new Set<SessionId>()
  /** Per-Member runtime state: tool restrictions, skill mounts, warnings, private memory. */
  private readonly memberRuntime = new MemberRuntime({
    ctx: this.ctx,
    liveMemberContext: memberId => this.liveContextFor(memberId),
    runningAgents: this.runningAgents,
  })
  /**
   * The single seam for every per-Session stored read: handle lifecycle and
   * failure normalization live here, so a DSH persistence-interface change is
   * adapted once, and consumers choose policy by failure category instead of
   * matching error text.
   */
  private readonly sessionReader = new StoredSessionReader(this.ctx)
  /**
   * Why one Member shows error presence, per failure source. Reads prefer
   * activation, then runtime, then compaction; slots clear independently, so
   * a recovered runtime error re-reveals an outstanding compaction failure.
   * Keyed by Member rather than Session so a restarted Session cannot leak
   * stale keys.
   */
  private readonly memberFailures = new Map<AgentTeamMemberId, {
    /** Activation failed; the Member has no live Session to recover into. */
    activation?: AgentTeamMemberDiagnostic
    /** The Member Session reported agent/error. */
    runtime?: string
    /** A Team wake was discarded before the Agent opened its turn boundary. */
    preTurnCancellation?: AgentTeamMemberDiagnostic
    /** The post-commit configuration apply failed; the stored row is ahead of the live surface. */
    capabilityApply?: AgentTeamMemberDiagnostic
  }>()
  /** Team notice ids waiting for a turn boundary, keyed by the live Agent message id. */
  private readonly pendingTeamWakes = new Map<string, { readonly memberId: AgentTeamMemberId; readonly sessionId: SessionId }>()
  /** Notice removals initiated by Team itself, which are normal replacement/disposal operations. */
  private readonly expectedInboxDiscards = new Set<string>()
  /**
   * Per-Member Inbox notice delivery: which unread facts the last attempt
   * covered, and how many attempts those facts have spent. The two live in one
   * record because the attempt is not the business request that revealed the
   * facts — a retry after a failed wake spends the next attempt over the same
   * durable facts, never a second operation.
   */
  private readonly inboxNoticeDeliveries = new Map<AgentTeamMemberId, InboxNoticeDelivery>()
  private attachmentGcTimer?: ReturnType<typeof setInterval> | undefined
  /**
   * New-release check behind the settings footnote. Memory-only and
   * background-refreshed, so the profile read path never waits on the
   * network and every failure settles as "no update known".
   */
  private readonly humanUpdateCheck = createHumanUpdateChecker({ currentVersion: HUMAN_PROFILE_VERSION })

  private readonly recovery = new RecoveryCoordinator({
    wake: memberId => { this.injectRecovery(memberId) },
    report: fact => { this.reportRecovery(fact) },
  })
  /**
   * Team's domain half of the continuity projection: the durable ref naming,
   * the Team-notice rule, and the boundary judgement (committed messages,
   * claim changes, first Thread arrivals). Its claim attribution resolves the
   * Task's Thread through the ledger, which is why the resolver reads
   * `this.ledger` lazily — the fold may run before the domain is open, and an
   * unattributed boundary is still a valid anchor.
   */
  private readonly contextProjectionHost = new TeamContextProjectionHost({
    threadForTask: taskRef => this.ledger?.threadForTask(taskRef),
  })
  private readonly contextManagement = new TeamContextManagement({
    agentForMember: memberId => this.handles.get(memberId)?.agent,
    memberForAgent: agent => this.memberForAgent(agent),
    projectionForMember: (memberId, sessionId) => {
      const handle = this.handles.get(memberId)
      if (handle === undefined || handle.agent.session.id !== sessionId) return undefined
      return this.ctx.sessionProjections.stateOf(handle.agent.session, CONTEXT_CONTINUITY_PROJECTION_KEY)
    },
    executeTransition: (memberId, plan) => this.executeMemberTransition(memberId, plan),
    messages: {
      continuation: checkpointRef => TEAM_CONTEXT_CODEC.createCheckpointContinuationMessage(checkpointRef),
    },
    log: message => { this.ctx.logger.warn(`agent-team: ${message}`) },
  })
  /**
   * Per-Member lifecycle chains: one Member's long waits (its turn boundary,
   * its idle) hold only that Member's later operations, so managing another
   * Member never queues behind them. Order within a chain is submission
   * order, preserving same-Member edit/stop/archive/remove/transition
   * sequencing; cross-Member commits stay totally ordered by the ledger's own
   * single writer queue.
   */
  private readonly memberLifecycleTails = new Map<AgentTeamMemberId, Promise<void>>()
  private readonly enteredMemberChains = new AsyncLocalStorage<ReadonlySet<AgentTeamMemberId>>()
  private readonly enteredAdditionChains = new AsyncLocalStorage<ReadonlySet<AgentTeamRequestId>>()
  /**
   * addMember chains by request id: the Member id does not exist until the
   * commit answers, and concurrent duplicates of one request must serialize
   * so exactly one of them activates the replayed id.
   */
  private readonly additionLifecycleTails = new Map<AgentTeamRequestId, Promise<void>>()
  /** Resolves when Host teardown starts: in-chain idle waits release on it instead of outliving the Host. */
  private readonly shutdown = (() => {
    let resolve!: () => void
    const promise = new Promise<void>(finish => { resolve = finish })
    return Object.freeze({ promise, resolve })
  })()
  private accepting = true
  /** One adoption attempt per boot: the two readiness edges fire once each, and this keeps their attempt single. */
  private legacyAdoptionStarted = false
  /**
   * Presence wake epoch: Agent running/idle/failure is runtime state with no
   * durable fact behind it, so the presence scope counts those edge wakes in
   * process. It never takes part in a projection waiter's comparison.
   */
  private presenceEpoch = 0
  private readonly changeWaiters = new Set<ChangeWaiter>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentTeam')
    this.ctx.inject(['settings'], settingsCtx => {
      settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, this.ctx.fiber))
      this.adoptLegacyHumanProfile()
    })
    this.ctx.on('loader/volatile-update', () => {
      this.syncHumanHandle()
    })
  }

  private printableSender(memberId: AgentTeamMemberId): string {
    return memberId === AGENT_TEAM_HUMAN_MEMBER_ID
      ? 'human'
      : this.requireLedger().getMember(memberId)?.handle ?? memberId
  }

  /**
   * What every reply in this window answers, resolved in one pass.
   *
   * One call for the whole window rather than one per reply: a read is a
   * bounded batch and the resolution is a pure ledger lookup, so the cost
   * belongs to the read, not to each fact in it.
   */
  private replyContextsFor(facts: readonly AgentTeamThreadFact[], workspaceId: WorkspaceId): ReadonlyMap<AgentTeamMessageRef, AgentTeamMessageReplyContext> {
    const contexts = new Map<AgentTeamMessageRef, AgentTeamMessageReplyContext>()
    const refs = facts.flatMap(fact => fact.kind === 'message' && fact.message.replyToMessageRef !== undefined
      ? [fact.message.replyToMessageRef]
      : [])
    if (refs.length === 0) return contexts
    for (const parent of this.requireLedger().resolveMessageRefs(workspaceId, refs)) {
      contexts.set(parent.messageRef, Object.freeze({ sender: this.printableSender(parent.sender), excerpt: parent.excerpt }))
    }
    return contexts
  }

  /**
   * The same fact with its reply target attached.
   *
   * A new object, never an edit in place: these facts are the payload of a
   * durable read, and writing a read-time projection into one would either
   * freeze-throw or leave a stored record carrying a field its schema does not
   * know — which is how a whole domain stops reopening.
   */
  private withReplyTo(fact: AgentTeamThreadFact, contexts: ReadonlyMap<AgentTeamMessageRef, AgentTeamMessageReplyContext>): AgentTeamThreadFact {
    if (fact.kind !== 'message') return fact
    const ref = fact.message.replyToMessageRef
    const replyTo = ref === undefined ? undefined : contexts.get(ref)
    return replyTo === undefined ? fact : Object.freeze({ ...fact, replyTo })
  }

  /**
   * The `Replies to:` line for one notice, or nothing when it answers nothing.
   *
   * An unresolvable target falls back to the bare ref instead of failing or
   * inventing a summary: an archived Channel stops resolving, and the ref is
   * then the only true thing left to say.
   */
  private repliesToLine(message: AgentTeamMessage, workspaceId: WorkspaceId): string | undefined {
    const ref = message.replyToMessageRef
    if (ref === undefined) return undefined
    const parent = this.requireLedger().resolveMessageRefs(workspaceId, [ref])[0]
    return parent === undefined
      ? `Replies to: ${ref}`
      : `Replies to: @${this.printableSender(parent.sender)} — "${parent.excerpt}" [${ref}]`
  }

  /**
   * The live agent context of one Member, resolved at call time. A Member with
   * no live handle cannot take a tool-policy update, so that is an error rather
   * than an undefined return.
   */
  private liveContextFor(memberId: AgentTeamMemberId): Context {
    const handle = this.handles.get(memberId)
    if (handle === undefined) throw new Error(`Agent Member '${this.memberLabel(memberId)}' has no live session for a tool-policy update`)
    return handle.agent.ctx
  }

  private wakeRecycleConfig(): WakeRecycleConfig {
    return this.config.wakeRecycle.get()
  }

  /**
   * Whether this generation should be replaced before the next message reaches
   * it. The cheap gates decide from the log's own newest event time; only a
   * generation that passed all of them is priced, because pricing rebuilds a
   * cold Session — the whole-log replay this order keeps off every ordinary
   * wake.
   */
  private async planWakeForMember(member: AgentTeamAgentMember, agent: Agent | undefined): Promise<WakeRecyclePlan> {
    const stored = agent === undefined ? await this.sessionReader.read(member.sessionId) : undefined
    const events = agent !== undefined ? agent.session.ownEvents() : stored?.ok === true ? stored.inspection.events : undefined
    const plan = this.cheapWakePlan(events)
    if (plan.action !== 'measure-context') return plan
    const contextTokens = agent !== undefined
      ? this.measureLiveContext(agent)
      : stored?.ok === true ? this.measureStoredContext(member.sessionId, stored.inspection) : null
    return decideWakeRecycle({ config: this.wakeRecycleConfig(), facts: { hasPriorGeneration: true, lastActivityAtMs: lastActivityTime(events ?? []), contextTokens }, nowMs: Date.now() })
  }

  private cheapWakePlan(events: readonly SessionEvent[] | undefined): WakeRecyclePlan {
    if (events === undefined || events.length === 0) return { action: 'resume', reason: 'no_prior_generation' }
    return decideWakeRecycle({
      config: this.wakeRecycleConfig(),
      facts: { hasPriorGeneration: true, lastActivityAtMs: lastActivityTime(events), contextTokens: null },
      nowMs: Date.now(),
    })
  }

  private measureLiveContext(agent: Agent): number | null {
    try {
      return this.ctx.tokenMeter.measure(agent.session).totalTokens
    } catch {
      return null
    }
  }

  private measureStoredContext(sessionId: SessionId, inspection: StoredSessionInspection): number | null {
    try {
      const session = Session.create(sessionId, inspection.events, inspection.header, inspection.inheritedEventCount)
      return this.ctx.tokenMeter.measure(session).totalTokens
    } catch {
      return null
    }
  }

  private async recycleColdGeneration(member: AgentTeamAgentMember, agent: Agent): Promise<Error | undefined> {
    const plan = await this.planWakeForMember(member, agent)
    if (plan.action !== 'recycle') return undefined
    this.ctx.logger.info(`agent-team: waking ${this.memberScope(member.memberId, agent.id)} swaps its cold generation: idle ${plan.idleMs}ms over ${plan.thresholds.idleMs}ms, context ${plan.contextTokens} over ${plan.thresholds.minContextTokens}`)
    await this.contextManagement.requestRecycle(member.memberId, { ...member, sessionId: agent.session.id })
    if (this.handles.has(member.memberId)) return undefined
    return new Error('the generation swap could not complete; the Member stays on its previous generation')
  }

  private async wakeGateFor(agent: Agent): Promise<Error | undefined> {
    const member = this.memberForAgent(agent)
    if (member === undefined || agent.status !== 'idle') return undefined
    if (this.contextManagement.isTransitioning(member.memberId)) {
      await this.contextManagement.whenSettled(member.memberId)
      return this.handles.has(member.memberId) ? undefined : new Error('the Member is changing generation and the swap has not finished; the message stays durable in its Inbox')
    }
    return this.recycleColdGeneration(member, agent)
  }
  /** Current human display name; the single source for team_view and @ matching. */
  humanHandle(): string {
    const name = normalizeHumanName(this.config.name.get())
    return name === '' ? HUMAN_PROFILE_DEFAULT_NAME : name
  }

  /**
   * Current human profile reference held in this Host row's Config (name +
   * avatarRef). `avatarRef` is present only when one is configured — never
   * explicit `undefined` — so the shape satisfies optional-property consumers
   * under exactOptionalPropertyTypes.
   */
  humanProfile(): { readonly name: string; readonly avatarRef?: string } {
    const avatarRef = this.config.avatarRef.get()
    return Object.freeze({ name: this.humanHandle(), ...(avatarRef === undefined ? {} : { avatarRef }) })
  }

  /** Push the current Config name into the ledger's runtime @ handle; the ledger may not be open yet, and the post-open sync covers that. */
  private syncHumanHandle(): void {
    this.ledger?.setHumanDisplayHandle(this.humanHandle())
  }

  /**
   * The two judgements the Config schema cannot make about a Human name: the
   * same non-empty floor as Member handles, plus global uniqueness against live
   * Members. `setHumanProfile` runs it before the write, so a colliding rename
   * rejects instead of persisting. It reads the one field it judges, so the
   * caller passes the name alone rather than a whole profile shape.
   */
  private validateHumanProfile(value: { readonly name: string }): void {
    const name = assertValidHumanName(value.name)
    const ledger = this.ledger
    if (ledger === undefined) return
    const normalized = name.normalize('NFKC').trim().toLowerCase()
    for (const member of ledger.listMembers()) {
      if (member.state === 'inactive' || member.state === 'archived') continue
      if (member.handle.normalize('NFKC').trim().toLowerCase() === normalized) {
        throw new Error(`human name '${name}' collides with an existing Member handle`)
      }
    }
  }

  /**
   * One-time adoption of the profile facts the retired `agent-team-human`
   * settings section held (see `LEGACY_HUMAN_PROFILE_SECTION` for why the
   * upstream importer cannot carry them over). The values land in this Host
   * row's own Config through the same Remote the profile page writes, so the
   * page, the ledger's @ handle, and every avatar seat follow as after any
   * edit. Readiness has two one-way edges — the settings service arrives, the
   * ledger opens — and whichever fires second starts the attempt; only a
   * pristine profile is adopted, and one attempt per boot is its whole
   * lifetime, so adoption never loops and never re-writes.
   */
  private adoptLegacyHumanProfile(): void {
    if (this.legacyAdoptionStarted) return
    if (this.ctx.get('settings') === undefined || this.ledger === undefined) return
    this.legacyAdoptionStarted = true
    void this.adoptLegacyHumanProfileNow().catch((error: unknown) => {
      this.ctx.logger.warn('agent-team: legacy human profile adoption failed: %s', String(error))
    })
  }

  /** Carry the first legacy document that still has the section into a pristine profile. */
  private async adoptLegacyHumanProfileNow(): Promise<void> {
    // A profile-launched Host always carries the profile context; a Host booted
    // without one still adopts from the DSH home, which is where a pre-rc.1
    // install kept the document. Read through `get`: cordis refuses a direct
    // `ctx.profileContext` for a service this plugin does not declare, and
    // adoption may not gate the Host on app-boot.
    const profileHome: string | undefined = this.ctx.get('profileContext')?.home
    const homes = profileHome === undefined ? [dshHomePath()] : [dshHomePath(), profileHome]
    const candidates = new Set(homes.flatMap(home => [join(home, 'settings.yaml'), join(home, 'settings.yaml.imported')]))
    let legacy: LegacyHumanProfileFields | undefined
    let source: string | undefined
    for (const candidate of candidates) {
      let text: string
      try {
        text = readFileSync(candidate, 'utf8')
      } catch {
        // Absent candidates are the steady state once adoption settles; the
        // live document is one only because the first boot after the upgrade
        // can race the importer that renames it.
        continue
      }
      const parsed = parseLegacyHumanProfile(text)
      if (parsed !== undefined) {
        legacy = parsed
        source = candidate
        break
      }
    }
    if (legacy === undefined || source === undefined) return
    // The reference is carried only while its bytes still draw: the avatar
    // store is the authority for whether this avatar exists at all.
    let avatarRef = legacy.avatarRef
    if (avatarRef !== undefined && await readHumanAvatar(humanAvatarsRoot(), avatarRef) === undefined) avatarRef = undefined
    const plan = planLegacyAdoption(this.humanProfile(), {
      ...(legacy.name === undefined ? {} : { name: legacy.name }),
      ...(avatarRef === undefined ? {} : { avatarRef }),
    })
    if (plan === undefined) return
    await this.setHumanProfile(plan)
    this.ctx.logger.info('agent-team: adopted the legacy human profile from %s', source)
  }

  /** Open the durable ledger and restore every enabled Member independently. */
  protected async [Service.init](): Promise<void> {
    // The continuity projection registers once per Host: the framework keeps
    // one unit per projection key and drives it for every Session, so Team's
    // fold is session-agnostic and the state carries the identity it folds.
    // The registration rides this plugin's fiber — unloading Team removes the
    // key (and its cached cells) from later drives and snapshots.
    this.ctx.effect(() => this.ctx.root.sessionProjections.register(
      createTeamContextProjectionDefinition(this.contextProjectionHost),
    ), 'agentTeam.contextProjection')
    this.ctx.on('agent/error', ({ agent, error }) => {
      const member = this.memberForAgent(agent)
      if (member === undefined) return
      const message = error instanceof Error ? error.message : String(error)
      this.setMemberFailure(member.memberId, 'runtime', message)
      // Every occurrence is classified here, including the two verdicts the
      // coordinator then reports no state change for (a terminal error with no
      // episode to cancel, and a repeat after standing down). Those belong at
      // diagnostic level: they explain why no automatic recovery was scheduled,
      // while the coordinator's own lines stay bounded by state changes.
      const kind = classifyRecoverableError(error)
      this.ctx.logger.debug(`agent-team: ${this.memberScope(member.memberId, agent.id)} reported an error classified as ${kind === undefined ? 'not automatically recoverable' : `recoverable ${kind}`}: ${message}`)
      this.recovery.onError(member.memberId, error)
      this.emitMemberPresenceChanged(member)
    })
    this.ctx.on('agent/status', ({ agent, status }) => {
      const member = this.memberForAgent(agent)
      if (status === 'running') this.runningAgents.add(agent.id)
      else this.runningAgents.delete(agent.id)
      if (status === 'running' && member !== undefined) {
        const recovered = this.clearMemberFailure(member.memberId, 'runtime')
        const preTurnRecovered = this.clearMemberFailure(member.memberId, 'preTurnCancellation')
        if (recovered || preTurnRecovered) this.dropInboxCoverage(member.memberId)
        this.emitMemberPresenceChanged(member)
        // A transition in flight delivers its own sequenced rederived Inbox
        // after any carried input; a status-driven steer would leapfrog it.
        if (!this.contextManagement.isTransitioning(member.memberId)) this.notifyMember(agent, { kind: 'running' })
      }
      // A turn that ends without an error closes any automatic recovery episode.
      // The idle transition is itself presence-affecting (working → available),
      // so it must wake presence watchers exactly like the running transition
      // above; without this wake, cached Client member rows keep showing the
      // Member as working after every turn until an unrelated change arrives.
      if (status === 'idle' && member !== undefined) {
        if (this.memberFailures.get(member.memberId)?.runtime === undefined) {
          this.recovery.onCleanTurnEnd(member.memberId)
        }
        this.emitMemberPresenceChanged(member)
      }
    })
    // A Team notice can be removed before the Agent opens `turn/start`.
    // `agent/inbox/spliced` deliberately carries no cancellation owner, so a
    // claimed notice is a normal consumed wake, while a discarded one the Host
    // did not itself retire is the narrowest Team-owned signal of a drop.
    this.ctx.on('agent/inbox/claimed', ({ message }) => {
      this.pendingTeamWakes.delete(message.id)
    })
    this.ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      const pending = this.pendingTeamWakes.get(message.id)
      if (pending === undefined) return
      this.pendingTeamWakes.delete(message.id)
      if (this.expectedInboxDiscards.delete(message.id)) return
      const member = this.memberForAgent(agent)
      if (member === undefined || member.state !== 'enabled' || agent.id !== pending.sessionId) return
      this.setPreTurnCancellation(member.memberId, pending.sessionId)
      this.emitMemberPresenceChanged(member)
    })
    // The store's dispatch carrier is untagged, so a scope-tagged listener
    // inside the Agent setup would receive nothing; one root listener that
    // maps the session id back to its Member is the seam that works (same
    // shape as the `agent/status` listener above). The first turn of a
    // freshly published Member cannot race this: `handles.set()` precedes the
    // same activation continuation that publishes the Agent, so by the time
    // any tool call streams, the map lookup succeeds.
    this.ctx.on('session/event', (session, event) => {
      const memberId = this.memberBySessionId.get(session.id)
      if (memberId === undefined) return
      const handle = this.handles.get(memberId)
      if (handle === undefined || handle.agent.session.id !== session.id) return
      // Context management reacts only after a successful durable tool/result;
      // the projection (not this listener) decides what that means.
      this.contextManagement.onSessionEvent(memberId, handle.agent, event)
    })
    const domain = await this.ctx.storageDomain.open(agentTeamDomainSpec)
    this.ctx.effect(() => async () => {
      this.accepting = false
      // Host shutdown must not depend on a turn that may never end: release
      // every wait (in-chain idle waits through the gate, boundary waits
      // through the runtime), so the chains below can drain to zero first.
      this.shutdown.resolve()
      this.memberRuntime.releaseTurnWaits()
      this.recovery.dispose()
      this.contextManagement.dispose()
      if (this.attachmentGcTimer !== undefined) clearInterval(this.attachmentGcTimer)
      this.attachmentGcTimer = undefined
      this.emitChanged()
      // Every lifecycle operation enqueued before `accepting` flipped is in
      // one of the two maps (new ones reject at enqueue), so this snapshot
      // drains them all.
      await Promise.all([...this.memberLifecycleTails.values(), ...this.additionLifecycleTails.values()])
      await Promise.all([...this.handles.values()].map(handle => this.disposeWithWakeGuard(handle)))
      this.handles.clear()
      this.modelSelections.clear()
      this.memberRuntime.disposeAll()
      this.runningAgents.clear()
      await domain.close()
    }, 'agentTeam.dispose')
    this.domain = domain
    const ledger = new AgentTeamLedger(domain.table('operations'), {
      isFactVisible: surfaceVisibilityProbe(memberId => this.handles.get(memberId)?.agent),
    })
    this.ledger = ledger
    // A live Config edit in the constructor's window may have arrived before
    // the ledger existed; sync once here so @ matching starts from the stored
    // name.
    this.syncHumanHandle()
    this.adoptLegacyHumanProfile()
    const initialization = await ledger.initialize()
    if (initialization.committed) this.emitCommitted(initialization.value)
    this.startAttachmentGc(ledger)
    // One metadata listing serves every Member restore; per-member list calls
    // would repeat the same I/O linearly during startup.
    const persistedSessions = new Set((await this.persistedSessionHeaders()).map(snapshot => snapshot.header.id))
    await this.sweepWorkspaceParticipations(ledger)
    for (const member of ledger.listMembers()) {
      if (member.state === 'enabled') {
        // A renewal or rollover that committed but never finished leaves no
        // live handle to reveal it: startup derives the outstanding effects
        // from the ledger and the registry's archive set. A Workspace fault
        // must not keep the Member from running on its recorded binding, so
        // the ordinary activation path still runs when the retire half cannot
        // be finished here.
        try {
          await this.finishMemberTransition(member.memberId, { knownSessions: persistedSessions })
        } catch (error) {
          this.ctx.logger.warn(`agent-team: could not finish the recorded Session transition for member '${member.handle}': ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!this.handles.has(member.memberId)) await this.activateMember(member, undefined, persistedSessions)
      } else {
        // Every other durable state converges through the same effect table
        // its operation runs after the commit, so a crash or a failed call
        // between commit and effect is finished here. One Member's fault
        // must not fail the boot: it is logged and retried at the next
        // startup, where the call that failed may have healed.
        try {
          await this.convergeMemberEffects(member)
        } catch (error) {
          this.ctx.logger.warn(`agent-team: could not converge member '${member.handle}' to its '${member.state}' state: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  /**
   * Lazy Workspace-deletion handling: a Workspace that no longer exists can
   * only be detected through the registry — there is no deletion event. A
   * dead non-default participation is withdrawn here (its Claims and
   * Attention release through the normal leave path); a dead default
   * Workspace is left alone — activation fails on its missing cwd and the
   * Member surfaces as unavailable for Human attention.
   */
  private async sweepWorkspaceParticipations(ledger: AgentTeamLedger): Promise<void> {
    for (const member of ledger.listMembers()) {
      if (member.state === 'inactive' || member.state === 'archived') continue
      for (const workspaceId of ledger.workspacesOf(member.memberId)) {
        if (workspaceId === member.workspaceId || this.ctx.workspaceRegistry.get(workspaceId) !== undefined) continue
        this.ctx.logger.warn(`agent-team: workspace '${workspaceId}' is gone; withdrawing member '${member.handle}' from it`)
        try {
          await ledger.leaveWorkspace({ requestId: randomUUID() as AgentTeamRequestId, workspaceId, memberId: member.memberId, actor: agentTeamHumanActor() })
        } catch (error) {
          this.ctx.logger.warn(`agent-team: failed to withdraw member '${member.handle}' from deleted workspace '${workspaceId}': ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  /**
   * Whether one Member Session has durable persisted content, decided through
   * {@link SessionPersistence.stat} rather than a bare metadata listing: the
   * backend reports a still-draining session through its pending header, so a
   * resume racing a suspend's fire-and-forget final flush cannot mistake a
   * still-draining persisted Session for an unpersisted one and fork a fresh
   * generation over it.
   */
  private async sessionPersisted(sessionId: SessionId): Promise<boolean> {
    return this.sessionReader.exists(sessionId)
  }

  /** Resolve one exact live Agent to its durable Team Member; forks do not inherit identity. */
  memberForAgent(agent: Agent): AgentTeamAgentMember | undefined {
    for (const [memberId, handle] of this.handles) {
      if (handle.agent === agent) return this.requireLedger().getMember(memberId)
    }
    return undefined
  }

  /** Return every durable Member with current process availability. */
  members(): readonly AgentTeamAgentMemberStatus[] {
    return this.requireLedger().listMembers().map(member => this.memberStatus(member))
  }

  /** Read-only navigation lookup for branded Task refs found in message bodies. */
  @Remote('resolveTaskRefs')
  resolveTaskRefs(request: AgentTeamResolveTaskRefsRequest): AgentTeamResolveTaskRefsResult {
    this.requireWorkspace(request.workspaceId)
    const seen = new Set<AgentTeamTaskRef>()
    const taskRefs = request.taskRefs.filter(taskRef => {
      if (seen.has(taskRef)) return false
      seen.add(taskRef)
      return true
    })
    return Object.freeze({ resolved: Object.freeze(this.requireLedger().resolveTaskRefs(request.workspaceId, taskRefs)) })
  }

  /** Read-only navigation lookup for branded Thread refs found in message bodies. */
  @Remote('resolveThreadRefs')
  resolveThreadRefs(request: AgentTeamResolveThreadRefsRequest): AgentTeamResolveThreadRefsResult {
    this.requireWorkspace(request.workspaceId)
    const seen = new Set<AgentTeamThreadRef>()
    const threadRefs = request.threadRefs.filter(threadRef => {
      if (seen.has(threadRef)) return false
      seen.add(threadRef)
      return true
    })
    return Object.freeze({ resolved: Object.freeze(this.requireLedger().resolveThreadRefs(request.workspaceId, threadRefs)) })
  }

  /** Read-only lookup resolving each reply's parent into its author and excerpt. */
  @Remote('resolveMessageRefs')
  resolveMessageRefs(request: AgentTeamResolveMessageRefsRequest): AgentTeamResolveMessageRefsResult {
    this.requireWorkspace(request.workspaceId)
    const seen = new Set<AgentTeamMessageRef>()
    const messageRefs = request.messageRefs.filter(messageRef => {
      if (seen.has(messageRef)) return false
      seen.add(messageRef)
      return true
    })
    return Object.freeze({ resolved: Object.freeze(this.requireLedger().resolveMessageRefs(request.workspaceId, messageRefs)) })
  }

  /** Browser-safe Human roster, optionally filtered to one participation. */
  @Remote('members')
  membersForClient(request: AgentTeamMembersRequest): readonly AgentTeamClientMemberStatus[] {
    if (request.workspaceId !== undefined) this.requireWorkspace(request.workspaceId)
    const ledger = this.requireLedger()
    return this.members()
      .filter(status => request.workspaceId === undefined || ledger.participatesIn(status.member.memberId, request.workspaceId))
      .map(({ member: { privateMemoryPath: _privateMemoryPath, ...member }, ...status }) => Object.freeze({ ...status, member: Object.freeze(member), workspaceIds: ledger.workspacesOf(member.memberId) }))
  }

  /** Emit a current baseline, then coalesced invalidations until canceled. */
  @Remote({ mode: 'stream' })
  async * changes(request: AgentTeamChangesRequest, signal?: AbortSignal): AsyncIterable<AgentTeamChangesResult> {
    const scope = this.validateChangeScope(request.scope)
    let pending: number | undefined
    let resume: (() => void) | undefined
    const waiter: ChangeWaiter = {
      scope,
      wake: version => {
        pending = version
        resume?.()
      },
    }
    const onAbort = (): void => { resume?.() }
    if (signal?.aborted || !this.accepting) return
    this.changeWaiters.add(waiter)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      // Listen before yielding so a commit during the consumer's read is kept.
      yield { version: this.changeVersionOf(scope) }
      while (!signal?.aborted && this.accepting) {
        if (pending === undefined) await new Promise<void>(resolve => { resume = resolve })
        resume = undefined
        if (signal?.aborted || !this.accepting) return
        if (pending !== undefined) {
          const version = pending
          pending = undefined
          yield { version }
        }
      }
    } finally {
      this.changeWaiters.delete(waiter)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Return durable Team status without issuing a model request or a storage write. */
  status(): AgentTeamStatus {
    return this.requireLedger().status()
  }

  @Remote('createChannel')
  async createChannel(request: AgentTeamCreateChannelRequest): Promise<AgentTeamCreateChannelResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const ledger = this.requireLedger()
    if (!ledger.hasCommitted(request.requestId)) this.assertChannelMembersAvailable(request.memberIds)
    const result = await ledger.createChannel({ ...request, actor: agentTeamHumanActor() })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Human rename of one Channel's display facts; identity refs are immutable. */
  @Remote('updateChannel')
  async updateChannel(request: AgentTeamUpdateChannelRequest): Promise<AgentTeamUpdateChannelResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const result = await this.requireLedger().updateChannel({ ...request, actor: agentTeamHumanActor() })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /**
   * Archive one Channel: hidden from every surface with all facts kept. Pure
   * ledger projection change — Member sessions stay live (they may work in
   * other Channels), every active Claim on the Channel's Threads releases,
   * and affected Members' Attention clears.
   */
  @Remote('archiveChannel')
  async archiveChannel(request: AgentTeamArchiveChannelRequest): Promise<AgentTeamArchiveChannelResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const result = await this.requireLedger().archiveChannel({ ...request, actor: agentTeamHumanActor() })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Create a durable Member and atomically grant its declared initial Channels. */
  @Remote('addMember')
  async addMember(request: AgentTeamAddMemberRequest): Promise<AgentTeamAddMemberResult> {
    return this.enqueueAddition(request.requestId, async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      await this.assertModelRoute(request.model)
      const memberId = `member:${randomUUID()}` as AgentTeamMemberId
      const member: AgentTeamAgentMember = Object.freeze({
        memberId,
        sessionId: SessionId(`agent-team-${randomUUID()}`),
        workspaceId: request.workspaceId,
        handle: request.handle,
        description: request.description,
        presetId: request.presetId,
        ...(request.model === undefined ? {} : { model: Object.freeze({ ...request.model }) }),
        ...(request.capabilities === undefined ? {} : { capabilities: Object.freeze(deepCopyCapabilities(request.capabilities)) }),
        privateMemoryPath: dshHomePath('agent-team', 'members', memberMemoryDirectoryName(memberId)),
        state: 'enabled',
      })
      const ledger = this.requireLedger()
      const result = await ledger.addMember({ ...request, actor: agentTeamHumanActor(), member })
      if (result.committed) this.emitCommitted(result.value.receipt)
      const stored = result.value.member
      if (!this.handles.has(stored.memberId)) await this.activateMember(stored, workspace.path)
      // Creation seeds exactly the creation Workspace participation; attach it
      // here (like membersForClient) so the Client never synthesizes it.
      return Object.freeze({ receipt: result.value.receipt, status: this.memberStatus(stored), workspaceIds: ledger.workspacesOf(stored.memberId) })
    })
  }

  /** Commit suspended intent, then run the suspended row of the effect table: the owned AgentHandle is disposed, the Session stays. */
  async suspendMember(request: AgentTeamSetMemberStateRequest): Promise<AgentTeamMemberResult> {
    return this.enqueueLifecycle(request.memberId, async () => {
      const result = await this.requireLedger().suspendMember({ ...request, actor: agentTeamHumanActor() })
      if (result.committed) this.emitCommitted(result.value.receipt)
      await this.convergeMemberEffects(result.value.member)
      return Object.freeze({ receipt: result.value.receipt, status: this.memberStatus(result.value.member) })
    })
  }

  /** Commit enabled intent and restore the exact persisted Session. */
  async resumeMember(request: AgentTeamSetMemberStateRequest): Promise<AgentTeamMemberResult> {
    return this.enqueueLifecycle(request.memberId, async () => {
      const result = await this.requireLedger().resumeMember({ ...request, actor: agentTeamHumanActor() })
      if (result.committed) this.emitCommitted(result.value.receipt)
      this.dropInboxCoverage(result.value.member.memberId)
      // The suspended Session's log is durable once its retirement completes,
      // and agents.resume() waits for exactly that retirement before loading.
      // Consulting the persistence tree here instead would race the
      // fire-and-forget retirement on Windows, where the JSONL backend
      // publishes directories through transient staging entries that surface
      // as ENOENT mid-walk — so pass the known session rather than re-listing.
      await this.activateMember(result.value.member, undefined, new Set([result.value.member.sessionId]))
      return Object.freeze({ receipt: result.value.receipt, status: this.memberStatus(result.value.member) })
    })
  }

  /**
   * Operator nudge for a Member that stopped making progress: steer a
   * continuation prompt into its live session, rebuild it after an orphaned
   * preset composition, or re-run activation when no live session exists.
   * Runtime-only — no ledger operation, no suspend. Taking over manually also
   * cancels any pending automatic recovery episode. A non-enabled Member
   * still holding a live handle is an interrupted suspend/archive/remove,
   * not a stalled one; recovery finishes that cleanup instead of nudging it.
   */
  @Remote('recoverMember')
  async recoverMember(request: AgentTeamRecoverMemberRequest): Promise<AgentTeamRecoverMemberResult> {
    this.requireAccepting()
    const member = this.requireLedger().getMember(request.memberId)
    if (member === undefined || !this.requireLedger().participatesIn(request.memberId, request.workspaceId)) throw new Error(`unknown Member '${request.memberId}' in workspace '${request.workspaceId}'`)
    this.recovery.stopTracking(request.memberId, 'manual')
    const handle = this.handles.get(request.memberId)
    // A committed renewal or rollover whose retire or activation never finished
    // is what leaves a Member with no live generation on its binding, or with
    // the retired generation still live: this explicit recovery path finishes
    // that recorded transition rather than restarting a Session the ledger has
    // already moved off. Every other stranded case keeps its old behavior.
    const stranded = handle === undefined || handle.agent.id !== member.sessionId
    const recordedTransition = this.requireLedger().lastTransitionForMember(request.memberId)
    if (stranded && member.state === 'enabled' && recordedTransition !== undefined) {
      this.ctx.logger.info(`agent-team: finishing the recorded Session transition for ${this.memberScope(request.memberId, recordedTransition.targetSessionId)} previousSession '${recordedTransition.previousSessionId}'`)
      const settled = await this.enqueueLifecycle(request.memberId, async () => {
        await this.finishMemberTransition(request.memberId)
        return this.requireLedger().getMember(request.memberId) ?? member
      })
      return Object.freeze({ status: this.memberStatus(settled) })
    }
    // A live handle on a non-enabled Member is the residue of a suspend,
    // archive, or removal whose disposal failed after its commit: the
    // durable state already says no live generation, so explicit recovery
    // re-runs that state's effects rather than feeding the stray generation
    // a resume prompt or rebuilding it as if it were enabled.
    if (member.state !== 'enabled' && handle !== undefined) {
      this.ctx.logger.info(`agent-team: finishing the interrupted ${member.state} cleanup for ${this.memberScope(request.memberId)}`)
      const settled = await this.enqueueLifecycle(request.memberId, async () => {
        await this.convergeMemberEffects(member)
        return this.requireLedger().getMember(request.memberId) ?? member
      })
      return Object.freeze({ status: this.memberStatus(settled) })
    }
    // An orphaned composition cannot be steered: its tools are gone, so a
    // continuation prompt reaches an inert Member. Rebuild the Agent in place.
    if (handle !== undefined && this.ctx.agentPresets.composedPreset(handle.agent.ctx) === undefined) {
      this.ctx.logger.info(`agent-team: rebuilding ${this.memberScope(request.memberId)} after its preset composition was orphaned by a reload`)
      await this.reactivateMember(request.memberId)
      return Object.freeze({ status: this.memberStatus(member) })
    }
    // A failed activation also leaves nothing to steer; re-running it is the
    // only way back. A renewed failure stays non-throwing: the refreshed
    // status carries the activation diagnostic for the sidebar.
    if (handle === undefined) {
      if (member.state !== 'enabled') throw new Error(`Agent Member '${member.handle}' is ${member.state}; only enabled Members can be restarted`)
      this.ctx.logger.info(`agent-team: restarting ${this.memberScope(request.memberId)} after a failed activation`)
      // There is no write-side repair pass anymore: dsh 0.1.7 converts the
      // released V3 history at read time, and this bundle no longer authors
      // the old wrapper shape, so a refusal stays a deterministic failure the
      // retry reports again rather than something the restart heals.
      await this.reactivateMember(request.memberId)
      return Object.freeze({ status: this.memberStatus(member) })
    }
    this.steerResume(member, this.manualResumeText(), 'operator recovery')
    return Object.freeze({ status: this.memberStatus(member) })
  }

  /**
   * Start one enabled Member from a new context: dispose the live handle,
   * archive the previous Session (its log stays on disk for history), and
   * activate a fresh Session under a new sessionId, so preset, tools, private
   * memory, and model selection all reload while the next turn carries no
   * history. The durable operation moves the Member's sessionId; identity,
   * memory path, and binding survive. A new id is what keeps the Web Client
   * seat live: a disposed generation's resident instance keeps its `removed`
   * bit forever, so renewing under the same id would leave a permanently
   * grayed session view.
   */
  @Remote('clearMemberContext')
  async clearMemberContext(request: AgentTeamClearMemberContextRequest): Promise<AgentTeamClearMemberContextResult> {
    return this.enqueueLifecycle(request.memberId, async () => {
      this.requireAccepting()
      this.requireWorkspace(request.workspaceId)
      const stored = this.requireLedger().getMember(request.memberId)
      if (stored === undefined || !this.requireLedger().participatesIn(request.memberId, request.workspaceId)) throw new Error(`unknown Member '${request.memberId}' in workspace '${request.workspaceId}'`)
      if (stored.state !== 'enabled') throw new Error(`Agent Member '${stored.handle}' is ${stored.state}; only enabled Members can start from a new context`)
      // Derived from the requestId, not fresh, so an exact retry restates this
      // same id and the ledger resolves it instead of colliding. It is a
      // uuid-shaped digest rather than the caller's text: nothing a caller
      // wrote reaches a Session directory name, the Client's Session list, or a
      // log path, and no escaping is involved.
      const sessionId = SessionId(`agent-team-${stableRequestUuid('member-session-renewal', request.requestId)}`)

      // A renewal this request already committed IS the desired binding: its
      // retire or activation effects may still be outstanding, so finish them
      // first, then answer with the recorded result either way. A repeat never
      // commits a second binding, and never reports an effect that did not run
      // as though it had — the status below carries that truth.
      if (this.requireLedger().hasCommitted(request.requestId)) {
        try {
          await this.finishMemberTransition(request.memberId)
        } catch (error) {
          this.ctx.logger.warn(`agent-team: could not finish the recorded context renewal for member '${stored.handle}': ${error instanceof Error ? error.message : String(error)}`)
        }
        const recorded = await this.requireLedger().renewMemberSession({ ...request, sessionId, actor: agentTeamHumanActor() })
        const current = this.requireLedger().getMember(request.memberId) ?? stored
        return Object.freeze({ receipt: recorded.value.receipt, status: this.memberStatus(current) })
      }

      const active = this.handles.get(request.memberId)
      if (active === undefined) {
        // With no live generation to retire, an earlier transition may be what
        // left the Member here; finishing it is what lets this request run at
        // all. With none, the ordinary no-session refusal below stands.
        await this.finishMemberTransition(request.memberId)
      }
      const retiring = this.handles.get(request.memberId)
      if (retiring === undefined) throw new Error(`Agent Member '${stored.handle}' has no active session to clear`)
      if (this.runningAgents.has(retiring.agent.id)) throw new Error(`Agent Member '${stored.handle}' is still running; wait for the current turn to end before starting from a new context`)
      const result = await this.requireLedger().renewMemberSession({ ...request, sessionId, actor: agentTeamHumanActor() })
      if (!result.committed) {
        // Another caller recorded this requestId between the check above and
        // the write; report its recorded outcome as the retry path does.
        const current = this.requireLedger().getMember(request.memberId) ?? stored
        return Object.freeze({ receipt: result.value.receipt, status: this.memberStatus(current) })
      }
      this.emitCommitted(result.value.receipt)
      const renewed = result.value.member
      // This request retired the previous generation itself, so the activation
      // is planned rather than recovered: pass the fork parent it just left.
      await this.finishMemberTransition(renewed.memberId, { forkedFrom: stored.sessionId })
      const reactivated = this.handles.get(request.memberId)
      if (reactivated === undefined) {
        // Reactivation failed; the activation diagnostic carries the reason and
        // the durable renewal stays honest about the attempt.
        throw new Error(`Agent Member '${stored.handle}' failed to start a new context: ${this.memberFailures.get(request.memberId)?.activation ?? 'unknown error'}`)
      }
      return Object.freeze({ receipt: result.value.receipt, status: this.memberStatus(renewed) })
    })
  }

  /**
   * Finish one Member's committed Session transition, whichever half a failure
   * interrupted. The ledger already records the binding the Member should run
   * and the Session it left, so only external effects remain and each is
   * derived fresh: a generation still live on the old Session is retired, the
   * retired Session is archived once the registry does not yet report it
   * archived, and the target activates when no live generation runs it.
   *
   * A live handle alone never decides completion — disposal can succeed and
   * leave the archive half owed — so the registry's own archive set is the
   * evidence for that step.
   *
   * `forkedFrom` marks a PLANNED in-process activation (the caller just
   * retired that Session in this same request): `activateMember` reads its
   * absence as a recovered Session that may never have materialized and runs
   * the carried-input replay. Startup, retry, and explicit recovery therefore
   * leave it unset; only the request that committed the transition supplies
   * it.
   *
   * Callers must already hold the lifecycle queue (or run before any other
   * lifecycle work): this method does not re-enter it.
   */
  private async finishMemberTransition(memberId: AgentTeamMemberId, options?: {
    readonly knownSessions?: ReadonlySet<SessionId>
    readonly forkedFrom?: SessionId
  }): Promise<void> {
    const member = this.requireLedger().getMember(memberId)
    if (member === undefined || member.state !== 'enabled') return
    const transition = this.requireLedger().lastTransitionForMember(memberId)
    if (transition === undefined) return
    const live = this.handles.get(memberId)
    if (live !== undefined && live.agent.id !== member.sessionId) {
      await this.retireMemberGeneration(memberId, live, live.agent.id)
    }
    await this.archiveRetiredSession(transition.previousSessionId)
    if (this.handles.get(memberId) === undefined) {
      await this.activateMember(member, undefined, options?.knownSessions, options?.forkedFrom)
    }
  }

  /**
   * Converge one Member's external effects onto its durable lifecycle state
   * — the single effect table every lifecycle operation runs right after its
   * commit and startup re-runs for every non-enabled Member:
   *
   * - `suspended`: no live handle; the Session and private memory stay.
   * - `archived`: no live handle; the Session is hidden from grouping
   *   surfaces while its log and private memory stay on disk.
   * - `inactive`: no live handle; the Session is archived and the private
   *   memory deleted — removeMember's cleanup primitives.
   *
   * `enabled` has no entry here: its effects belong to the recorded Session
   * transition and activation. Every step is derived from the durable state
   * and safe to repeat — the registry's archive set decides whether the
   * hide half is owed, disposal tolerates an absent handle, and removal
   * cleanup force-tolerates an already-cleaned target — so a repeat after a
   * crash or a failed call runs exactly the owed steps and never a second
   * durable write. Callers must already hold the lifecycle queue (or run
   * before any other lifecycle work, as startup does).
   */
  private async convergeMemberEffects(member: AgentTeamAgentMember): Promise<void> {
    if (member.state === 'enabled') return
    await this.disposeMemberSession(member.memberId, member)
    if (member.state === 'archived') {
      if (!this.ctx.workspaceRegistry.archivedSessionIds.includes(member.sessionId)) {
        await this.ctx.workspaceRegistry.archiveSession(member.sessionId)
      }
    } else if (member.state === 'inactive') {
      await this.memberRuntime.cleanupRemovedMember(member)
    }
  }

  /**
   * Retire one Member's previous generation after its durable binding moved
   * onto a new Session id: drop the old handle's transient state, dispose the
   * Agent, and archive the old Session log.
   */
  private async retireMemberGeneration(memberId: AgentTeamMemberId, active: AgentHandle, previousSessionId: SessionId): Promise<void> {
    this.recovery.stopTracking(memberId, 'session-disposed')
    this.memberBySessionId.delete(previousSessionId)
    await this.waitLogged('wait-external', { label: this.memberLabel(memberId), sessionId: previousSessionId },
      'for the retired Agent to release its Session write path',
      () => this.disposeWithWakeGuard(active))
    this.handles.delete(memberId)
    this.modelSelections.delete(memberId)
    this.memberRuntime.forgetMember(memberId)
    this.clearMemberFailure(memberId, 'activation')
    this.dropInboxCoverage(memberId)
    // The previous log survives on disk; archiving hides it from every
    // grouping surface so one Member keeps exactly one visible Session.
    await this.waitLogged('wait-external', { label: this.memberLabel(memberId), sessionId: previousSessionId },
      'for the Workspace registry to archive the retired Session',
      () => this.ctx.workspaceRegistry.archiveSession(previousSessionId))
  }

  private async retireReplacedGeneration(memberId: AgentTeamMemberId, active: AgentHandle | undefined, plan: TeamTransitionPlan): Promise<readonly UserMessage[]> {
    if (active === undefined) {
      await this.archiveRetiredSession(plan.previousSessionId)
      return []
    }
    await this.retireMemberGeneration(memberId, active, plan.previousSessionId)
    const finalEvents = active.agent.session.ownEvents()
    const finalState = foldTeamContextProjection(
      finalEvents,
      { sessionId: active.agent.session.id, inheritedEventCount: active.agent.session.inheritedEventCount },
      this.contextProjectionHost,
    )
    const carriedById = new Map(plan.carriedInput.map(message => [message.id, message]))
    for (const message of carriedInputOf(finalState, finalEvents)) carriedById.set(message.id, message)
    return [...carriedById.values()]
  }

  private async archiveRetiredSession(sessionId: SessionId): Promise<void> {
    if (!this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) await this.ctx.workspaceRegistry.archiveSession(sessionId)
  }

  /**
   * Execute one prepared generation swap at a true idle boundary: commit the
   * idempotent Host-actor operation, retire the previous generation, and
   * activate the fresh Session. Input the retired generation never answered is
   * delivered after activation; the Team Inbox is rederived, never copied.
   *
   * The successor starts from its own durable context alone — there is no
   * handoff envelope, because a successor that is told it received one performs
   * the handoff instead of reading its memory.
   */
  private async executeMemberTransition(memberId: AgentTeamMemberId, plan: TeamTransitionPlan): Promise<void> {
    await this.enqueueLifecycle(memberId, async () => {
      this.requireAccepting()
      const stored = this.requireLedger().getMember(memberId)
      if (stored === undefined || stored.state !== 'enabled') throw new Error(`Agent Member '${memberId}' cannot recycle: not enabled`)
      if (stored.sessionId !== plan.previousSessionId) throw new Error(`Agent Member '${stored.handle}' is no longer bound to the recycled Session`)
      const active = this.handles.get(memberId)
      if (active !== undefined) {
        // A generation the swap reached while its last turn is still converging
        // waits rather than failing; Host shutdown releases the wait, and the
        // recheck below still refuses to commit against a turn that never idled.
        if (this.runningAgents.has(active.agent.id)) {
          await this.waitLogged('wait-turn', { label: stored.handle, sessionId: stored.sessionId },
            'for the turn to converge before the Session transition',
            () => Promise.race([active.agent.whenIdle(), this.shutdown.promise]))
        }
        if (this.runningAgents.has(active.agent.id)) throw new Error(`Agent Member '${stored.handle}' is still running; the recycle must wait for idle`)
        // Disposal cancels the Agent's jobs, so a case that would silently
        // discard unfinished or unreported output keeps the old generation.
        const blockingJobs = this.ownedJobsBlockingRecycle(active.agent)
        if (blockingJobs.length > 0) {
          throw new Error(`the context recycle is refused: this Member now owns jobs that would not survive the switch (${blockingJobs.join(', ')})`)
        }
      }
      const recycled = await this.requireLedger().recycleMemberSession({
        requestId: plan.requestId,
        workspaceId: stored.workspaceId,
        memberId,
        previousSessionId: plan.previousSessionId,
        newSessionId: plan.newSessionId,
        actor: agentTeamHostActor(),
      })
      this.emitCommitted(recycled.value.receipt)
      const carriedInput = await this.retireReplacedGeneration(memberId, active, plan)
      // Linear succession: the new Session's lineage parent is the one it
      // replaces. Activation defers the Inbox wake so carried input and the
      // rederived notice keep their order behind it.
      await this.activateMember(recycled.value.member, undefined, undefined, plan.previousSessionId, { deferNotify: true })
      const reactivated = this.handles.get(memberId)
      if (reactivated === undefined) {
        throw new Error(`Agent Member '${stored.handle}' failed to activate its next context: ${this.memberFailures.get(memberId)?.activation ?? 'unknown error'}`)
      }
      for (const message of carriedInput) reactivated.agent.followup(message)
      const notifications = this.requireLedger().notificationFacts(recycled.value.member.memberId)
      if (notifications.length > 0) {
        this.notifyMember(reactivated.agent, {
          kind: 'transition',
          requestId: plan.requestId,
          previousSessionId: plan.previousSessionId,
        }, carriedInput.length > 0)
      }
    })
  }

  /** Ledger handle for log lines; falls back to the raw id when unknown. */
  private memberLabel(memberId: AgentTeamMemberId): string {
    return this.ledger?.getMember(memberId)?.handle ?? memberId
  }

  /**
   * Run one lifecycle wait and log its class, subject, and duration. Waits are
   * the only lifecycle step whose latency is not the commit's own: with these
   * lines an operator can tell a Member parked on its own turn (`wait-turn`)
   * from one parked on an external service (`wait-external`), while a real
   * failure keeps its own warn line with the same member/session correlation.
   */
  private async waitLogged<T>(
    stage: 'wait-turn' | 'wait-external',
    subject: { readonly label: string; readonly sessionId: SessionId },
    detail: string,
    wait: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now()
    try {
      return await wait()
    } finally {
      this.ctx.logger.info(`agent-team: member '${subject.label}' session '${subject.sessionId}' stage '${stage}' waited ${Date.now() - started}ms ${detail}`)
    }
  }

  /**
   * Cache GC: uploads referenced by a Message survive 72h from upload so
   * Member agents keep a consumption window; orphans (never sent) go after
   * 24h. Runs once at startup and then daily — in-process only, because the
   * cache is transient by design and rebuilds nothing across restarts.
   */
  private startAttachmentGc(ledger: AgentTeamLedger): void {
    const sweep = async (): Promise<void> => {
      await sweepAttachmentCache(attachmentsRoot(), ledger.referencedAttachmentIds(), Date.now())
    }
    void sweep()
    this.attachmentGcTimer = setInterval(() => { void sweep() }, 24 * 60 * 60 * 1000)
    this.attachmentGcTimer.unref?.()
  }

  private automaticResumeText(): string {
    return 'Your previous turn ended early due to a temporary service error. Please continue the work you were doing before the error.'
  }

  private manualResumeText(): string {
    return 'The operator asked you to resume after the previous turn ended early. Please continue the work you were doing before the error.'
  }

  /**
   * Steer one continuation message into a Member's live session and report the
   * delivery with the same correlation group as every other Member-scoped
   * line. Throws when no handle exists so the coordinator stops tracking;
   * appends the inbox snapshot whenever there is anything new to read, and says
   * so — a steered continuation is queued for the Member's next step, which is
   * not the same claim as the model having read it.
   */
  private steerResume(member: AgentTeamAgentMember, text: string, trigger: 'automatic recovery' | 'operator recovery'): void {
    const handle = this.handles.get(member.memberId)
    if (handle === undefined) throw new Error(`member '${member.handle}' has no active session`)
    const notifications = this.requireLedger().notificationFacts(member.memberId)
    const body = notifications.length === 0 ? text : `${text}\n\n${this.notificationText(notifications, member.memberId)}`
    const hint = createUserMessage({
      content: [{ type: 'text', text: body }],
      source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: TEAM_RECOVERY_NOTICE_SUMMARY },
    })
    for (const pending of [...handle.agent.inbox.nextStep, ...handle.agent.inbox.nextTurn]) {
      if (this.isInboxNotice(pending)) this.removeExpectedTeamWake(handle.agent, pending)
    }
    this.trackTeamWake(handle.agent, hint)
    handle.agent.steer(hint)
    this.ctx.logger.info(`agent-team: ${trigger} continuation steered for ${this.memberScope(member.memberId, handle.agent.session.id)}${notifications.length === 0 ? '' : ` carrying ${this.notificationIdentity(notifications)}`}: it is queued for the Member's next step, not yet read by the model`)
  }

  /** Automatic-recovery wakeup; throwing tells the coordinator the target is gone. */
  private injectRecovery(memberId: AgentTeamMemberId): void {
    const handle = this.handles.get(memberId)
    const agent = handle?.agent
    const member = agent !== undefined ? this.memberForAgent(agent) : undefined
    if (agent === undefined || member === undefined || member.state !== 'enabled') throw new Error(`member '${memberId}' cannot be recovered automatically`)
    this.steerResume(member, this.automaticResumeText(), 'automatic recovery')
  }

  /**
   * Human edit of one Member's mutable facts. A live model selection is
   * updated in place: disposing an Agent emits session/disposed, which makes
   * the Web Client permanently mark the same Session id unavailable even when
   * Team immediately recreates it.
   */
  @Remote('updateMember')
  async updateMember(request: AgentTeamUpdateMemberRequest): Promise<AgentTeamUpdateMemberResult> {
    return this.enqueueLifecycle(request.memberId, async () => {
      await this.assertModelRoute(request.model)
      const previous = this.requireLedger().getMember(request.memberId)
      const result = await this.requireLedger().updateMember({ ...request, actor: agentTeamHumanActor() })
      if (result.committed) this.emitCommitted(result.value.receipt)
      // A replayed request resolves to the member AS IT WAS at its own commit;
      // driving the runtime or the reported status from that history would let
      // a late retry roll back a configuration accepted in the meantime. Apply
      // and report the currently accepted member instead — lifecycle calls
      // serialize, so for a fresh commit it is the row just written.
      const current = this.requireLedger().getMember(request.memberId)
      if (current === undefined) throw new Error(`Agent Member '${request.memberId}' no longer exists`)
      const active = this.handles.get(request.memberId)
      let effect: AgentTeamMemberEffect = 'deferred:no-live-handle'
      if (active !== undefined) {
        effect = 'already-applied'
        if (!isDeepStrictEqual(previous?.model ?? undefined, current.model ?? undefined)) {
          const selection = this.modelSelections.get(request.memberId)
          if (selection === undefined) throw new Error(`Agent Member '${current.handle}' has no live model selection`)
          selection.current = current.model ?? this.ctx.agentDefaultModel.currentSelection()
          effect = 'applied'
        }
        if (!this.memberRuntime.appliedCapabilitiesMatch(current.memberId, current.capabilities)) {
          try {
            effect = await this.applyCapabilityEdit(active, current)
          } catch (error) {
            // The rejection stays loud for the caller; the same failure is
            // kept as a routable, member-visible diagnostic (ids in detail)
            // and logged with the same correlation group before it escapes.
            const message = error instanceof Error ? error.message : String(error)
            this.setCapabilityApplyDiagnostic(current.memberId, Object.freeze({
              class: 'capability-apply' as const,
              sessionId: active.agent.session.id,
              detail: `requestId=${request.requestId} operationId=${result.value.receipt.operationId} stage=apply error=${message}`,
            }))
            this.ctx.logger.warn(`agent-team: capability apply failed for member '${this.memberLabel(current.memberId)}' session '${active.agent.session.id}' requestId '${request.requestId}' operationId '${result.value.receipt.operationId}' stage 'apply': ${message}`)
            throw error
          }
        }
        // The failure slot exists to bridge the gap until the stored intent is
        // actually in force; an already-applied row retires a stale one too.
        if (this.memberRuntime.appliedCapabilitiesMatch(current.memberId, current.capabilities)) {
          this.clearMemberFailure(current.memberId, 'capabilityApply')
        }
      }
      return Object.freeze({ receipt: result.value.receipt, status: this.memberStatus(current), effect })
    })
  }

  /**
   * Live-apply a capability edit at a turn boundary: while the Agent runs, the
   * current turn keeps its schemas and catalog; the swap happens once idle,
   * so the next step recomputes schemas from the new restriction and the
   * durable replacement skill catalog from the new selection, with the same
   * Session and history surviving. Suspend/remove during the wait cancels
   * the swap — the disposed handle released the old restriction already and
   * no disposer leaks.
   */
  private async applyCapabilityEdit(active: AgentHandle, stored: AgentTeamAgentMember): Promise<'applied' | 'deferred:generation-changed'> {
    const memberId = stored.memberId
    const started = Date.now()
    const boundary = await this.memberRuntime.awaitTurnBoundary(active)
    if (boundary === 'waited') {
      // Only real waits are logged: an edit applied to an already-idle Member
      // spends no time here and would only add noise.
      this.ctx.logger.info(`agent-team: member '${stored.handle}' session '${stored.sessionId}' stage 'wait-turn' waited ${Date.now() - started}ms for its turn boundary before applying the stored configuration`)
    }
    if (this.generationSwappedDuringWait(memberId, active, boundary)) return 'deferred:generation-changed'
    this.memberRuntime.reapplyMemberToolPolicy(stored)
    this.memberRuntime.swapSkillSelection(memberId, stored.capabilities?.skills?.allow)
    this.memberRuntime.recordAppliedCapabilities(memberId, stored.capabilities)
    return 'applied'
  }

  /**
   * Whether this Member's live handle was replaced while `applyCapabilityEdit`
   * waited for the turn boundary — a suspend, removal, or restart that the
   * queued edit must not apply to the generation it originally targeted. An
   * edit that never waited cannot have been overtaken.
   */
  private generationSwappedDuringWait(memberId: AgentTeamMemberId, waitedOn: AgentHandle, boundary: TurnBoundary): boolean {
    return boundary === 'waited' && this.handles.get(memberId) !== waitedOn
  }

  /** Irreversibly remove one Member, archive its Session, and delete its private namespace. */
  async removeMember(request: AgentTeamRemoveMemberRequest): Promise<AgentTeamRemoveMemberResult> {
    return this.enqueueLifecycle(request.memberId, async () => {
      const result = await this.requireLedger().removeMember({ ...request, actor: agentTeamHumanActor() })
      if (result.committed) this.emitCommitted(result.value.receipt)
      await this.convergeMemberEffects(result.value.member)
      return result.value
    })
  }

  /**
   * Archive one Member: commit the archival, stop its live session (disposal
   * only — private memory and the Session log stay on disk for a future
   * restore), and archive the Session from every grouping surface. Like
   * removal, all active Claims release and the Member's Attention clears.
   */
  @Remote('archiveMember')
  async archiveMember(request: AgentTeamArchiveMemberRequest): Promise<AgentTeamArchiveMemberResult> {
    return this.enqueueLifecycle(request.memberId, async () => {
      const result = await this.requireLedger().archiveMember({ ...request, actor: agentTeamHumanActor() })
      if (result.committed) this.emitCommitted(result.value.receipt)
      await this.convergeMemberEffects(result.value.member)
      return result.value
    })
  }

  /** Human-only Task resolution. Business fences are returned as typed outcomes. */
  @Remote('changeTask')
  async changeTask(request: AgentTeamTaskRequest): Promise<AgentTeamTaskResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const result = await this.requireLedger().changeTask({ ...request, actor: agentTeamHumanActor() })
    this.emitCommittedOutcome(result)
    return result.value
  }

  /** Human-only promotion of a taskless Thread into a real Task plus public Message. */
  @Remote('promoteThread')
  async promoteThread(request: AgentTeamPromoteThreadRequest): Promise<AgentTeamPromoteThreadResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const result = await this.requireLedger().promoteThread({ ...request, actor: agentTeamHumanActor() })
    this.emitCommittedOutcome(result)
    return result.value
  }

  /** Human-only Workspace participation grant; a pure relation — no Session moves. */
  @Remote('joinWorkspace')
  async joinWorkspace(request: AgentTeamJoinWorkspaceRequest): Promise<AgentTeamJoinWorkspaceResult> {
    const actor = this.humanCall(request.workspaceId)
    const result = await this.requireLedger().joinWorkspace({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Human-only Workspace participation withdrawal and Workspace-scoped cleanup. */
  @Remote('leaveWorkspace')
  async leaveWorkspace(request: AgentTeamLeaveWorkspaceRequest): Promise<AgentTeamLeaveWorkspaceResult> {
    const actor = this.humanCall(request.workspaceId)
    const result = await this.requireLedger().leaveWorkspace({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Human top-level Thread start; asTask attaches an optional Task overlay. */
  @Remote('sendMessage')
  async sendMessage(request: AgentTeamSendMessageRequest): Promise<AgentTeamSendMessageResult> {
    return this.sendMessageAs(this.humanCall(request.workspaceId), request)
  }

  /**
   * Resolve uploaded ids and agent-supplied absolute paths into one attachment
   * metadata list. Paths are all validated before anything is copied, so one
   * rejection leaves the cache untouched and the message uncommitted. Each copy
   * takes the id its request derives, so a retry converges on the entry the
   * first attempt prepared instead of writing an orphan.
   */
  private async resolveMessageAttachments(request: { readonly requestId: AgentTeamRequestId; readonly attachments?: readonly AgentTeamAttachmentId[] | undefined; readonly attachmentPaths?: readonly string[] | undefined }): Promise<readonly AgentTeamMessageAttachment[]> {
    const fromPaths: AgentTeamMessageAttachment[] = []
    if (request.attachmentPaths !== undefined && request.attachmentPaths.length > 0) {
      for (const absolutePath of request.attachmentPaths) await validatePathAttachment(absolutePath)
      for (const [index, absolutePath] of request.attachmentPaths.entries()) {
        fromPaths.push(Object.freeze(await copyPathAttachment(attachmentsRoot(), absolutePath, pathAttachmentId(request.requestId, index), request.requestId)))
      }
    }
    return [...fromPaths, ...await this.prepareAttachments(request.attachments)]
  }

  /** Verify requested attachment ids against the cache. */
  private async prepareAttachments(requested?: readonly AgentTeamAttachmentId[]): Promise<readonly AgentTeamMessageAttachment[]> {
    if (requested === undefined || requested.length === 0) return []
    const metadata: AgentTeamMessageAttachment[] = []
    for (const attachmentId of requested) {
      const stored = await readAttachment(attachmentsRoot(), attachmentId)
      if (stored === undefined) throw new Error(`attachment '${attachmentId}' is not in the upload cache`)
      metadata.push(Object.freeze({ attachmentId, name: stored.name, byteSize: stored.byteSize, mediaType: stored.mediaType }))
    }
    return metadata
  }

  /**
   * Derive the stored body: one machine-facing `[attachment] <absolute path>`
   * line per attachment appended to the member-facing text.
   */
  private appendAttachmentLines(body: string, metadata: readonly AgentTeamMessageAttachment[]): string {
    const trimmed = body.trim()
    if (metadata.length === 0) return trimmed
    const lines = metadata.map(attachment => `[attachment] ${attachmentPayloadPath(attachment.attachmentId, attachment.name)}`)
    return `${trimmed}\n${lines.join('\n')}`
  }

  /**
   * Upload one composer attachment into the cache; bytes are immutable once
   * written. The requestId is the idempotency key: a retried upload derives
   * the same cache id and replays the original result, while reusing that key
   * for a different payload is refused as a request collision.
   */
  @Remote('putAttachment')
  async putAttachment(request: AgentTeamPutAttachmentRequest): Promise<AgentTeamPutAttachmentResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const bytes = Buffer.from(request.bytesBase64, 'base64')
    if (bytes.byteLength === 0) throw new Error('attachment must not be empty')
    if (bytes.byteLength > ATTACHMENT_MAX_BYTES) throw new Error(`attachment exceeds the ${ATTACHMENT_MAX_BYTES} byte limit`)
    const mediaType = sanitizeMediaType(request.mediaType)
    return Object.freeze(await writeRequestScopedAttachment(attachmentsRoot(), request.requestId, request.name, mediaType, bytes))
  }

  /**
   * Read one cached attachment back for client display. A gone entry is the
   * one expected failure on this path, so it carries the stable
   * `team/attachment-not-found` code the Client branches on; anything else
   * (unreadable metadata, filesystem trouble) stays an unknown Host error.
   */
  @Remote('getAttachment')
  async getAttachment(request: AgentTeamGetAttachmentRequest): Promise<AgentTeamGetAttachmentResult> {
    const stored = await readAttachment(attachmentsRoot(), request.attachmentId)
    if (stored === undefined) throw new RemoteError('team/attachment-not-found', `attachment '${request.attachmentId}' is no longer cached`, { attachmentId: request.attachmentId })
    return Object.freeze({ name: stored.name, mediaType: stored.mediaType, byteSize: stored.byteSize, bytesBase64: stored.bytes.toString('base64') })
  }

  /**
   * Human profile read for the settings page and footnote: name + avatar
   * reference from this Host row's live Config plus version facts. Human-scoped
   * (the Web Client calls it); agent tools never receive avatar bytes, only the
   * name through team_view. The new-release check stays best-effort and cached —
   * `latestVersion` is absent until a background refresh actually observes a
   * newer published release.
   */
  /**
   * Local environment check for the settings page: which DSH line this Host
   * runs against, and whether that line is inside the range this bundle
   * declares. Human-scoped and read-only — the Client renders the verdict and
   * states the range in words, and nothing here is written back.
   *
   * Synchronous like `humanProfile`: both read the installed manifest once and
   * settle immediately, and the verdict comes from the Harness's own
   * compatibility evaluator rather than a second version comparison written
   * here.
   *
   * The wire type and `EnvironmentReport` keep separate top-level field lists on
   * purpose: the contract states every fact as optional because a Transport may
   * withhold any of them, while the report is the stricter thing the checker
   * guarantees. This assignment is where the compiler holds the two together,
   * and a new required contract field fails it here.
   */
  @Remote('environment')
  environmentForClient(_request: AgentTeamEnvironmentRequest): AgentTeamEnvironmentResult {
    return Object.freeze(reportEnvironment())
  }

  @Remote('humanProfile')
  humanProfileForClient(_request: AgentTeamHumanProfileRequest): AgentTeamHumanProfileResult {
    const profile = this.humanProfile()
    const update = this.humanUpdateCheck.snapshot()
    return Object.freeze({
      name: profile.name,
      ...(profile.avatarRef === undefined ? {} : { avatarRef: profile.avatarRef }),
      version: HUMAN_PROFILE_VERSION,
      repoUrl: HUMAN_PROFILE_REPO_URL,
      ...(update.latestVersion === undefined ? {} : { latestVersion: update.latestVersion }),
    })
  }

  /**
   * Upload one human avatar image into the persistent store. Human-only by
   * construction: only the Web Client calls this Remote, never agent tools.
   * The caller stores the returned ref in settings; bytes never enter the
   * TTL-bound attachment cache.
   */
  @Remote('putHumanAvatar')
  async putHumanAvatar(request: AgentTeamPutHumanAvatarRequest): Promise<AgentTeamPutHumanAvatarResult> {
    this.requireAccepting()
    const bytes = Buffer.from(request.bytesBase64, 'base64')
    return Object.freeze(await writeHumanAvatar(humanAvatarsRoot(), request.name, request.mediaType ?? 'application/octet-stream', bytes))
  }

  /** Read one human avatar back; removed entries throw and the UI falls back to hue/initial. */
  @Remote('getHumanAvatar')
  async getHumanAvatar(request: AgentTeamGetHumanAvatarRequest): Promise<AgentTeamGetHumanAvatarResult> {
    const stored = await readHumanAvatar(humanAvatarsRoot(), request.avatarRef)
    if (stored === undefined) throw new Error(`human avatar '${request.avatarRef}' is no longer stored`)
    return Object.freeze({ name: stored.name, mediaType: stored.mediaType, byteSize: stored.byteSize, bytesBase64: stored.bytes.toString('base64') })
  }

  /** Remove one human avatar entry; the UI falls back to hue/initial afterwards. */
  @Remote('removeHumanAvatar')
  async removeHumanAvatar(request: AgentTeamRemoveHumanAvatarRequest): Promise<AgentTeamRemoveHumanAvatarResult> {
    this.requireAccepting()
    await removeHumanAvatar(humanAvatarsRoot(), request.avatarRef)
    return Object.freeze({ removed: true })
  }

  /**
   * Overwrite the Human profile fields the caller supplies. The Host owns this
   * write because the profile is the Host row's own Config: the schema supplies
   * the shape, this method supplies the two judgements the schema cannot make
   * (a non-empty name, a name no live Member already answers to), and the
   * settings service persists the result into the active profile's patch
   * document and applies it to the running plugin live.
   *
   * No expected revision accompanies the write: the profile is two scalar
   * fields written from the Human's own pages, where the last write wins. This
   * is not a hard boundary around a user-editable document — the settings
   * service's own document opener (and a text editor) can change the stored
   * name without passing here, exactly as the retired section validator could
   * not stop it.
   */
  @Remote('setHumanProfile')
  async setHumanProfile(request: AgentTeamSetHumanProfileRequest): Promise<AgentTeamSetHumanProfileResult> {
    this.requireAccepting()
    const settings = this.ctx.get('settings')
    if (settings === undefined) throw new Error('the settings service is unavailable')
    const name = request.name === undefined ? undefined : assertValidHumanName(request.name)
    if (name !== undefined) this.validateHumanProfile({ name })
    const ops: SettingsPathOp[] = []
    if (name !== undefined) ops.push({ op: 'set', path: ['name'], value: name })
    if (request.avatarRef === null) ops.push({ op: 'unset', path: ['avatarRef'] })
    else if (request.avatarRef !== undefined) ops.push({ op: 'set', path: ['avatarRef'], value: request.avatarRef })
    if (ops.length !== 0) {
      // The settings namespace IS this Host row's id in the composition, and it
      // must be addressed by that name rather than by `ctx.fiber.entry` here: a
      // Remote call runs under its caller's context, whose fiber entry is the
      // RPC gateway's row (`typert-gateway`), which the settings service then
      // looks up as an unrelated plugin. shipping.spec.ts pins the constant to
      // the row `cordis.patch.yml` declares.
      await settings.mutate(HUMAN_PROFILE_SETTINGS_NAMESPACE, ops)
    }
    return Object.freeze({ ...this.humanProfile() })
  }

  /** Human existing-Thread reply; unread and revision conflicts are business outcomes. */
  @Remote('reply')
  async reply(request: AgentTeamReplyRequest): Promise<AgentTeamReplyResult> {
    return this.replyAs(this.humanCall(request.workspaceId), request)
  }

  @Remote('readMessage')
  readMessage(request: AgentTeamReadMessageRequest): AgentTeamReadMessageResult {
    return this.readMessageAs(this.humanCall(request.workspaceId), request)
  }

  /** Human's personal Attention operation. */
  @Remote('changeAttention')
  async changeAttention(request: AgentTeamThreadAttentionRequest): Promise<AgentTeamThreadAttentionResult> {
    const actor = this.humanCall(request.workspaceId)
    const result = await this.requireLedger().changeAttention({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Human Inbox projection; the Web Client consumes the direct-only slice as its mention queue. */
  @Remote('inbox')
  inbox(request: AgentTeamInboxRequest): AgentTeamInbox {
    this.requireWorkspace(request.workspaceId)
    return this.requireLedger().inbox(agentTeamHumanActor(), request)
  }

  /** Human's durable, atomically acknowledged Thread read. */
  @Remote('readThread')
  async readThread(request: AgentTeamThreadReadRequest): Promise<AgentTeamThreadReadResult> {
    const actor = this.humanCall(request.workspaceId)
    const result = await this.requireLedger().readThread({ ...request, actor })
    // A read that made no progress commits no operation and carries no receipt.
    const receipt = result.committed ? result.value.receipt : undefined
    if (receipt !== undefined) this.emitCommitted(receipt)
    return result.value
  }

  /** Human-only durable Attention observations for one Thread. */
  @Remote('threadObservations')
  threadObservations(request: AgentTeamThreadObservationsRequest): AgentTeamThreadObservations {
    this.requireWorkspace(request.workspaceId)
    return this.requireLedger().threadObservations(agentTeamHumanActor(), request)
  }

  /** Human's non-mutating bounded Thread history. */
  @Remote('threadHistory')
  threadHistory(request: AgentTeamThreadHistoryRequest): AgentTeamThreadHistory {
    this.requireWorkspace(request.workspaceId)
    return this.requireLedger().threadHistory(agentTeamHumanActor(), request)
  }

  /** Return the existing bounded public Workspace discovery projection. */
  @Remote('view')
  view(request: AgentTeamViewRequest): AgentTeamView {
    this.requireWorkspace(request.workspaceId)
    return this.requireLedger().view(request)
  }

  /** Agent-only top-level Thread start. Workspace identity is verified against the live binding. */
  async sendMessageForAgent(agent: Agent, request: AgentTeamSendMessageRequest): Promise<AgentTeamSendMessageResult> {
    return this.sendMessageAs(this.memberCall(agent, request.workspaceId), request)
  }

  /** Agent-only existing-Thread reply. */
  async replyForAgent(agent: Agent, request: AgentTeamReplyRequest): Promise<AgentTeamReplyResult> {
    return this.replyAs(this.memberCall(agent, request.workspaceId), request)
  }

  /** Read one Message back verbatim, for the reader that has to answer it. */
  readMessageForAgent(agent: Agent, request: AgentTeamReadMessageRequest): AgentTeamReadMessageResult {
    return this.readMessageAs(this.memberCall(agent, request.workspaceId), request)
  }

  /** Agent-only personal Attention change. */
  async changeAttentionForAgent(agent: Agent, request: AgentTeamThreadAttentionRequest): Promise<AgentTeamThreadAttentionResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().changeAttention({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  attentionStatusForAgent(agent: Agent, request: { workspaceId: AgentTeamViewRequest['workspaceId']; threadRef?: AgentTeamThreadAttentionRequest['threadRef'] | undefined; taskRef?: AgentTeamTask['taskRef'] | undefined }): AgentTeamThreadAttentionStatus {
    const actor = this.memberActor(agent)
    this.requireAgentWorkspace(actor, request.workspaceId)
    return this.requireLedger().attentionStatus(actor, request)
  }

  /** Agent-only Claim mutation. */
  async changeClaimForAgent(agent: Agent, request: AgentTeamClaimRequest): Promise<AgentTeamClaimResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().changeClaim({ ...request, actor })
    this.emitCommittedOutcome(result)
    return result.value
  }

  listClaimsForAgent(agent: Agent, request: { workspaceId: AgentTeamViewRequest['workspaceId']; taskRef: AgentTeamTask['taskRef'] }): AgentTeamClaimList {
    const actor = this.memberActor(agent)
    this.requireAgentWorkspace(actor, request.workspaceId)
    return this.requireLedger().listClaims(actor, request)
  }

  inboxForAgent(agent: Agent, request: { readonly workspaceId?: WorkspaceId; readonly limit?: number }): AgentTeamInbox {
    const actor = this.memberActor(agent)
    if (request.workspaceId === undefined) return this.requireLedger().memberInbox(actor, request)
    this.requireAgentWorkspace(actor, request.workspaceId)
    return this.requireLedger().inbox(actor, { ...request, workspaceId: request.workspaceId })
  }

  async readThreadForAgent(agent: Agent, request: AgentTeamThreadReadRequest): Promise<AgentTeamThreadReadResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().readThread({ ...request, actor })
    // A read that made no progress commits no operation and carries no receipt.
    const receipt = result.committed ? result.value.receipt : undefined
    if (receipt !== undefined) this.emitCommitted(receipt)
    return this.withReplyContexts(result.value, request.workspaceId)
  }

  /**
   * Agent-only direct message: append the audit-only dm-sent operation, then
   * inject the body into the recipient's live session. The ledger commit is
   * the durable fact; the injection is a transient runtime effect, so a
   * missing handle or a failed wake returns a structured delivery error while
   * the recorded DM stays durable for the recipient's recovery path.
   */
  async dmForAgent(agent: Agent, request: AgentTeamDmRequest): Promise<AgentTeamDmResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().sendDm({ ...request, actor })
    if (!result.committed) return result.value
    this.emitCommitted(result.value.receipt)
    const recipient = result.value.recipient
    const handle = this.handles.get(recipient.memberId)
    if (handle === undefined) {
      throw new AgentTeamDmDeliveryError(recipient.memberId, recipient.handle, `DM recorded but not delivered: Agent Member '${recipient.handle}' has no live session; it will find the message in its DM history after recovery`)
    }
    const message = createUserMessage({
      content: [{ type: 'text', text: this.dmRelayText(agent, recipient, request.body.trim(), result.value.receipt.occurredAt, result.value.receipt.operationId, request.workspaceId) }],
      source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'relay' },
    })
    // A cold generation is swapped before the relay lands, and a swap in
    // flight holds the relay until the successor exists: delivering into a
    // Session about to be disposed would lose the message the DM recorded.
    // The handle is re-read afterwards because a swap replaces the Agent.
    const gate = await this.wakeGateFor(handle.agent)
    const recipientAgent = this.handles.get(recipient.memberId)?.agent
    if (gate !== undefined || recipientAgent === undefined) {
      throw new AgentTeamDmDeliveryError(recipient.memberId, recipient.handle, `DM recorded but not delivered: ${gate?.message ?? 'the Member has no live session after changing generation'}`)
    }
    try {
      // An idle recipient gets one ordinary turn; a busy one is steered into
      // its current turn — the same wake split subagent continuations use.
      if (recipientAgent.status === 'idle') recipientAgent.followup(message)
      else recipientAgent.steer(message)
    } catch (error) {
      throw new AgentTeamDmDeliveryError(recipient.memberId, recipient.handle, `DM recorded but not delivered: ${error instanceof Error ? error.message : String(error)}`)
    }
    return result.value
  }

  /** Relay body: the DM itself plus one bounded line of adjacent context. */
  private dmRelayText(senderAgent: Agent, recipient: AgentTeamAgentMember, body: string, occurredAt: string, excluding: AgentTeamOperationId, workspaceId: WorkspaceId): string {
    const sender = this.memberForAgent(senderAgent)
    const prior = this.requireLedger().dmHistoryBetween(senderAgent.id, recipient.memberId, excluding)
    const header = `Direct message from @${sender?.handle ?? 'a Team Member'} at ${formatTeamTimestamp(occurredAt)}:`
    const context = prior === undefined ? '' : `\n\n[most recent prior DM between you: ${prior}]`
    return `${header}\nWorkspace: ${workspaceId}\n\n${body}${context}`
  }

  threadHistoryForAgent(agent: Agent, request: AgentTeamThreadHistoryRequest): AgentTeamThreadHistory {
    const actor = this.memberActor(agent)
    this.requireAgentWorkspace(actor, request.workspaceId)
    const history = this.requireLedger().threadHistory(actor, request)
    // Paging back to answer something is exactly when the target may sit
    // outside the window, so a history page carries the same context a read does.
    const contexts = this.replyContextsFor(history.facts, request.workspaceId)
    if (contexts.size === 0) return history
    const anchorRef = history.anchor.replyToMessageRef
    const anchorReplyTo = anchorRef === undefined ? undefined : contexts.get(anchorRef)
    return Object.freeze({
      ...history,
      ...(anchorReplyTo === undefined ? {} : { anchor: Object.freeze({ ...history.anchor, replyTo: anchorReplyTo }) }),
      facts: Object.freeze(history.facts.map(fact => this.withReplyTo(fact, contexts))),
    })
  }

  /** Attach every resolved reply target in one read window; one resolution for the window. */
  private withReplyContexts(value: AgentTeamThreadReadResult, workspaceId: WorkspaceId): AgentTeamThreadReadResult {
    const contexts = this.replyContextsFor(value.facts.map(entry => entry.fact), workspaceId)
    if (contexts.size === 0) return value
    // The anchor is read out of the same window and may itself be a reply, so
    // it is decorated from the same resolution rather than left out.
    const anchorRef = value.anchor.replyToMessageRef
    const anchorReplyTo = anchorRef === undefined ? undefined : contexts.get(anchorRef)
    return Object.freeze({
      ...value,
      ...(anchorReplyTo === undefined ? {} : { anchor: Object.freeze({ ...value.anchor, replyTo: anchorReplyTo }) }),
      facts: Object.freeze(value.facts.map(entry => {
        const fact = this.withReplyTo(entry.fact, contexts)
        return fact === entry.fact ? entry : Object.freeze({ ...entry, fact })
      })),
    })
  }

  /** Live participation addresses; paths remain owned by the Harness registry. */
  workspacesForAgent(agent: Agent): readonly { readonly workspaceId: WorkspaceId; readonly path: string | undefined; readonly default: boolean }[] {
    const actor = this.memberActor(agent)
    const member = this.requireLedger().getMember(actor.memberId)!
    return Object.freeze(this.requireLedger().workspacesOf(actor.memberId).map(workspaceId => Object.freeze({
      workspaceId, path: this.ctx.workspaceRegistry.get(workspaceId)?.path, default: workspaceId === member.workspaceId,
    })))
  }

  /** Agent-only bounded discovery projection; participation list carries registry titles when known. */
  viewForAgent(agent: Agent, request: AgentTeamViewRequest): AgentTeamView {
    const member = this.memberForAgent(agent)
    if (member === undefined) throw new Error('Agent is not an active Team Member')
    if (!this.requireLedger().participatesIn(member.memberId, request.workspaceId)) throw new Error('Member cannot view another Workspace')
    const view = this.requireLedger().view(request, member.memberId)
    return Object.freeze({ ...view, workspaces: Object.freeze(view.workspaces.map(participation => {
      const title = this.ctx.workspaceRegistry.get(participation.workspaceId)?.title
      return title === undefined ? participation : Object.freeze({ ...participation, title })
    })) })
  }

  /** Validate the durable ledger against an independently replayed projection. */
  validateLedger(): void {
    this.requireLedger().validate()
  }

  /**
   * Validate the durable ledger for the invariant's mount check. The
   * constructor already re-derived every durable record against its own
   * scratch projection, so this adopts that conclusion once while nothing has
   * committed since; every other call, and every commit-driven validation,
   * replays the whole table again.
   */
  validateLedgerAtMount(): void {
    this.requireLedger().validateAtMount()
  }

  /**
   * Why a carried-input replay did not run. Each reason is a state the Host
   * accepts and continues from, never an error: a blocked replay would turn a
   * problem in a Session the Member no longer runs in into permanent
   * unavailability.
   */
  private skipCarriedInput(memberId: AgentTeamMemberId, previousSessionId: SessionId, reason: 'started-generation' | 'corrupt' | 'refused', detail?: string): 0 {
    const member = this.memberLabel(memberId)
    if (reason === 'started-generation') {
      // Nothing is lost: the carried input was delivered after activation (or
      // superseded) before the generation's first own turn could run.
      this.ctx.logger.info(`agent-team: skipping carried-input replay for member '${member}': the current Session '${previousSessionId}' already started a generation`)
      return 0
    }
    const fault = reason === 'corrupt'
      ? 'is corrupt'
      : 'is refused by the session-format migration'
    this.ctx.logger.warn(`agent-team: previous Session '${previousSessionId}' holding carried input for member '${member}' ${fault}: ${detail}; skipping the replay`)
    return 0
  }

  private async replayCarriedInput(member: AgentTeamAgentMember, agent: Agent, generationStarted: boolean): Promise<number> {
    const transition = this.requireLedger().lastTransitionForMember(member.memberId)
    if (transition === undefined || transition.targetSessionId !== agent.session.id) return 0
    if (generationStarted) return this.skipCarriedInput(member.memberId, agent.session.id, 'started-generation')
    let inspectionEvents: readonly SessionEvent[]
    let inspectionInherited: SessionLogOffset
    const previousRead = await this.sessionReader.read(transition.previousSessionId)
    if (!previousRead.ok) {
      const failure = previousRead.failure
      if (failure.kind === 'corrupt') return this.skipCarriedInput(member.memberId, transition.previousSessionId, 'corrupt', failure.detail)
      if (failure.kind === 'refused') return this.skipCarriedInput(member.memberId, transition.previousSessionId, 'refused', failure.detail)
      throw new StoredSessionReadError(`the previous Session '${transition.previousSessionId}' holding the Member's carried input is unreadable (${failure.kind}): ${failure.detail}`, failure)
    }
    inspectionEvents = previousRead.inspection.events
    inspectionInherited = previousRead.inspection.inheritedEventCount
    const state = foldTeamContextProjection(
      inspectionEvents,
      { sessionId: transition.previousSessionId, inheritedEventCount: inspectionInherited },
      this.contextProjectionHost,
    )
    const carried = carriedInputOf(state, inspectionEvents)
    if (carried.length === 0) return 0
    const known = new Set<string>()
    for (const event of agent.session.ownEvents()) {
      if (event.type !== 'user/message') continue
      const id = (event.data as { id?: string }).id
      if (id !== undefined) known.add(id)
    }
    for (const pending of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
      known.add(pending.id)
    }
    let redelivered = 0
    for (const message of carried) {
      if (known.has(message.id)) continue
      agent.followup(message)
      redelivered += 1
    }
    if (redelivered > 0) this.ctx.logger.info(`agent-team: redelivered ${redelivered} carried input message(s) for member '${this.memberLabel(member.memberId)}' after the generation crash recovery`)
    return redelivered
  }

  /**
   * Jobs this Agent owns that cannot survive a generation swap: any
   * running/stopping job, and any settled job whose terminal output was
   * never reported (disposal would silently discard it). In-place hard
   * compaction is exempt — it never cancels the owner.
   */
  private ownedJobsBlockingRecycle(agent: Agent): readonly string[] {
    const jobs = agent.ctx.get('jobs')
    if (jobs === undefined) return []
    return jobs.list(agent)
      .filter((job: { status: string; reported: boolean }) => job.status === 'running' || job.status === 'stopping' || ((job.status === 'completed' || job.status === 'killed' || job.status === 'failed') && !job.reported))
      .map((job: { id: string; label: string }) => `${job.label} (${job.id})`)
  }

  private emitCommittedOutcome<T extends { readonly kind: string; readonly receipt?: AgentTeamOperationReceipt }>(
    result: { readonly committed: boolean; readonly value: T },
  ): void {
    if (result.committed && result.value.kind === 'committed' && result.value.receipt !== undefined) this.emitCommitted(result.value.receipt)
  }

  private assertChannelMembersAvailable(memberIds: readonly AgentTeamMemberId[] | undefined): void {
    for (const memberId of memberIds ?? []) {
      const member = this.requireLedger().getMember(memberId)
      if (member === undefined) throw new Error(`unknown Agent Member '${memberId}'`)
      if (this.memberStatus(member).availability !== 'active') throw new Error(`Agent Member '${memberId}' is not available for Channel membership`)
    }
  }

  /**
   * Shared append envelope for both message commits: resolve uploads into
   * metadata lines, append through the chosen ledger method, emit the committed
   * receipt, and on any failure drop whatever cache entries this attempt
   * prepared. `commit` only selects which ledger call runs — the ordering of
   * resolution, emission, and failure cleanup is identical for send and reply
   * and lives here once so the two can never drift apart.
   */
  private async commitMessageAs<
    Req extends { readonly requestId: AgentTeamRequestId; readonly body: string; readonly attachmentPaths?: readonly string[] | undefined },
    Res extends { readonly kind: string; readonly receipt?: AgentTeamOperationReceipt },
  >(
    actor: AgentTeamHumanActor | AgentTeamMemberActor,
    request: Req,
    commit: (authorized: Req & { readonly actor: AgentTeamHumanActor | AgentTeamMemberActor; readonly body: string; readonly resolvedAttachments?: readonly AgentTeamMessageAttachment[] }) => Promise<{ readonly committed: boolean; readonly value: Res }>,
  ): Promise<Res> {
    try {
      const metadata = await this.resolveMessageAttachments(request)
      const result = await commit({
        ...request, body: this.appendAttachmentLines(request.body, metadata),
        ...(metadata.length === 0 ? {} : { resolvedAttachments: metadata }),
        actor,
      })
      this.emitCommittedOutcome(result)
      return result.value
    } catch (error) {
      await this.dropUnreferencedPrepared(request, error)
      throw error
    }
  }

  /** Task-creation commit (new Thread): the shared envelope over the ledger's sendMessage. */
  private sendMessageAs(actor: AgentTeamHumanActor | AgentTeamMemberActor, request: AgentTeamSendMessageRequest): Promise<AgentTeamSendMessageResult> {
    return this.commitMessageAs(actor, request, authorized => this.requireLedger().sendMessage(authorized))
  }

  /** Read one Message back verbatim, whoever is asking. */
  private readMessageAs(actor: AgentTeamHumanActor | AgentTeamMemberActor, request: AgentTeamReadMessageRequest): AgentTeamReadMessageResult {
    return this.requireLedger().readMessage(actor, request)
  }

  /** Existing-Thread reply commit: the shared envelope over the ledger's reply. */
  private replyAs(actor: AgentTeamHumanActor | AgentTeamMemberActor, request: AgentTeamReplyRequest): Promise<AgentTeamReplyResult> {
    return this.commitMessageAs(actor, request, authorized => this.requireLedger().reply(authorized))
  }

  /**
   * After a failed message or reply attempt, remove the cache entries this
   * attempt could have prepared — the request-stable path copies — unless a
   * committed Message references them. The ledger's own reference set is the
   * guard, so a post-commit failure or a colliding retry can never delete bytes
   * a stored Message still points at; uploads are untouched, because an
   * unreferenced upload is a legitimate state the GC owns. Cleanup failures are
   * logged and never mask the original error.
   */
  private async dropUnreferencedPrepared(request: { readonly requestId: AgentTeamRequestId; readonly attachmentPaths?: readonly string[] | undefined }, cause: unknown): Promise<void> {
    const prepared = (request.attachmentPaths ?? []).map((_, index) => pathAttachmentId(request.requestId, index))
    if (prepared.length === 0) return
    let referenced: ReadonlySet<AgentTeamAttachmentId>
    try {
      referenced = this.requireLedger().referencedAttachmentIds()
    } catch (failure) {
      this.ctx.logger.warn(`agent-team: could not consult the attachment reference set after a failed message attempt (${String(cause)}): ${String(failure)}`)
      return
    }
    for (const attachmentId of prepared) {
      if (referenced.has(attachmentId)) continue
      try {
        await removeAttachment(attachmentsRoot(), attachmentId)
      } catch (failure) {
        this.ctx.logger.warn(`agent-team: could not drop unreferenced prepared attachment '${attachmentId}' after a failed message attempt: ${String(failure)}`)
      }
    }
  }

  /** Fence one Human Remote call: accepting Host, known Workspace, Human actor. */
  private humanCall(workspaceId: AgentTeamViewRequest['workspaceId']): AgentTeamHumanActor {
    this.requireAccepting()
    this.requireWorkspace(workspaceId)
    return agentTeamHumanActor()
  }

  /** Fence one Member call: accepting Host, live Member binding, matching Workspace participation. */
  private memberCall(agent: Agent, workspaceId: AgentTeamViewRequest['workspaceId']): AgentTeamMemberActor {
    this.requireAccepting()
    this.requireWorkspace(workspaceId)
    const actor = this.memberActor(agent)
    this.requireAgentWorkspace(actor, workspaceId)
    return actor
  }

  private memberActor(agent: Agent): AgentTeamMemberActor {
    const member = this.memberForAgent(agent)
    if (member === undefined) throw new Error('Agent is not an active Team Member')
    return Object.freeze({ kind: 'member', memberId: member.memberId, handle: member.handle })
  }

  private requireAgentWorkspace(actor: AgentTeamMemberActor, workspaceId: AgentTeamViewRequest['workspaceId']): void {
    if (!this.requireLedger().participatesIn(actor.memberId, workspaceId)) throw new Error('Member cannot mutate another Workspace')
  }

  /**
   * Reject a model route the Host cannot serve: an unregistered provider has no
   * adapter at all, so the Member would be created and fail its first turn with
   * an unrelated message. Checked here so the caller sees the real reason.
   */
  private async assertModelRoute(model: AgentTeamModelSelection | null | undefined): Promise<void> {
    // No route to check: absent keeps the stored selection and null clears it.
    if (model === undefined || model === null) return
    // No LLM service means no adapter to check against; the reasoning-effort
    // branch below already defers in that case, and so does this one. The
    // LLM service is read through `get`, not the `ctx.llm` property: the Host
    // does not hard-inject it, and an undeclared property read throws instead
    // of yielding `undefined`, which would surface as an unrelated error to
    // the caller saving a Member's model.
    const llm = this.ctx.get('llm')
    const providers = llm === undefined ? undefined : llm.listProviders()
    if (providers !== undefined && !providers.some(provider => provider.id === model.provider)) {
      throw new Error(`provider '${model.provider}' is not registered`)
    }
    // Validate a pinned route's reasoning effort against the adapter's own
    // metadata when the LLM service is reachable; unknown routes defer to the
    // LLM layer's runtime check at call time.
    if (model.reasoningEffort === undefined || llm === undefined) return
    try {
      const resolved = await llm.resolveModelInfo(model.provider, model.model)
      const efforts = resolved.reasoning?.efforts ?? []
      if (efforts.length > 0 && !efforts.some(effort => effort.id === model.reasoningEffort)) {
        throw new Error(`reasoning effort '${model.reasoningEffort}' is not supported by ${model.provider}/${model.model}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('is not supported by')) throw error
    }
  }

  /**
   * Session headers currently durable in the persistence backend.
   *
   * The Host retires a disposed Session's log without awaiting it, so a
   * concurrent activation can observe the JSONL backend's transient win32
   * staging directories (.dsh-mkdir-*) as ENOENT while they rename into
   * place. The read is idempotent; back off briefly instead of failing the
   * activation on a race the publisher resolves within milliseconds.
   */
  private async persistedSessionHeaders() {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.ctx.sessionPersistence.list()
      } catch (error) {
        if (attempt >= 3 || (error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
        await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 25))
      }
    }
  }

  private async activateMember(member: AgentTeamAgentMember, knownWorkspacePath?: string, knownSessions?: ReadonlySet<SessionId>, forkedFrom?: SessionId, options?: { readonly deferNotify?: boolean }): Promise<void> {
    if (this.handles.has(member.memberId)) return
    let created: AgentHandle | undefined
    try {
      const workspace = this.requireWorkspace(member.workspaceId)
      const workspacePath = knownWorkspacePath ?? workspace.path
      // Existing Members carry the pre-sanitization ledger path; activation
      // migrates it onto the sanitized directory before provisioning.
      const sanitizedMemoryPath = dshHomePath('agent-team', 'members', memberMemoryDirectoryName(member.memberId))
      await this.memberRuntime.initializePrivateMemory(sanitizedMemoryPath, member.privateMemoryPath)
      const persisted = knownSessions !== undefined ? knownSessions.has(member.sessionId)
        : await this.sessionPersisted(member.sessionId)
      // A restart or a resume meets the same wake boundary a message does: the
      // generation it would restore is priced from its stored log, and a cold
      // one is replaced instead of resumed, so the old Session is never even
      // loaded. A planned activation of a successor (`forkedFrom`) never
      // re-decides — the swap that built it already did.
      if (forkedFrom === undefined && persisted) {
        const plan = await this.planWakeForMember(member, undefined)
        if (plan.action === 'recycle') {
          this.ctx.logger.info(`agent-team: activating ${this.memberScope(member.memberId, member.sessionId)} swaps its cold generation: idle ${plan.idleMs}ms over ${plan.thresholds.idleMs}ms, context ${plan.contextTokens} over ${plan.thresholds.minContextTokens}`)
          await this.contextManagement.requestRecycle(member.memberId, member)
          return
        }
      }
      // AgentOptions declares only provider/model. Install the full selection
      // through the public Agent model-selection seam so reasoning effort is
      // applied to the next request and not lost during activation.
      const selection = member.model ?? this.ctx.agentDefaultModel.currentSelection()
      const agentOptions = { provider: selection.provider, model: selection.model }
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      const setup = async (agentCtx: Context, agent: Agent) => {
        try {
          await this.ctx.agentPresets.mount(agentCtx, member.presetId)
          this.memberRuntime.applyMemberToolPolicy(agentCtx, member)
          this.validateMemberPreset(agentCtx)
        } catch (error) {
          // Tag composition failures with their own class: the activation
          // diagnostic routes preset-composition (install/runtime split)
          // failures by type, not by matching message text.
          throw new PresetCompositionError(error instanceof Error ? error.message : String(error), { cause: error })
        }
        installModelSelection(agentCtx, selected)
        return {
          commit: () => {
            // The member scope composes no sandbox-policy service (the preset
            // owns no sandbox row), so read the last logged mode straight from
            // the session log; `sandbox/mode` is log-only and never joins the
            // model-visible surface. Re-appending only when the effective mode
            // differs keeps resumed members from growing redundant events.
            const logged = agent.session.ownEvents().toReversed().find(event => event.type === 'sandbox/mode')
            if (logged?.data.mode !== 'danger-full-access') setSandboxMode(agent.session, 'danger-full-access')
          },
        }
      }
      // A renewal's create path parents at the ledger-recorded previous
      // Session even when the caller does not pass one: a crash between the
      // durable swap commit and this activation recreates the Session from the
      // ledger binding alone, and the lineage parent keeps the succession
      // readable from the durable header.
      const lineageParent = forkedFrom ?? (!persisted ? this.requireLedger().previousSessionForMember(member.memberId) : undefined)
      let recoveryCarried = 0
      created = persisted
        ? await this.ctx.agents.resume({ resumeSessionId: member.sessionId, agentOptions, setup })
        : await this.ctx.agents.create({
            sessionId: member.sessionId,
            meta: {
              cwd: workspacePath,
              agentPreset: member.presetId,
              ...(lineageParent === undefined ? {} : { parentSession: lineageParent }),
            },
            agentOptions,
            setup,
          })
      this.memberRuntime.mountMemberSkillProvider(member, created.agent.ctx, member.capabilities?.skills?.allow)
      // Both capability effects are now live (the tool restriction inside
      // `setup`, the skill selection here): record the intent the surface
      // reflects so a later edit or retry compares against reality instead
      // of against this request's own history.
      this.memberRuntime.recordAppliedCapabilities(member.memberId, member.capabilities)
      await workspace.attachSession(member.sessionId)
      this.handles.set(member.memberId, created)
      this.memberBySessionId.set(member.sessionId, member.memberId)
      this.modelSelections.set(member.memberId, selected)
      this.clearMemberFailure(member.memberId, 'activation')
      this.clearMemberFailure(member.memberId, 'preTurnCancellation')
      this.clearMemberFailure(member.memberId, 'capabilityApply')
      this.nameMemberSession(member, created.agent)
      const generationStarted = created.agent.session.ownEvents().some(event => event.type === 'turn/start')
      // A restart between a durable rollover intent and its swap replays the
      // old Session; the projection still carries the intent, so finish the
      // transition (or keep waiting for the containing turn) from here.
      if (persisted) {
        const inheritedEventCount = created.agent.session.inheritedEventCount
        const state = foldTeamContextProjection(
          created.agent.session.ownEvents(),
          { sessionId: created.agent.session.id, inheritedEventCount },
          this.contextProjectionHost,
        )
        if (state.pending !== null) this.contextManagement.recoverPendingTransition(member.memberId, created.agent, member.sessionId)
        // A restart between one checkpoint's durable result and its quiet
        // follow-up delivery repairs exactly once; delivered continuations
        // stay delivered through the projection's own delivery record.
        this.contextManagement.repairContinuations(created.agent, state)
        // Carried input redelivery binds to the committed transition target —
        // this Session. A crash after the binding flipped but before the
        // carried enqueue still replays here.
        recoveryCarried = await this.replayCarriedInput(member, created.agent, generationStarted)
      } else if (forkedFrom === undefined && lineageParent !== undefined) {
        // A restart recreated a Session that never materialized before the
        // crash (the swap committed, its activation failed, and this create
        // path just rebuilt it from the ledger binding alone): the retired
        // generation's unconsumed input — the durable fold, the same truth the
        // live transition uses — is what the successor still owes.
        recoveryCarried = await this.replayCarriedInput(member, created.agent, generationStarted)
      }
      // The ordinary Inbox wake runs LAST, so carried input and rederived Team
      // facts keep their order behind it. When recovery redelivered carried
      // input, the wake is sequenced behind it (its own follow-up turn) so the
      // steer lane can never leapfrog those messages. A swap activation defers
      // the wake entirely — its caller delivers carried input first and
      // rederives the Inbox afterwards.
      if (options?.deferNotify !== true) {
        this.notifyMember(created.agent, {
          kind: 'activation',
          ...(lineageParent === undefined ? {} : { previousSessionId: lineageParent }),
        }, recoveryCarried > 0)
      }
    } catch (error) {
      if (created !== undefined) await this.disposeWithWakeGuard(created)
      this.modelSelections.delete(member.memberId)
      this.memberRuntime.forgetMember(member.memberId)
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`agent-team: activation failed for member '${this.memberLabel(member.memberId)}': ${message}`)
      this.setActivationDiagnostic(member.memberId, this.activationDiagnosticOf(error, member.sessionId))
    } finally {
      // Activation only changes this Workspace's presence projection.
      this.emitMemberPresenceChanged(member)
    }
  }


  /**
   * Rebuild one enabled Member in place from its persisted Session.
   *
   * A bundle-row reload tears down the preset roster subtree, which prunes the
   * standing mount while live agents keep their dead scope bindings: the
   * Member keeps its session but loses its composed tools and services.
   * Re-running the preset composition requires a fresh Agent, and disposal is
   * the cost — the Web Client marks the recreated Session unavailable until it
   * is reopened, the same trade the shipped suspend/resume cycle makes.
   */
  private reactivateMember(memberId: AgentTeamMemberId): Promise<boolean> {
    return this.enqueueLifecycle(memberId, async () => {
      const member = this.requireLedger().getMember(memberId)
      if (member === undefined || member.state !== 'enabled') return false
      const stale = this.handles.get(memberId)
      if (stale !== undefined) {
        this.handles.delete(memberId)
        this.modelSelections.delete(memberId)
        this.memberRuntime.forgetMember(memberId)
        // The composition-loss diagnostic this heal answers is stale once the
        // rebuild starts; a later activation must not resurface it.
        this.emitMemberPresenceChanged(member)
        await this.disposeWithWakeGuard(stale)
      }
      await this.activateMember(member)
      return this.handles.has(memberId)
    })
  }

  /**
   * Default an untitled Member Session to its handle so the ordinary Session
   * list names it. An explicit rename or any earlier title always wins; the
   * cosmetic default never fails Member activation.
   */
  private nameMemberSession(member: AgentTeamAgentMember, agent: Agent): void {
    const sessionTitle = this.ctx.get('sessionTitle')
    if (sessionTitle === undefined) return
    try {
      if (sessionTitle.get(agent.session) !== undefined) return
      sessionTitle.rename(agent.session, member.handle)
    } catch {
      // The composition may carry no session-title service, or the rename may
      // race its disposal; the Member works identically without the title.
    }
  }

  private validateMemberPreset(agentCtx: Context): void {
    const scope = scopeOf(agentCtx)
    const teamMessage = this.ctx.tools.get('team_message', scope)
    if ((teamMessage as Record<PropertyKey, unknown> | undefined)?.[AGENT_TEAM_PRESET_MARKER] !== true) {
      // `agentPresets.mount` already rejected an unscoped context, so a scope
      // key the harness sees but this bundle does not means the two sides
      // loaded different module instances of @deepseek-ai/dsh-scope (the
      // common trigger is running the CLI from source via tsx).
      if (scope === undefined) throw new Error(teamPresetScopeMismatchMessage(isTsxDevMode()))
      throw new Error('selected preset is not team-enabled')
    }
    const available = new Set(this.ctx.tools.schemas(scope).map(tool => tool.name))
    const missing = AGENT_TEAM_TOOL_NAMES.filter(name => !available.has(name))
    if (missing.length > 0) throw new Error(`team-enabled preset is missing tools: ${missing.join(', ')}`)
  }

  /**
   * The states with no live surface at all. Each reports a literal `pending`
   * capability: no apply can be in force there, and a literal cannot inherit a
   * stale applied-record left behind by a torn-down surface.
   */
  private memberStatus(member: AgentTeamAgentMember): AgentTeamAgentMemberStatus {
    if (member.state !== 'enabled') {
      return Object.freeze({ member, availability: member.state, presence: 'unavailable', capabilityState: 'pending' })
    }
    const failures = this.memberFailures.get(member.memberId)
    if (failures?.activation !== undefined) return Object.freeze({ member, availability: 'unavailable', presence: 'unavailable', capabilityState: 'pending', diagnostic: failures.activation })
    const handle = this.handles.get(member.memberId)
    if (handle === undefined) return Object.freeze({ member, availability: 'unavailable', presence: 'unavailable', capabilityState: 'pending' })
    const capabilityState: 'applied' | 'pending' = this.memberRuntime.appliedCapabilitiesMatch(member.memberId, member.capabilities) ? 'applied' : 'pending'
    // A rollover commits its ledger binding before the old generation retires
    // and the new one activates; during that window the live handle still runs
    // the previous Session. The Member stays visible but must not report the
    // new binding as active — a Client following the row would otherwise open
    // a Session that does not exist yet.
    if (handle.agent.id !== member.sessionId) return Object.freeze({ member, availability: 'unavailable', presence: 'unavailable', capabilityState, diagnostic: { class: 'rollover' as const, detail: 'context rollover in progress' } })
    if (this.ctx.agentPresets.composedPreset(handle.agent.ctx) === undefined) {
      return Object.freeze({ member, availability: 'active', presence: 'error', capabilityState, diagnostic: { class: 'preset-composition' as const, detail: ORPHANED_MEMBER_DIAGNOSTIC } })
    }
    if (failures?.runtime !== undefined) return Object.freeze({ member, availability: 'active', presence: 'error', capabilityState, diagnostic: { class: 'runtime' as const, detail: failures.runtime } })
    if (failures?.preTurnCancellation !== undefined) return Object.freeze({ member, availability: 'active', presence: 'error', capabilityState, diagnostic: failures.preTurnCancellation })
    // A failed apply outranks the plain success row but not a live runtime
    // error: the Member runs, yet its stored configuration is ahead of the
    // surface until the effect lands. The warning digest rides along — the
    // unknown-name signal and the apply failure answer different questions.
    if (failures?.capabilityApply !== undefined) {
      const capabilityWarnings = this.memberRuntime.capabilityWarningsFor(member.memberId)
      return Object.freeze({
        member, availability: 'active', presence: 'error', capabilityState, diagnostic: failures.capabilityApply,
        ...(capabilityWarnings === undefined ? {} : { capabilityWarnings }),
      })
    }
    // Capability warnings are runtime-derived at activation (handles-scoped,
    // like failures): absent while capabilities resolve cleanly.
    const capabilityWarnings = this.memberRuntime.capabilityWarningsFor(member.memberId)
    return Object.freeze({
      member, availability: 'active', presence: handle.agent.status === 'running' ? 'working' : 'available',
      capabilityState,
      ...(capabilityWarnings === undefined ? {} : { capabilityWarnings }),
    })
  }

  private setMemberFailure(memberId: AgentTeamMemberId, slot: 'runtime', message: string): void {
    const failures = this.memberFailures.get(memberId) ?? {}
    failures[slot] = message
    this.memberFailures.set(memberId, failures)
  }

  private setActivationDiagnostic(memberId: AgentTeamMemberId, diagnostic: AgentTeamMemberDiagnostic): void {
    const failures = this.memberFailures.get(memberId) ?? {}
    failures.activation = Object.freeze(diagnostic)
    this.memberFailures.set(memberId, failures)
  }

  /** Store the post-commit configuration apply failure; cleared when the effect lands or a later activation succeeds. */
  private setCapabilityApplyDiagnostic(memberId: AgentTeamMemberId, diagnostic: AgentTeamMemberDiagnostic): void {
    const failures = this.memberFailures.get(memberId) ?? {}
    failures.capabilityApply = Object.freeze(diagnostic)
    this.memberFailures.set(memberId, failures)
  }

  /**
   * Route one activation failure to its diagnostic class: preset composition
   * failures by their own error class, session failures by the seam's typed
   * classification (our call sites carry it directly; a Harness resume
   * failure carries it through the cause chain), everything else as an
   * unclassified activation failure.
   */
  private activationDiagnosticOf(error: unknown, sessionId: SessionId): AgentTeamMemberDiagnostic {
    if (error instanceof PresetCompositionError) return { class: 'preset-composition' as const, detail: error.message }
    const failure = error instanceof StoredSessionReadError ? error.failure : sessionFailureOf(error, sessionId)
    if (failure !== undefined) {
      const shared = { detail: failure.detail, ...(failure.location === undefined ? {} : { location: failure.location }), sessionId: failure.sessionId }
      return failure.kind === 'refused' ? { class: 'session-refused' as const, ...shared } : { class: 'session-unreadable' as const, ...shared }
    }
    return { class: 'activation' as const, detail: error instanceof Error ? error.message : String(error) }
  }

  private clearMemberFailure(memberId: AgentTeamMemberId, slot: 'activation' | 'runtime' | 'preTurnCancellation' | 'capabilityApply'): boolean {
    const failures = this.memberFailures.get(memberId)
    if (failures === undefined || failures[slot] === undefined) return false
    if (Object.keys(failures).length === 1) this.memberFailures.delete(memberId)
    else delete failures[slot]
    return true
  }

  private requireWorkspace(workspaceId: AgentTeamViewRequest['workspaceId']) {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new Error(`unknown Workspace '${workspaceId}'`)
    return workspace
  }

  private requireLedger(): AgentTeamLedger {
    if (this.ledger === undefined || this.domain === undefined) throw new Error('agent-team service is not initialized')
    return this.ledger
  }

  private requireAccepting(): void {
    if (!this.accepting) throw new Error('agent-team service is shutting down')
  }

  private emitCommitted(receipt: AgentTeamOperationReceipt): void {
    // Everything below runs after the ledger append, so nothing here may turn
    // a committed operation into a failed Remote call. Each effect that runs
    // third-party code — Cordis listeners, change waiters, agent wakes — goes
    // through `afterCommit`; the ordering itself is unchanged: listeners,
    // then Client invalidation, then the participation notice, then wakes.
    this.afterCommit('commit listener dispatch', () => this.ctx.emit('agent-team/committed', { receipt }))
    const operation = this.ledger?.getOperation(receipt.operationId)
    if (operation === undefined) {
      this.afterCommit('change invalidation', () => this.emitChanged())
      return
    }
    const ledger = this.requireLedger()
    this.afterCommit('change invalidation', () => this.emitChanged(ledger.changeScopesOf(operation)))
    if (operation.kind === 'team/member-workspace-joined' || operation.kind === 'team/member-workspace-left') {
      this.afterCommit('participation notice', () => {
        const agent = this.handles.get(operation.data.memberId)?.agent
        if (agent === undefined) return
        const path = this.ctx.workspaceRegistry.get(operation.data.workspaceId)?.path
        const text = `Team participation changed: you have ${operation.kind === 'team/member-workspace-joined' ? 'joined' : 'left'} Workspace ${operation.data.workspaceId}${path === undefined ? ' (path unavailable)' : ` (${JSON.stringify(path)})`}.\nCurrent Workspace ids: ${ledger.workspacesOf(operation.data.memberId).join(', ')}. This replaces earlier participation information. Your Session and cwd have not moved.`
        const notice = createUserMessage({ content: [{ type: 'text', text }],
          source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: 'Team Workspace participation changed' } })
        // Delivered from durable facts; a failed wake cannot roll back the
        // committed participation — the next notice rederives it.
        if (agent.status === 'idle' || agent.inbox.nextTurn.some(message => message.source.kind === 'user')) agent.followup(notice)
        else agent.steer(notice)
      })
    }
    for (const memberId of ledger.affectedMembersOf(operation)) {
      const handle = this.handles.get(memberId)
      if (handle !== undefined) {
        this.afterCommit(`notification for '${this.memberLabel(memberId)}'`,
          () => this.notifyMember(handle.agent, { kind: 'commit', receipt, operationKind: operation.kind }))
      }
    }
  }

  /**
   * Run one effect that follows the ledger append. The operation is durable by
   * the time this runs, so a delivery or listener failure degrades to a log
   * line: the Remote answer stays the committed result instead of a false
   * rollback, and an Inbox wake that failed clears its own signature, so the
   * next commit touching that Member rederives the same durable facts and
   * retries without appending a second operation.
   *
   * An invariant divergence is the deliberate exception — the invariant
   * companion re-raises it on the caller's frame precisely to stay loud, and
   * swallowing it would silence a failed integrity check.
   */
  private afterCommit(label: string, effect: () => void): void {
    try {
      effect()
    } catch (error) {
      if (error instanceof AgentTeamInvariantError) throw error
      this.ctx.logger.warn(`agent-team: post-commit ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }


  /**
   * Presence-only invalidation: Agent running/idle/activation/failure changes
   * alter no durable projection, so only members/presence subscribers wake —
   * the workspace catalog and the scope-less Inbox subscriptions stay parked.
   */
  private emitPresenceChanged(workspaceId: WorkspaceId): void {
    this.emitChanged([{ kind: 'presence', workspaceId }])
  }

  /** Presence invalidation in every Workspace the Member participates in — each panel listing it must refresh. */
  private emitMemberPresenceChanged(member: AgentTeamAgentMember): void {
    for (const workspaceId of this.requireLedger().workspacesOf(member.memberId)) this.emitPresenceChanged(workspaceId)
  }

  /**
   * The stable correlation group every Member-scoped diagnostic line carries:
   * the ledger's Member id and the Session that owns the effect, with the
   * renameable handle as readable context only. The Session resolves from the
   * live generation first and from the ledger binding second, so a line about
   * a disposed or failed generation still names the Session it concerns.
   */
  private memberScope(memberId: AgentTeamMemberId, sessionId?: SessionId): string {
    const handle = this.ledger?.getMember(memberId)?.handle
    const session = sessionId ?? this.handles.get(memberId)?.agent.session.id ?? this.ledger?.getMember(memberId)?.sessionId
    return `member '${handle ?? memberId}' memberId '${memberId}'${session === undefined ? '' : ` session '${session}'`}`
  }

  /** The business identity one notification line states, so a wake is traceable to what caused it. */
  private notificationCauseText(cause: NotificationCause): string {
    if (cause.kind === 'commit') {
      return `requestId '${cause.receipt.requestId}' operationId '${cause.receipt.operationId}' operation '${cause.operationKind}' sequence ${cause.receipt.sequence}`
    }
    if (cause.kind === 'transition') {
      return `session transition requestId '${cause.requestId}' previousSession '${cause.previousSessionId}'`
    }
    if (cause.kind === 'activation') {
      return cause.previousSessionId === undefined
        ? 'Member activation'
        : `Member activation previousSession '${cause.previousSessionId}'`
    }
    return 'running transition'
  }

  /** The unread facts one notice covers, bounded to what identifies them durably. */
  private notificationIdentity(notifications: ReturnType<AgentTeamLedger['notificationFacts']>): string {
    let newest = 0
    for (const { item } of notifications) newest = Math.max(newest, item.newestSequence)
    return `${notifications.length} unread Thread(s), newest unread fact sequence ${newest}`
  }

  /**
   * Wake from durable unread state with bounded facts for direct and
   * state-changing work. One correlated line states what the wake did: which
   * business operation or lifecycle step caused it, which delivery attempt it
   * spent, and whether the notice was queued, already carried by a recovery
   * instruction, skipped, or failed. A queued notice is delivery intent —
   * never evidence that the model read it.
   *
   * A delivery failure is contained here instead of escaping to the commit
   * boundary: the operation is already durable, so a failed wake must not read
   * as a failed write, and this line names the Member, Session, and attempt the
   * generic post-commit warning could not. Only an invariant divergence still
   * leaves on the caller's frame.
   */
  private notifyMember(agent: Agent, cause: NotificationCause, sequenced = false): void {
    const member = this.memberForAgent(agent)
    if (member === undefined) {
      this.ctx.logger.debug(`agent-team: Team Inbox notice not attempted for session '${agent.id}' cause ${this.notificationCauseText(cause)}: the Agent is not a Team Member`)
      return
    }
    if (member.state !== 'enabled') {
      this.ctx.logger.debug(`agent-team: Team Inbox notice not attempted for ${this.memberScope(member.memberId, agent.id)} cause ${this.notificationCauseText(cause)}: the Member is ${member.state}`)
      return
    }
    const events = agent.status === 'idle' ? logEventsOf(agent) : undefined
    const atWake = agent.status === 'idle' && (this.contextManagement.isTransitioning(member.memberId)
      || this.cheapWakePlan(events).action === 'measure-context')
    if (atWake) {
      void this.notifyMemberAtWake(member.memberId, agent, cause, sequenced)
      return
    }
    // A swap already in flight delivers nothing into the Session it retires:
    // the successor's rederived Inbox carries these same durable facts.
    if (this.contextManagement.isTransitioning(member.memberId)) return
    this.deliverInboxNotice(agent, member, cause, sequenced)
  }

  private async notifyMemberAtWake(memberId: AgentTeamMemberId, agent: Agent, cause: NotificationCause, sequenced: boolean): Promise<void> {
    let gate: Error | undefined
    try {
      gate = await this.wakeGateFor(agent)
    } catch (error) {
      gate = new Error(failureDetail(error))
    }
    const live = this.handles.get(memberId)?.agent
    const member = live === undefined ? undefined : this.memberForAgent(live)
    // Absent or a different live Agent means this wake swapped the generation:
    // the swap rederives the Inbox for its successor, so delivering here would
    // duplicate the very facts that rederivation already carries.
    if (live === undefined || member === undefined || live !== agent) return
    if (gate !== undefined) {
      this.ctx.logger.warn(`agent-team: Team Inbox notice not delivered for ${this.memberScope(memberId, agent.id)} cause ${this.notificationCauseText(cause)}: ${gate.message}; the durable unread facts stay unread and rederive on the next commit`)
      return
    }
    this.deliverInboxNotice(live, member, cause, sequenced)
  }

  private deliverInboxNotice(agent: Agent, member: AgentTeamAgentMember, cause: NotificationCause, sequenced = false): void {
    const notifications = this.requireLedger().notificationFacts(member.memberId)
    const scope = this.memberScope(member.memberId, agent.id)
    const causeText = this.notificationCauseText(cause)
    if (notifications.length === 0) {
      this.dropInboxCoverage(member.memberId)
      this.ctx.logger.debug(`agent-team: Team Inbox notice not attempted for ${scope} cause ${causeText}: the Member has no unread Team facts`)
      return
    }
    // Any ordinary next-turn input already queued (a rollover's or recovery's
    // carried messages) forces sequencing regardless of the caller: a steer
    // would claim the nearest step boundary and leapfrog the carried turn.
    if (!sequenced) {
      sequenced = agent.inbox.nextTurn.some(message => message.source.kind === 'user')
    }
    const signature = JSON.stringify(notifications.map(({ item }) => [
      item.thread.threadRef, item.thread.revision, item.unreadCount, item.directCount, item.newestSequence,
    ]))
    const facts = this.notificationIdentity(notifications)
    // An unchanged rederivation spends no attempt: the delivery already made
    // for these facts stands, which is what keeps a repeated commit's logging
    // bounded.
    if (this.inboxNoticeDeliveries.get(member.memberId)?.covered === signature) {
      this.ctx.logger.debug(`agent-team: Team Inbox notice not attempted for ${scope} cause ${causeText}: the same unread facts (${facts}) already have a delivery attempt`)
      return
    }
    const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
    // steerResume already combines the recovery instruction and these durable
    // facts. Its synchronous running transition must not replace that notice.
    if (pending.some(message => this.isRecoveryNotice(message))) {
      this.coverInboxFacts(member.memberId, signature)
      this.ctx.logger.info(`agent-team: Team Inbox notice carried by the queued recovery instruction for ${scope} cause ${causeText} (${facts}): queued with that recovery instruction, not yet read by the model`)
      return
    }
    const existingInboxHint = pending.find(message => this.isInboxNotice(message))
    if (existingInboxHint !== undefined) this.removeExpectedTeamWake(agent, existingInboxHint)
    const hint = createUserMessage({
      content: [{ type: 'text', text: this.notificationText(notifications, member.memberId) }],
      source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: TEAM_INBOX_NOTICE_SUMMARY },
    })
    this.trackTeamWake(agent, hint)
    const attempt = this.beginInboxDelivery(member.memberId, signature)
    try {
      // Steer normally claims the nearest step boundary — which would
      // preempt carried input that a swap or crash recovery queued as
      // ordinary next-turn messages. The sequenced mode enqueues the
      // rederived Inbox as its own follow-up turn instead, so the delivery
      // order stays carried input → rederived Inbox.
      if (sequenced) agent.followup(hint)
      else agent.steer(hint)
    } catch (error) {
      this.dropInboxCoverage(member.memberId)
      if (error instanceof AgentTeamInvariantError) throw error
      this.ctx.logger.warn(`agent-team: Team Inbox notice delivery failed for ${scope} cause ${causeText} attempt ${attempt} (${facts}): ${failureDetail(error)}; the operation is committed and stands, and the failed delivery stands as an attempt so the next fact touching this Member rederives and retries it`)
      return
    }
    this.ctx.logger.info(`agent-team: Team Inbox notice queued for ${scope} cause ${causeText} attempt ${attempt} lane '${sequenced ? 'follow-up turn' : 'next step'}' (${facts}): queued for the Member's next step, not yet read by the model`)
  }

  /**
   * One line per automatic-recovery state change — the family it classified,
   * the consecutive occurrence that counts, the wait it armed, the wakeup that
   * fired, the stand-down at the limit, and why tracking ended. Each is
   * reported once per change, so the automatic path stays explainable without
   * turning on debug output, and no stop is silent: not a canceled wakeup, not
   * a stand-down, and not a wake whose target is gone.
   */
  private reportRecovery(fact: RecoveryFact): void {
    const scope = this.memberScope(fact.memberId)
    if (fact.kind === 'scheduled') {
      this.ctx.logger.info(`agent-team: automatic recovery scheduled for ${scope} errorKind '${fact.errorKind}' occurrence ${fact.consecutiveFailures}/${fact.maxConsecutiveErrors} wait ${fact.delayMs}ms`)
      return
    }
    if (fact.kind === 'woke') {
      this.ctx.logger.debug(`agent-team: automatic recovery wait elapsed for ${scope} after ${fact.consecutiveFailures} consecutive recoverable error(s): attempting the automatic continuation`)
      return
    }
    if (fact.kind === 'stood-down') {
      this.ctx.logger.warn(`agent-team: automatic recovery stood down for ${scope} after ${fact.consecutiveFailures}/${fact.maxConsecutiveErrors} consecutive '${fact.errorKind}' errors: leaving the Member in error for the operator, with no further automatic wakeup until a clean turn or a manual recovery`)
      return
    }
    this.ctx.logger.info(`agent-team: automatic recovery cleared for ${scope} reason '${fact.reason}' after ${fact.consecutiveFailures} consecutive recoverable error(s) with ${fact.pendingWakes} pending wakeup(s)${fact.stoodDown ? ', stood down' : ''}${fact.detail === undefined ? '' : `: ${fact.detail}`}`)
  }

  private isInboxNotice(message: UserMessage): boolean {
    const source = message.source
    return isAgentTeamSource(source)
      && source.form === 'notice' && source.summary === TEAM_INBOX_NOTICE_SUMMARY
  }

  private isTeamWake(message: UserMessage): boolean {
    return this.isInboxNotice(message) || this.isRecoveryNotice(message)
  }

  private trackTeamWake(agent: Agent, message: UserMessage): void {
    const member = this.memberForAgent(agent)
    if (member === undefined) return
    this.pendingTeamWakes.set(message.id, { memberId: member.memberId, sessionId: agent.id })
  }

  /** Remove a Team notice that Host code is replacing or disposing on purpose. */
  private removeExpectedTeamWake(agent: Agent, message: UserMessage): void {
    this.expectedInboxDiscards.add(message.id)
    if (!agent.inbox.remove(message.id)) {
      this.expectedInboxDiscards.delete(message.id)
      this.pendingTeamWakes.delete(message.id)
    }
  }

  private expectPendingTeamWakes(agent: Agent): void {
    for (const pending of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
      if (this.isTeamWake(pending)) this.removeExpectedTeamWake(agent, pending)
    }
  }

  /**
   * Dispose a Member handle after pre-declaring its queued Team wakes: tearing
   * a Session down discards whatever it had queued, which must not be read as a
   * pre-turn cancellation of work the Member never refused.
   */
  private disposeWithWakeGuard(handle: AgentHandle): Promise<void> {
    this.expectPendingTeamWakes(handle.agent)
    return handle.dispose()
  }

  private setPreTurnCancellation(memberId: AgentTeamMemberId, sessionId: SessionId): void {
    const failures = this.memberFailures.get(memberId) ?? {}
    failures.preTurnCancellation = Object.freeze({
      class: 'runtime' as const,
      detail: 'Team wake was canceled before the Member started a turn; the Harness did not report a cancellation reason.',
      sessionId,
      source: 'agent/inbox/discarded',
      occurredAt: new Date().toISOString(),
    })
    this.memberFailures.set(memberId, failures)
  }

  private isRecoveryNotice(message: UserMessage): boolean {
    const source = message.source
    return isAgentTeamSource(source)
      && source.form === 'notice' && source.summary === TEAM_RECOVERY_NOTICE_SUMMARY
  }

  private notificationText(notifications: ReturnType<AgentTeamLedger['notificationFacts']>, readerId?: AgentTeamMemberId): string {
    const maxCharacters = 32 * 1024
    const sections: string[] = [TEAM_INBOX_NOTICE_SUMMARY]
    let characterCount = sections[0]!.length
    let detailedFactCount = 0
    let omitted = notifications.length > 8
    const append = (section: string): boolean => {
      if (characterCount + section.length + 2 > maxCharacters) {
        omitted = true
        return false
      }
      sections.push(section)
      characterCount += section.length + 2
      return true
    }
    for (const { item, facts } of notifications.slice(0, 8)) {
      if (!append(`Workspace: ${item.workspaceId}\nChannel: ${item.channelRef}`)) break
      for (const { fact, direct } of facts) {
        if (detailedFactCount >= 20) {
          omitted = true
          break
        }
        if (direct && fact.kind === 'message') {
          const sender = fact.message.sender === AGENT_TEAM_HUMAN_MEMBER_ID
            ? 'human' : this.requireLedger().getMember(fact.message.sender)?.handle ?? fact.message.sender
          // Resolved once: the line is optional, and resolving twice would be
          // two ledger lookups for one sentence.
          const repliesTo = this.repliesToLine(fact.message, item.workspaceId)
          const detail = ['Direct Team mention', `Occurred at: ${formatTeamTimestamp(fact.occurredAt)}`, `From: ${sender}`, `Channel: ${item.channelRef}`,
            ...(item.task === undefined ? [] : [`Task: ${item.task.taskRef}`]),
            `Thread: ${item.thread.threadRef}`, `Message ref: ${fact.message.messageRef}`,
            ...(repliesTo === undefined ? [] : [repliesTo]),
            `Message: ${this.boundedNotificationBody(fact.message.body)}`].join('\n')
          if (append(detail)) detailedFactCount += 1
        } else if (fact.kind === 'activity') {
          const detail = `${this.activityNotification(fact.activity, readerId)}\nOccurred at: ${formatTeamTimestamp(fact.occurredAt)}\nThread: ${item.thread.threadRef}`
          if (append(detail)) detailedFactCount += 1
        }
      }
      const ordinary = facts.filter(entry => entry.fact.kind === 'message' && !entry.direct)
      if (ordinary.length > 0) {
        const route = item.task === undefined ? `Thread ${item.thread.threadRef}` : `Task ${item.task.taskRef}`
        append(`${route}: ${ordinary.length} unread update${ordinary.length === 1 ? '' : 's'} · newest at ${formatTeamTimestamp(ordinary.at(-1)!.fact.occurredAt)}.`)
      }
    }
    if (omitted) sections.push('More unread work remains in team_inbox; the automatic context is bounded.')
    sections.push('Use team_thread read with the relevant workspace and threadRef before acting or replying. Use team_inbox only when you need to triage the remaining Threads.')
    return sections.join('\n\n')
  }

  private boundedNotificationBody(body: string): string {
    const limit = NOTIFICATION_BODY_MAX_CHARACTERS
    return body.length <= limit ? body : `${body.slice(0, limit)}\n${NOTIFICATION_TRUNCATION_MARKER}`
  }

  private activityNotification(activity: AgentTeamActivity, readerId?: AgentTeamMemberId): string {
    const actor = activity.actor === AGENT_TEAM_HUMAN_MEMBER_ID
      ? 'human' : this.requireLedger().getMember(activity.actor)?.handle ?? activity.actor
    // An acceptance concludes the reader's own Claims in two ways: a Claim
    // already finished before the accept was accepted (its work stands), and
    // a still-open Claim the accept completed atomically (no further work is
    // needed). Both must be said plainly, or the owner keeps working on a
    // done Task or never learns its contribution was accepted.
    if (activity.kind === 'accept' && activity.actor === AGENT_TEAM_HUMAN_MEMBER_ID && readerId !== undefined) {
      const acceptedOwn = (activity.acceptedClaimRefs ?? []).filter(claimRef => this.requireLedger().getClaim(claimRef)?.owner === readerId)
      const completedOwn = (activity.completedClaimRefs ?? []).filter(claimRef => this.requireLedger().getClaim(claimRef)?.owner === readerId)
      // The early-accept-only reader holds no finished Claim: every own Claim
      // was completed atomically, so the "finished Claim" clause's ref list
      // would be empty. Render the completed semantics alone instead of a
      // sentence with a dangling empty list.
      const finishedOwn = acceptedOwn.filter(claimRef => !completedOwn.includes(claimRef))
      if (completedOwn.length > 0 && finishedOwn.length > 0) {
        return `Team Task update\n${actor} accepted Task ${activity.taskRef}. Your Claim ${completedOwn.join(', ')} was completed with the acceptance, and your finished Claim ${finishedOwn.join(', ')} was accepted. No further work is needed.`
      }
      if (completedOwn.length > 0) {
        return `Team Task update\n${actor} accepted Task ${activity.taskRef} and your open Claim ${completedOwn.join(', ')} was completed with it. No further work is needed.`
      }
      if (acceptedOwn.length > 0) {
        return `Team Task update\n${actor} accepted Task ${activity.taskRef}; your finished Claim ${acceptedOwn.join(', ')} was accepted. No further work is needed.`
      }
    }
    if (activity.kind === 'claim' || activity.kind === 'done' || activity.kind === 'release') {
      return `Team Task update\n${actor} ${activity.kind} Claim ${activity.claimRef} on Task ${activity.taskRef}.`
    }
    if (activity.kind === 'claims_released') {
      return `Team Task update\n${actor}'s Claims ${activity.claimRefs.join(', ')} were released on Task ${activity.taskRef}.`
    }
    if (activity.kind === 'promote') {
      return `Team Task update\n${actor} created Task ${activity.taskRef} from Thread ${activity.threadRef}; it is open for claims.`
    }
    const released = 'releasedClaimRefs' in activity && activity.releasedClaimRefs !== undefined && activity.releasedClaimRefs.length > 0
      ? ` Released Claims: ${activity.releasedClaimRefs.join(', ')}.` : ''
    return `Team Task update\n${actor} ${activity.kind} Task ${activity.taskRef}.${released}`
  }

  /** Dispose one live Member Session and drop its per-Member runtime state. */
  private async disposeMemberSession(memberId: AgentTeamMemberId, member: Pick<AgentTeamAgentMember, 'memberId' | 'sessionId'>): Promise<void> {
    this.clearMemberRecoveryState(member)
    const handle = this.handles.get(memberId)
    if (handle !== undefined) {
      // Disposal cancels the Member's turn and then waits for the Agent to
      // quiesce, session write path included: that is external execution, not
      // the Member's own turn, so it logs under its own stage.
      await this.waitLogged('wait-external', { label: this.memberLabel(memberId), sessionId: member.sessionId },
        'for the Agent to release its Session write path',
        () => this.disposeWithWakeGuard(handle))
      this.handles.delete(memberId)
    }
    this.memberBySessionId.delete(member.sessionId)
    this.modelSelections.delete(memberId)
    this.memberRuntime.forgetMember(memberId)
    this.clearMemberFailure(memberId, 'activation')
    this.clearMemberFailure(memberId, 'preTurnCancellation')
  }

  private clearMemberRecoveryState(member: Pick<AgentTeamAgentMember, 'memberId' | 'sessionId'>): void {
    this.recovery.stopTracking(member.memberId, 'session-disposed')
    this.clearMemberFailure(member.memberId, 'runtime')
    this.clearMemberFailure(member.memberId, 'preTurnCancellation')
    this.clearMemberNotificationState(member.memberId)
  }

  /** Forget a Member's notice delivery entirely: a new generation starts over. */
  private clearMemberNotificationState(memberId: AgentTeamMemberId): void {
    this.inboxNoticeDeliveries.delete(memberId)
  }

  /**
   * Record that the queued notice now answers these facts, keeping the attempt
   * count: what was delivered is settled, but the delivery work is the same
   * continuing effort.
   */
  private coverInboxFacts(memberId: AgentTeamMemberId, covered: string): void {
    this.inboxNoticeDeliveries.set(memberId, { covered, attempt: this.inboxNoticeDeliveries.get(memberId)?.attempt ?? 0 })
  }

  /**
   * Spend one delivery attempt and mark the facts it covers. The count rises
   * before the attempt runs, so a failed wake still reports the attempt it
   * really spent.
   */
  private beginInboxDelivery(memberId: AgentTeamMemberId, covered: string): number {
    const attempt = (this.inboxNoticeDeliveries.get(memberId)?.attempt ?? 0) + 1
    this.inboxNoticeDeliveries.set(memberId, { covered, attempt })
    return attempt
  }

  /**
   * Drop the fact coverage while keeping the attempt count: the same durable
   * facts are still undealt with, so the next commit rederives and retries
   * them as the next attempt rather than as a fresh delivery.
   */
  private dropInboxCoverage(memberId: AgentTeamMemberId): void {
    const delivery = this.inboxNoticeDeliveries.get(memberId)
    if (delivery !== undefined) this.inboxNoticeDeliveries.set(memberId, { covered: '', attempt: delivery.attempt })
  }

  /**
   * Wake waiters for one committed or lifecycle change. Undefined broadcasts
   * to everyone; an empty scope list invalidates nobody because no shared
   * projection changed; otherwise global and matching scoped waiters wake.
   * Presence-only scopes sit outside that: they change no durable projection,
   * so only matching presence waiters wake and the scope-less Inbox
   * subscriptions stay parked.
   *
   * Each woken waiter receives the version of its own scope's domain, so a
   * wake can never hand a projection waiter a presence number or the other way
   * around. Nothing here advances the projection version.
   */
  private emitChanged(scopes?: readonly AgentTeamChangeScope[]): void {
    const touchesProjection = scopes === undefined || scopes.some(scope => scope.kind !== 'presence')
    const touchesPresence = scopes !== undefined && scopes.some(scope => scope.kind === 'presence')
    if (!touchesProjection && !touchesPresence) return
    if (touchesPresence) this.presenceEpoch += 1
    for (const waiter of this.changeWaiters) {
      const waiterScope = waiter.scope
      if (scopes !== undefined && (waiterScope === undefined ? !touchesProjection : !scopes.some(scope => sameChangeScope(scope, waiterScope)))) continue
      waiter.wake(this.changeVersionOf(waiterScope))
    }
  }

  /**
   * The cursor domain of one scope: presence scopes count process-local edge
   * wakes, every other scope compares against the durable ledger position of
   * the newest shared-projection commit. The two domains are deliberately
   * separate, so a presence edge cannot invalidate a projection subscriber and
   * a private read invalidates no one.
   */
  private changeVersionOf(scope: AgentTeamChangeScope | undefined): number {
    if (scope?.kind === 'presence') return this.presenceEpoch
    return this.ledger?.projectionSequence() ?? 0
  }

  private validateChangeScope(scope: AgentTeamChangeScope | undefined): AgentTeamChangeScope | undefined {
    if (scope === undefined) return undefined
    const ref = scope.kind === 'workspace' || scope.kind === 'presence' ? scope.workspaceId : scope.kind === 'channel' ? scope.channelRef : scope.threadRef
    if (typeof ref !== 'string' || ref.length === 0) throw new Error(`change scope of kind '${scope.kind}' requires a non-empty ref`)
    return scope
  }

  /** Serialize one Member's lifecycle operations in submission order; a long wait inside one holds only this chain. */
  private enqueueLifecycle<T>(memberId: AgentTeamMemberId, operation: () => Promise<T>): Promise<T> {
    return this.chainLifecycle(this.memberLifecycleTails, this.enteredMemberChains, memberId, operation)
  }

  /** Serialize lifecycle operations against a Member id that does not exist until the commit answers: concurrent duplicates of one add request. */
  private enqueueAddition<T>(requestId: AgentTeamRequestId, operation: () => Promise<T>): Promise<T> {
    return this.chainLifecycle(this.additionLifecycleTails, this.enteredAdditionChains, requestId, operation)
  }

  private chainLifecycle<K extends string, T>(tails: Map<K, Promise<void>>, entered: AsyncLocalStorage<ReadonlySet<K>>, key: K, operation: () => Promise<T>): Promise<T> {
    this.requireAccepting()
    if (entered.getStore()?.has(key) === true) return operation()
    const previous = tails.get(key) ?? Promise.resolve()
    const result = previous.then(() => entered.run(new Set([...entered.getStore() ?? [], key]), operation))
    const tail = result.then(() => {}, () => {})
    tails.set(key, tail)
    // Prune settled chains so a removed Member leaves nothing behind; a newer
    // chain on the same key keeps its own entry.
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
    return result
  }
}

export function lastActivityTime(events: readonly SessionEvent[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const time = events[index]?.time
    if (typeof time === 'number' && Number.isFinite(time)) return time
  }
  return null
}

export function logEventsOf(agent: Agent): readonly SessionEvent[] | undefined {
  try {
    return agent.session.ownEvents()
  } catch {
    return undefined
  }
}
