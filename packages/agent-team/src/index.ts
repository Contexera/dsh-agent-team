/**
 * Durable Agent Team Host capability.
 *
 * The Host owns the append-only collaboration ledger and all Member lifecycle
 * effects. Session history and browser state are projections, never Team facts.
 * @module @wowyuarm/dsh-agent-team
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-app-boot'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-tools'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@wowyuarm/dsh-jev'
import { ATTACHMENT_MAX_BYTES, attachmentPayloadPath, attachmentsRoot, copyPathAttachment, pathAttachmentId, readAttachment, removeAttachment, sanitizeMediaType, sweepAttachmentCache, validatePathAttachment, writeRequestScopedAttachment } from './attachments.ts'
import { reportEnvironment } from './environment-check.ts'
import { HUMAN_PROFILE_DEFAULT_NAME, HUMAN_PROFILE_REPO_URL, HUMAN_PROFILE_SETTINGS_NAMESPACE, HUMAN_PROFILE_SETTINGS_SCHEMA, HUMAN_PROFILE_VERSION, assertValidHumanName, normalizeHumanName, parseLegacyHumanProfile, planLegacyAdoption, type LegacyHumanProfileFields } from './human-profile.ts'
import { humanAvatarsRoot, readHumanAvatar, removeHumanAvatar, writeHumanAvatar } from './human-avatar.ts'
import { createHumanUpdateChecker } from './human-update-check.ts'
import { AgentTeamInvariantError } from './invariant.ts'
import { createTeamContextManagement, TeamPressurePolicy, TEAM_CONTEXT_CODEC, TEAM_PRESSURE_GATE_SCHEMA } from './context-continuity-host.ts'
import { CONTEXT_CONTINUITY_PROJECTION_KEY, DEFAULT_GATE_IDLE_MS, DEFAULT_GATE_JUDGE_TIMEOUT_MS, DEFAULT_GATE_TOKENS, readContextTimeline, type ContextProjectionConfig, type ContextTimelineItem, type ContextTimelineSource, type PressureGate, type TransitionPlan } from '@wowyuarm/dsh-context-continuity'
import { TeamContextJudge, type TeamContextJudgeConfig } from './context-judge.ts'
import { AGENT_TEAM_PLUGIN_ID, isAgentTeamSource } from './context-source.ts'
import { boundaryByRef, carriedInputOf, checkpointByRef, checkpointRefFor, createTeamContextProjectionConfig, createTeamContextProjectionDefinition, foldTeamContextProjection, retainedTopicsThrough, TeamContextProjectionHost } from './context-projection.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID, AgentTeamLedger, agentTeamHumanActor, type AgentTeamDurableMemberResult } from './ledger.ts'
import { AGENT_TEAM_TOOL_NAMES, deepCopyCapabilities, memberMemoryDirectoryName, MemberRuntime } from './member-runtime.ts'
import type { MemberSkillSelectionRef } from './member-skills.ts'
import { classifyRecoverableError, RecoveryCoordinator, RECOVERY_MAX_CONSECUTIVE_ERRORS } from './recovery.ts'
import { StoredSessionReadError, StoredSessionReader, sessionFailureOf } from './stored-session-reader.ts'
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
  AgentTeamContextCheckpointRef,
  AgentTeamContextJudgeRequest,
  AgentTeamContextJudgeResult,
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
  AgentTeamJoinChannelRequest,
  AgentTeamJoinChannelResult,
  AgentTeamJoinWorkspaceRequest,
  AgentTeamJoinWorkspaceResult,
  AgentTeamLeaveWorkspaceRequest,
  AgentTeamLeaveWorkspaceResult,
  AgentTeamHumanActor,
  AgentTeamMemberActor,
  AgentTeamMessageAttachment,
  AgentTeamMemberId,
  AgentTeamMemberResult,
  AgentTeamMembersRequest,
  AgentTeamResolveTaskRefsRequest,
  AgentTeamResolveTaskRefsResult,
  AgentTeamResolveThreadRefsRequest,
  AgentTeamResolveThreadRefsResult,
  AgentTeamTaskRef,
  AgentTeamThreadRef,
  AgentTeamOperationReceipt,
  AgentTeamPromoteThreadRequest,
  AgentTeamPromoteThreadResult,
  AgentTeamPutAttachmentRequest,
  AgentTeamPutAttachmentResult,
  AgentTeamRecoverMemberRequest,
  AgentTeamRecoverMemberResult,
  AgentTeamClearMemberContextRequest,
  AgentTeamClearMemberContextResult,
  AgentTeamRolloverSessionRequest,
  AgentTeamDmRequest,
  AgentTeamDmResult,
  AgentTeamOperationId,
  AgentTeamRemoveChannelMemberRequest,
  AgentTeamRemoveChannelMemberResult,
  AgentTeamRequestId,
  AgentTeamRemoveMemberRequest,
  AgentTeamRemoveMemberResult,
  AgentTeamReplyRequest,
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
  AgentTeamContextAdvice,
  AgentTeamMemberDiagnostic,
  AgentTeamThreadObservations,
  AgentTeamThreadObservationsRequest,
  AgentTeamUpdateChannelRequest,
  AgentTeamUpdateChannelResult,
  AgentTeamUpdateMemberRequest,
  AgentTeamView,
  AgentTeamViewRequest,
} from './types.ts'

export { agentTeamDomainSpec, agentTeamOperationSchema } from './spec.ts'
export type * from './types.ts'
export { AGENT_TEAM_HUMAN_HANDLE, AGENT_TEAM_HUMAN_MEMBER_ID, AGENT_TEAM_INITIALIZE_REQUEST_ID } from './ledger.ts'
export { HUMAN_PROFILE_DEFAULT_NAME, HUMAN_PROFILE_REPO_URL, HUMAN_PROFILE_SETTINGS_NAMESPACE, HUMAN_PROFILE_SETTINGS_SCHEMA, HUMAN_PROFILE_VERSION, assertValidHumanName, normalizeHumanName } from './human-profile.ts'
export { humanAvatarsRoot } from './human-avatar.ts'
export { AGENT_TEAM_TOOL_NAMES } from './member-runtime.ts'

/** Process-stable marker carried by the final Team message tool definition. */
export const AGENT_TEAM_PRESET_MARKER = Symbol.for('@wowyuarm/dsh-agent-team.preset')


const INBOX_NOTICE_SUMMARY = 'Team Inbox has unread work.'
const RECOVERY_NOTICE_SUMMARY = 'Recovery: continue your interrupted work.'
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

/** Longest accepted model-supplied checkpoint display name. */
const MAX_CHECKPOINT_NAME_CHARS = 120
/** Default and maximum number of timeline items one query returns. */
const DEFAULT_TIMELINE_LIMIT = 12
/** The widest timeline window there is; the ref gate reads at this width so no printed ref is unreachable. */
export const MAX_TIMELINE_LIMIT = 24
/**
 * Archived generations the timeline and seed resolution walk: the timeline
 * reads this many ancestors behind the current generation, and the seed guard
 * resolves a cited ref through the same depth, so the two surfaces cannot
 * disagree about where history ends.
 */
const MAX_TIMELINE_ANCESTORS = 8
/** Product pressure budget constants (see docs/team-collaboration/README.md). */
const CONTEXT_HARD_LIMIT_CAP = 256_000
const CONTEXT_HANDOFF_AT_CAP = 200_000
const CONTEXT_HANDOFF_RESERVE = 8_000
const CONTEXT_SAFE_OUTPUT_RESERVE = 16_000
/**
 * Usage at or above which an acknowledged acceptance advises a fresh
 * rollover instead of keeping the context; capped by the route's effective
 * handoff budget so narrow routes get a proportionally earlier boundary.
 */
const ACCEPT_TASK_BOUNDARY_THRESHOLD = 128_000

/** One live invalidation subscription, restricted to its declared scope. */
interface ChangeWaiter {
  readonly scope: AgentTeamChangeScope | undefined
  wake(version: number): void
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

/** Tool-side request for one context rollover; the Host validates without side effects. */
export interface AgentTeamNewContextToolRequest {
  readonly memberId: AgentTeamMemberId
  /** Selected checkpoint ref from `context_status`; absent means fresh. */
  readonly checkpointRef?: AgentTeamContextCheckpointRef
  readonly relatedFiles?: readonly { readonly path: string; readonly reason: string }[]
}

/** Tool-side validation outcome: which rollover mode a successful call will take. */
export interface AgentTeamNewContextToolOutcome {
  readonly mode: 'fresh' | 'from-checkpoint'
}

/** Tool-side request for one explicit checkpoint; the Host validates without side effects. */
export interface AgentTeamCheckpointToolRequest {
  readonly memberId: AgentTeamMemberId
  /** Provider-issued call id of this tool call; the stable ref derives from it. */
  readonly callId: string
  readonly name: string
}

/** Tool-side checkpoint validation outcome: the deterministic ref the result will carry. */
export interface AgentTeamCheckpointToolOutcome {
  readonly checkpointRef: AgentTeamContextCheckpointRef
  readonly name: string
}

/** Tool-side request for the bounded structural context timeline. */
export interface AgentTeamTimelineToolRequest {
  readonly memberId: AgentTeamMemberId
  readonly limit?: number
}

/** One structural timeline item: a checkpoint or boundary candidate with pricing. */
export interface AgentTeamTimelineItem {
  /** Opaque stable ref; the selection surface for `context_rollover.checkpointRef`. */
  readonly checkpointRef: string
  /** Semantic label: the model-supplied checkpoint name or boundary label. */
  readonly name: string
  /** Which structural source produced this item. */
  readonly source: 'agent' | 'team-boundary' | 'handoff' | 'compaction' | 'head'
  /** Approximate tokens a return would retain (the prefix through this anchor). */
  readonly retainedTokens: number
  /** Approximate tokens a return would discard (the suffix after this anchor). */
  readonly discardedTokens: number
  /**
   * Threads whose facts entered this Session's model context by this anchor
   * (delivered Team notices only — never unread ledger activity). Empty when
   * nothing attributable was delivered.
   */
  readonly affectedThreads: readonly string[]
  /** Whether `context_rollover` accepts this ref as a seed target. */
  readonly restorable: boolean
  /** When not restorable, the concise reason. */
  readonly reason?: string
  /** Session the candidate anchors in; present for non-current-generation sources. */
  readonly sourceSessionId?: SessionId
}

/** Tool-side timeline outcome: usage plus the bounded structural candidate list. */
export interface AgentTeamTimelineToolResult {
  readonly usageTokens: number
  readonly hardLimit: number
  readonly handoffAt: number
  readonly items: readonly AgentTeamTimelineItem[]
  /**
   * The unreadable ancestor that ended the lineage walk early, when one did:
   * history is complete through the last listed source and provably absent
   * beyond it. Never a Member-availability fact.
   */
  readonly incompleteFrom?: { readonly sessionId: SessionId; readonly reason: string }
}

/** One resolved checkpoint seed: the exact balanced prefix plus its source. */
interface CheckpointSeed {
  readonly checkpointRef: AgentTeamContextCheckpointRef
  /** Session the checkpoint was recorded in; the child's lineage parent. */
  readonly sourceSessionId: SessionId
  /** Exclusive end of the seed prefix: its exact length in the source log. */
  readonly sourceThroughSeq: SessionLogOffset
  /** Contiguous events from seq 0 through the checkpoint's completed turn. */
  readonly prefix: readonly SessionEvent[]
}

/**
 * Config of the Team Host row: the Human profile (see human-profile.ts), the
 * long-gap gate's thresholds, and the judge those thresholds are applied to.
 * The settings service derives every form from the owning plugin's Config, so
 * the profile is this plugin's own config rather than a section of its own.
 *
 * Two kinds of field live here. Volatile ones — the profile and the judge's own
 * settings — are what the settings service offers a form for and what an edit
 * reaches live, without remounting the Host. The gate's thresholds are the
 * other kind: policy read once when the row mounts, so they stay non-volatile,
 * no settings form offers them, and a deployment states them in its own patch
 * layer.
 */
export interface Config {
  name: Volatile<string>
  avatarRef: Volatile<string | undefined>
  /** Long-gap gate thresholds; an omitted field keeps the engine's default. */
  readonly gate: PressureGate
  /** The relatedness judge's own settings; a key here is what mounts it. */
  readonly jev: TeamJudgeSettings
}

/** The Host row's `jev` fields, as the settings service reads and writes them. */
export interface TeamJudgeSettings {
  /** The API key itself; secret on read, and the switch that mounts the judge. */
  apiKey: Volatile<string | undefined>
  /** The environment variable holding the key, when it is not stated here. */
  apiKeyEnv: Volatile<string | undefined>
  /** The model id sent with every judgement. */
  model: Volatile<string | undefined>
  /** The endpoint base the judgements go to. */
  apiBase: Volatile<string | undefined>
}

/**
 * The judge's fields as one row form. Every one is volatile, because that is
 * what makes the settings service offer them and what lets a key written in the
 * Team settings surface mount the judge without restarting the Host; the key
 * alone is a secret, so a read reports that it is set and never its value.
 */
const TEAM_JUDGE_SETTINGS_SCHEMA = z.object({
  apiKey: z.string().role('secret').volatile().description('API key for the relatedness judge. Setting one enables jev-backed context management; clearing it disables it.'),
  apiKeyEnv: z.string().volatile().description('Environment variable holding the key, when the key is not stated here. Default: TYPESAFE_API_KEY'),
  model: z.string().volatile().description('Model id sent with every judgement. Default: the jev plugin\'s own default.'),
  apiBase: z.string().volatile().description('Endpoint base the judgements go to. Default: the jev plugin\'s own default.'),
})

/**
 * The Host row's whole schema: the profile fields verbatim, so their volatility
 * and defaults stay owned by {@link HUMAN_PROFILE_SETTINGS_SCHEMA}, plus the
 * gate and the judge. A patch layer that targets this row replaces its whole
 * config, so the parts are declared together here and nowhere else.
 */
export const TEAM_HOST_ROW_SETTINGS_SCHEMA = z.object({
  ...HUMAN_PROFILE_SETTINGS_SCHEMA.dict,
  gate: TEAM_PRESSURE_GATE_SCHEMA,
  jev: TEAM_JUDGE_SETTINGS_SCHEMA,
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
    // Deferred field access: the constructor runs before `handles` is
    // populated, so the resolver must dereference at call time.
    ctx: this.ctx,
    liveMemberContext: memberId => {
      const handle = this.handles.get(memberId)
      if (handle === undefined) throw new Error(`Agent Member '${this.memberLabel(memberId)}' has no live session for a tool-policy update`)
      return handle.agent.ctx
    },
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
    /** Last non-busy automatic-compaction failure; entered transactions retain additional Session history. */
    compaction?: string
  }>()
  private readonly pressurePolicy: TeamPressurePolicy
  /** The long-gap gate's judge: this Host's own `jev` mount, reconciled with the row. */
  private readonly contextJudge: TeamContextJudge
  private readonly notifiedInbox = new Map<AgentTeamMemberId, string>()
  private attachmentGcTimer?: ReturnType<typeof setInterval> | undefined
  /**
   * New-release check behind the settings footnote. Memory-only and
   * background-refreshed, so the profile read path never waits on the
   * network and every failure settles as "no update known".
   */
  private readonly humanUpdateCheck = createHumanUpdateChecker({ currentVersion: HUMAN_PROFILE_VERSION })

  private readonly recovery = new RecoveryCoordinator({
    wake: memberId => {
      this.ctx.logger.info(`agent-team: automatic recovery wakeup for member '${this.memberLabel(memberId)}' after consecutive recoverable failures`)
      this.injectRecovery(memberId)
    },
    onStandDown: (memberId, consecutiveFailures) => {
      this.ctx.logger.warn(`agent-team: member '${this.memberLabel(memberId)}' reached ${consecutiveFailures}/${RECOVERY_MAX_CONSECUTIVE_ERRORS} consecutive recoverable failures; leaving it in error for the operator`)
    },
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
  /**
   * Context self-management: the one deep module that turns a Member's
   * successful `context_rollover` tool result into its next private context
   * generation. The ledger owns the binding audit, the engine's projection
   * unit owns intent, and this coordinator owns only reconstructible process
   * state. See docs/architecture/README.md and docs/team-collaboration/README.md.
   */
  private readonly contextManagement = createTeamContextManagement({
    agentForMember: memberId => this.handles.get(memberId)?.agent,
    memberForAgent: agent => this.memberForAgent(agent),
    projectionForMember: (memberId, sessionId) => {
      const handle = this.handles.get(memberId)
      if (handle === undefined || handle.agent.session.id !== sessionId) return undefined
      // The engine's registered unit folds this Session's durable log (replay
      // on attach, then incrementally per committed event) and keys every ref
      // to the Session that recorded it; the registry materializes the cell
      // lazily, so a Member that has not folded yet is built on this read.
      return this.ctx.sessionProjections.stateOf(handle.agent.session, CONTEXT_CONTINUITY_PROJECTION_KEY)
    },
    executeTransition: (memberId, plan) => this.executeMemberTransition(memberId, plan),
    log: message => { this.ctx.logger.warn(`agent-team: ${message}`) },
  })
  private lifecycleTail: Promise<void> = Promise.resolve()
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
    this.contextJudge = new TeamContextJudge(this.ctx, {
      config: () => this.judgeConfig(),
      deadlineMs: () => this.config.gate.judgeTimeoutMs ?? DEFAULT_GATE_JUDGE_TIMEOUT_MS,
    })
    this.pressurePolicy = new TeamPressurePolicy({
      agentForMember: memberId => this.handles.get(memberId)?.agent,
      limitsForAgent: agent => this.routeLimitsForAgent(agent),
      compactionForAgent: agent => {
        const engine = this.compactionForAgent(agent)
        return engine === undefined ? undefined : { reduce: (reason, signal) => engine.compactIfNeeded(agent, reason, signal) }
      },
      activeClaimLabels: memberId => this.activeClaimLabels(memberId),
      runningJobLabels: memberId => this.runningJobLabels(memberId),
      // Deployment policy, read once at mount: the row's own gate config, whose
      // omitted fields the engine answers with its own defaults.
      gate: this.config.gate,
      /**
       * The relatedness judge of the long-gap gate: the service this Host
       * mounts from its own row's key, or one a deployment mounted itself. No
       * key and no other mount leaves the gate off — a missing judge is a
       * deployment choice, never a failure — and the read is lazy, so a key
       * written after this Host mounted still answers on the next step.
       */
      judgeForAgent: () => this.contextJudge.judge(),
      failed: (memberId, diagnostic) => {
        this.setMemberFailure(memberId, 'compaction', diagnostic)
        this.emitAutoCompactionChanged(memberId)
      },
      log: (message, memberId) => { this.ctx.logger.warn(`agent-team: ${message} (member ${this.memberLabel(memberId)})`) },
    })
    // Human profile: this Host row's own Config (name + avatarRef, both
    // volatile), so the settings service derives its form from the schema and
    // an edit lands in the running plugin without a remount. Team's own page
    // owns that surface, so the row declares itself presentation-owned rather
    // than schema-page owned. Reads go straight to the live Config reference;
    // this subscription is the change signal the retired section hook used to
    // be — the ledger's runtime @ handle follows every edit.
    this.ctx.inject(['settings'], settingsCtx => {
      settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, this.ctx.fiber))
      this.adoptLegacyHumanProfile()
    })
    this.ctx.on('loader/volatile-update', () => {
      this.syncHumanHandle()
      // The judge's key and endpoint ride the same volatile row, so every write
      // the settings surface makes is one reconciliation: mount on a new key,
      // re-configure on a changed endpoint, unmount when the key is cleared.
      void this.contextJudge.sync().catch(error => {
        this.ctx.logger.warn('agent-team: the relatedness judge could not be reconciled: %s', error instanceof Error ? error.message : String(error))
      })
    })
  }

  /** The Host row's judge settings, as one plain config for the mount. */
  private judgeConfig(): TeamContextJudgeConfig {
    return {
      apiKey: this.config.jev.apiKey.get(),
      apiKeyEnv: this.config.jev.apiKeyEnv.get(),
      model: this.config.jev.model.get(),
      apiBase: this.config.jev.apiBase.get(),
    }
  }

  /** Current human display name; the single source for team_view and @ matching. */
  humanHandle(): string {
    const name = normalizeHumanName(this.config.name.get())
    return name === '' ? HUMAN_PROFILE_DEFAULT_NAME : name
  }

  /** Current human profile reference held in this Host row's Config (name + avatarRef). */
  humanProfile(): { readonly name: string; readonly avatarRef?: string | undefined } {
    const avatarRef = this.config.avatarRef.get()
    return Object.freeze({ name: this.humanHandle(), ...(avatarRef === undefined ? {} : { avatarRef }) })
  }

  /** Push the current Config name into the ledger's runtime @ handle. */
  private syncHumanHandle(): void {
    try {
      this.ledger?.setHumanDisplayHandle(this.humanHandle())
    } catch {
      // The ledger is absent before Service.init; the post-open sync covers it.
    }
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
    // The judge is mounted from the row's own key before the first step can be
    // judged: a deployment that states one gets the gate from its first turn,
    // and one that states none keeps the gate off without a failure.
    await this.contextJudge.sync()
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
      const kind = classifyRecoverableError(error)
      if (kind !== undefined) this.ctx.logger.warn(`agent-team: member '${member.handle}' hit a recoverable ${kind} error; recording a consecutive error occurrence`)
      this.recovery.onError(member.memberId, error)
      this.emitMemberPresenceChanged(member)
    })
    this.ctx.on('agent/status', ({ agent, status }) => {
      const member = this.memberForAgent(agent)
      if (status === 'running') this.runningAgents.add(agent.id)
      else this.runningAgents.delete(agent.id)
      if (status === 'running' && member !== undefined) {
        const recovered = this.clearMemberFailure(member.memberId, 'runtime')
        if (recovered) this.notifiedInbox.delete(member.memberId)
        this.emitMemberPresenceChanged(member)
        // A rollover/recovery in flight delivers its own sequenced
        // rederived Inbox after the handoff and carried input; a status-driven
        // steer here would claim the handoff turn's next step and leapfrog
        // the carried messages.
        if (!this.contextManagement.isTransitioning(member.memberId)) this.notifyMember(agent)
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
      // A successful assistant response ends any open provider-overflow
      // recovery sequence for this Member.
      if (event.type === 'assistant/message') this.pressurePolicy.onAssistantMessage(memberId)
      // Context management reacts only after a successful durable tool/result;
      // the projection (not this listener) decides what that means.
      this.contextManagement.onSessionEvent(memberId, handle.agent, event)
    })
    const domain = await this.ctx.storageDomain.open(agentTeamDomainSpec)
    this.ctx.effect(() => async () => {
      this.accepting = false
      this.recovery.dispose()
      this.contextManagement.dispose()
      this.pressurePolicy.dispose()
      if (this.attachmentGcTimer !== undefined) clearInterval(this.attachmentGcTimer)
      this.attachmentGcTimer = undefined
      this.emitChanged()
      await this.lifecycleTail
      await Promise.all([...this.handles.values()].map(handle => handle.dispose()))
      this.handles.clear()
      this.modelSelections.clear()
      this.memberRuntime.disposeAll()
      this.runningAgents.clear()
      await domain.close()
    }, 'agentTeam.dispose')
    this.domain = domain
    const ledger = new AgentTeamLedger(domain.table('operations'))
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
    return this.enqueueLifecycle(async () => {
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
    return this.enqueueLifecycle(async () => {
      const result = await this.requireLedger().suspendMember({ ...request, actor: agentTeamHumanActor() })
      if (result.committed) this.emitCommitted(result.value.receipt)
      await this.convergeMemberEffects(result.value.member)
      return Object.freeze({ receipt: result.value.receipt, status: this.memberStatus(result.value.member) })
    })
  }

  /** Commit enabled intent and restore the exact persisted Session. */
  async resumeMember(request: AgentTeamSetMemberStateRequest): Promise<AgentTeamMemberResult> {
    return this.enqueueLifecycle(async () => {
      const result = await this.requireLedger().resumeMember({ ...request, actor: agentTeamHumanActor() })
      if (result.committed) this.emitCommitted(result.value.receipt)
      this.clearMemberNotificationState(result.value.member.memberId)
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
    this.recovery.stopTracking(request.memberId)
    const handle = this.handles.get(request.memberId)
    // A committed renewal or rollover whose retire or activation never finished
    // is what leaves a Member with no live generation on its binding, or with
    // the retired generation still live: this explicit recovery path finishes
    // that recorded transition rather than restarting a Session the ledger has
    // already moved off. Every other stranded case keeps its old behavior.
    const stranded = handle === undefined || handle.agent.id !== member.sessionId
    if (stranded && member.state === 'enabled' && this.requireLedger().lastTransitionForMember(request.memberId) !== undefined) {
      this.ctx.logger.info(`agent-team: finishing the recorded Session transition for member '${member.handle}'`)
      const settled = await this.enqueueLifecycle(async () => {
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
      this.ctx.logger.info(`agent-team: finishing the interrupted ${member.state} cleanup for member '${member.handle}'`)
      const settled = await this.enqueueLifecycle(async () => {
        await this.convergeMemberEffects(member)
        return this.requireLedger().getMember(request.memberId) ?? member
      })
      return Object.freeze({ status: this.memberStatus(settled) })
    }
    // An orphaned composition cannot be steered: its tools are gone, so a
    // continuation prompt reaches an inert Member. Rebuild the Agent in place.
    if (handle !== undefined && this.ctx.agentPresets.composedPreset(handle.agent.ctx) === undefined) {
      this.ctx.logger.info(`agent-team: rebuilding member '${member.handle}' after its preset composition was orphaned by a reload`)
      await this.reactivateMember(request.memberId)
      return Object.freeze({ status: this.memberStatus(member) })
    }
    // A failed activation also leaves nothing to steer; re-running it is the
    // only way back. A renewed failure stays non-throwing: the refreshed
    // status carries the activation diagnostic for the sidebar.
    if (handle === undefined) {
      if (member.state !== 'enabled') throw new Error(`Agent Member '${member.handle}' is ${member.state}; only enabled Members can be restarted`)
      this.ctx.logger.info(`agent-team: restarting member '${member.handle}' after a failed activation`)
      // There is no write-side repair pass anymore: dsh 0.1.7 converts the
      // released V3 history at read time, and this bundle no longer authors
      // the old wrapper shape, so a refusal stays a deterministic failure the
      // retry reports again rather than something the restart heals.
      await this.reactivateMember(request.memberId)
      return Object.freeze({ status: this.memberStatus(member) })
    }
    this.ctx.logger.info(`agent-team: operator asked member '${member.handle}' to resume`)
    this.steerResume(member, this.manualResumeText())
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
    return this.enqueueLifecycle(async () => {
      this.requireAccepting()
      this.requireWorkspace(request.workspaceId)
      const stored = this.requireLedger().getMember(request.memberId)
      if (stored === undefined || !this.requireLedger().participatesIn(request.memberId, request.workspaceId)) throw new Error(`unknown Member '${request.memberId}' in workspace '${request.workspaceId}'`)
      if (stored.state !== 'enabled') throw new Error(`Agent Member '${stored.handle}' is ${stored.state}; only enabled Members can start from a new context`)
      // The fresh id derives from the requestId, so a retried identical
      // request mints the same id and the ledger dedupes it instead of
      // colliding; the format matches addMember's `agent-team-<uuid>`.
      const sessionId = SessionId(`agent-team-${request.requestId}`)

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
   * the handoff-reconstruction path. Startup, retry, and explicit recovery
   * therefore leave it unset; only the request that committed the transition
   * supplies it.
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
    if (!this.ctx.workspaceRegistry.archivedSessionIds.includes(transition.previousSessionId)) {
      await this.ctx.workspaceRegistry.archiveSession(transition.previousSessionId)
    }
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
   * Agent, and archive the old Session log (which stays on disk for history).
   * Shared by the Human clear path and the model-initiated rollover.
   */
  private async retireMemberGeneration(memberId: AgentTeamMemberId, active: AgentHandle, previousSessionId: SessionId): Promise<void> {
    // Drop the old handle's transient state: pending recovery episodes and
    // error markers belong to the disposed agent, not to the Member.
    this.recovery.stopTracking(memberId)
    // The context admission gate stays armed through disposal: input racing
    // the retire window must still be captured for the new generation, and
    // the coordinator drops its own bookkeeping only after the swap settles.
    this.memberBySessionId.delete(previousSessionId)
    await active.dispose()
    this.handles.delete(memberId)
    this.modelSelections.delete(memberId)
    this.memberRuntime.forgetMember(memberId)
    this.clearMemberFailure(memberId, 'activation')
    this.clearMemberNotificationState(memberId)
    // The previous log survives on disk; archiving hides it from every
    // grouping surface so one Member keeps exactly one visible Session.
    await this.ctx.workspaceRegistry.archiveSession(previousSessionId)
  }

  /**
   * Execute one prepared context rollover at a true idle boundary: commit the
   * idempotent Member-actor operation, retire the previous generation, and
   * activate the fresh Session whose first model-facing context is the
   * Member's own handoff. Later non-Team input captured during the transition
   * is delivered after the handoff; the Team Inbox is rederived from the
   * ledger, never copied.
   */
  private async executeMemberTransition(memberId: AgentTeamMemberId, plan: TransitionPlan): Promise<void> {
    await this.enqueueLifecycle(async () => {
      this.requireAccepting()
      const stored = this.requireLedger().getMember(memberId)
      if (stored === undefined || stored.state !== 'enabled') throw new Error(`Agent Member '${memberId}' cannot roll over: not enabled`)
      if (stored.sessionId !== plan.previousSessionId) throw new Error(`Agent Member '${stored.handle}' is no longer bound to the rolled-over Session`)
      const active = this.handles.get(memberId)
      if (active === undefined) throw new Error(`Agent Member '${stored.handle}' has no active session to roll over`)
      // A racing turn the admission gate rejects still leaves the Agent
      // momentarily running; wait for its convergence instead of failing the
      // swap — the gate guarantees it spends no model request.
      if (this.runningAgents.has(active.agent.id)) await active.agent.whenIdle()
      if (this.runningAgents.has(active.agent.id)) throw new Error(`Agent Member '${stored.handle}' is still running; the rollover must wait for idle`)
      // Checkpoint return: resolve the seed before committing anything. A
      // violation found here fails the whole swap with the old generation
      // intact — never a guessed seed over a wrong prefix.
      const seed = plan.checkpointRef === undefined ? undefined : await this.resolveCheckpointSeed(memberId, active.agent, plan.checkpointRef as AgentTeamContextCheckpointRef)
      // Recheck the job guard at the lifecycle commit seam: a job may have
      // started or settled after the tool-time validation.
      const blockingJobs = this.ownedJobsBlockingRollover(active.agent)
      if (blockingJobs.length > 0) {
        throw new Error(`the context rollover is refused: this Member now owns jobs that would not survive the switch (${blockingJobs.join(', ')}); collect or stop them, then retry`)
      }
      const rolled = await this.rolloverSessionForAgent(active.agent, {
        // The engine plan carries the host-derived request id as a plain
        // string; Team's rollover operation vocabulary brands it, and the
        // context-continuity host adapter is its only producer.
        requestId: plan.requestId as AgentTeamRolloverSessionRequest['requestId'],
        workspaceId: stored.workspaceId,
        memberId,
        previousSessionId: plan.previousSessionId,
        newSessionId: plan.newSessionId,
        handoffEventSeq: plan.handoffEventSeq as AgentTeamRolloverSessionRequest['handoffEventSeq'],
        trigger: plan.trigger,
        ...(seed === undefined ? {} : { checkpointRef: seed.checkpointRef, sourceSessionId: seed.sourceSessionId, sourceThroughSeq: seed.sourceThroughSeq }),
      })
      // The durable old-log projection is the carried-input truth: after the
      // old Agent retires, fold its final state and take every post-intent
      // non-Team candidate the old generation never answered. The process
      // capture only accelerates; it is unioned by message id, never allowed
      // to override the fold.
      const preRetireCapture = this.contextManagement.drainCapturedInput(memberId)
      await this.retireMemberGeneration(memberId, active, plan.previousSessionId)
      const finalEvents = active.agent.session.ownEvents()
      const finalState = foldTeamContextProjection(
        finalEvents,
        { sessionId: active.agent.session.id, inheritedEventCount: active.agent.session.inheritedEventCount },
        this.contextProjectionHost,
      )
      const foldedCarried = carriedInputOf(finalState, finalEvents)
      const carriedById = new Map(plan.carriedInput.map(message => [message.id, message]))
      for (const message of foldedCarried) carriedById.set(message.id, message)
      for (const message of preRetireCapture) if (!carriedById.has(message.id)) carriedById.set(message.id, message)
      for (const message of this.contextManagement.drainCapturedInput(memberId)) if (!carriedById.has(message.id)) carriedById.set(message.id, message)
      const carriedInput = [...carriedById.values()]
      // A fresh rollover seeds nothing and points the lineage parent at the
      // previous active Session; a checkpoint return seeds the resolved
      // prefix and parents at the seed source Session instead. Activation
      // defers the ordinary Inbox wake so the handoff is guaranteed to be the
      // new generation's first model-facing context.
      const seedEvents = seed === undefined ? undefined : seed.prefix
      await this.activateMember(rolled.member, undefined, undefined, seed === undefined ? plan.previousSessionId : seed.sourceSessionId, {
        deferNotify: true,
        // The prefix is contiguous from seq 0, so its length is exactly the
        // inherited cut the child folds past.
        ...(seedEvents === undefined ? {} : { seed: seedEvents, inheritedEventCount: SessionLogOffset(seedEvents.length) }),
      })
      const reactivated = this.handles.get(memberId)
      if (reactivated === undefined) {
        throw new Error(`Agent Member '${stored.handle}' failed to activate its next context: ${this.memberFailures.get(memberId)?.activation ?? 'unknown error'}`)
      }
      // The handoff is the first model-facing context of the new generation.
      // It rides the step-priority inbox lane (steer) so a later rederived
      // Inbox notice queues behind it instead of preempting it; carried input
      // follows as its own turn, and the Inbox is rederived from ledger facts.
      reactivated.agent.steer(this.contextManagement.handoffMessageFor(plan))
      for (const message of carriedInput) reactivated.agent.followup(message)
      const notifications = this.requireLedger().notificationFacts(rolled.member.memberId)
      if (notifications.length > 0) this.notifyMember(reactivated.agent, carriedInput.length > 0)
    })
  }

  /** Ledger handle for log lines; falls back to the raw id when unknown. */
  private memberLabel(memberId: AgentTeamMemberId): string {
    return this.ledger?.getMember(memberId)?.handle ?? memberId
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
   * Steer one continuation message into a Member's live session. Throws when
   * no handle exists so the coordinator stops tracking; appends the inbox
   * snapshot whenever there is anything new to read.
   */
  private steerResume(member: AgentTeamAgentMember, text: string): void {
    const handle = this.handles.get(member.memberId)
    if (handle === undefined) throw new Error(`member '${member.handle}' has no active session`)
    const notifications = this.requireLedger().notificationFacts(member.memberId)
    const body = notifications.length === 0 ? text : `${text}\n\n${this.notificationText(notifications, member.memberId)}`
    const hint = createUserMessage({
      content: [{ type: 'text', text: body }],
      source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: RECOVERY_NOTICE_SUMMARY },
    })
    for (const pending of [...handle.agent.inbox.nextStep, ...handle.agent.inbox.nextTurn]) {
      if (this.isInboxNotice(pending)) handle.agent.inbox.remove(pending.id)
    }
    handle.agent.steer(hint)
  }

  /** Automatic-recovery wakeup; throwing tells the coordinator the target is gone. */
  private injectRecovery(memberId: AgentTeamMemberId): void {
    const handle = this.handles.get(memberId)
    const agent = handle?.agent
    const member = agent !== undefined ? this.memberForAgent(agent) : undefined
    if (agent === undefined || member === undefined || member.state !== 'enabled') throw new Error(`member '${memberId}' cannot be recovered automatically`)
    this.steerResume(member, this.automaticResumeText())
  }

  /**
   * Human edit of one Member's mutable facts. A live model selection is
   * updated in place: disposing an Agent emits session/disposed, which makes
   * the Web Client permanently mark the same Session id unavailable even when
   * Team immediately recreates it.
   */
  @Remote('updateMember')
  async updateMember(request: AgentTeamUpdateMemberRequest): Promise<AgentTeamMemberResult> {
    return this.enqueueLifecycle(async () => {
      await this.assertModelRoute(request.model)
      const previous = this.requireLedger().getMember(request.memberId)
      const result = await this.requireLedger().updateMember({ ...request, actor: agentTeamHumanActor() })
      if (result.committed) this.emitCommitted(result.value.receipt)
      const stored = result.value.member
      const active = this.handles.get(request.memberId)
      if (active !== undefined && !isDeepStrictEqual(previous?.model ?? undefined, stored.model ?? undefined)) {
        const selection = this.modelSelections.get(request.memberId)
        if (selection === undefined) throw new Error(`Agent Member '${stored.handle}' has no live model selection`)
        selection.current = stored.model ?? this.ctx.agentDefaultModel.currentSelection()
      }
      if (active !== undefined && !isDeepStrictEqual(previous?.capabilities ?? undefined, stored.capabilities ?? undefined)) {
        await this.applyCapabilityEdit(active, stored)
      }
      return Object.freeze({ receipt: result.value.receipt, status: this.memberStatus(stored) })
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
  private async applyCapabilityEdit(active: AgentHandle, stored: AgentTeamAgentMember): Promise<void> {
    const memberId = stored.memberId
    const waited = await this.memberRuntime.awaitTurnBoundary(active)
    if (waited && this.handles.get(memberId) !== active) {
      // The wait resolved because the old generation was disposed, not
      // because the turn ended; the ledger intent applies at the next
      // activation instead.
      return
    }
    this.memberRuntime.reapplyMemberToolPolicy(stored)
    this.memberRuntime.swapSkillSelection(memberId, stored.capabilities?.skills?.allow)
  }

  /** Irreversibly remove one Member, archive its Session, and delete its private namespace. */
  async removeMember(request: AgentTeamRemoveMemberRequest): Promise<AgentTeamRemoveMemberResult> {
    return this.enqueueLifecycle(async () => {
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
    return this.enqueueLifecycle(async () => {
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

  /** Human-only Channel membership grant; it never injects historical Thread bodies. */
  @Remote('joinChannel')
  async joinChannel(request: AgentTeamJoinChannelRequest): Promise<AgentTeamJoinChannelResult> {
    const actor = this.humanCall(request.workspaceId)
    const ledger = this.requireLedger()
    if (!ledger.hasCommitted(request.requestId)) this.assertChannelMembersAvailable([request.memberId])
    const result = await ledger.joinChannel({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Human-only Channel membership removal and Channel-scoped cleanup. */
  @Remote('removeChannelMember')
  async removeChannelMember(request: AgentTeamRemoveChannelMemberRequest): Promise<AgentTeamRemoveChannelMemberResult> {
    const actor = this.humanCall(request.workspaceId)
    const result = await this.requireLedger().removeChannelMember({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
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
   * The long-gap gate's judge, as the Team settings surface states it: whether
   * a judge is reachable, why not when none is, and the thresholds in force.
   * The judge's own fields (key presence, endpoint, model) ride the settings
   * document this row already publishes, so nothing here restates them; the
   * gate's thresholds are row configuration the settings document deliberately
   * omits, which is why the Host resolves an omitted field against the engine's
   * own default here rather than letting a second copy of those numbers exist.
   */
  @Remote('contextJudge')
  contextJudgeForClient(_request: AgentTeamContextJudgeRequest): AgentTeamContextJudgeResult {
    const status = this.contextJudge.status()
    const gate = this.config.gate
    return Object.freeze({
      ...status,
      gate: Object.freeze({
        tokens: gate.tokens ?? DEFAULT_GATE_TOKENS,
        idleMs: gate.idleMs ?? DEFAULT_GATE_IDLE_MS,
        judgeTimeoutMs: gate.judgeTimeoutMs ?? DEFAULT_GATE_JUDGE_TIMEOUT_MS,
      }),
    })
  }

  /**
   * Human profile read for the settings page and footnote: name + avatar
   * reference from this Host row's live Config plus version facts. Human-scoped
   * (the Web Client calls it); agent tools never receive avatar bytes, only the
   * name through team_view. The new-release check stays best-effort and cached —
   * `updateAvailable` is false until a background refresh actually observes a
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
      updateAvailable: update.updateAvailable,
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
    const value = result.value
    // Private read-time enrich: an acceptance the reader just acknowledged is
    // a natural Task boundary, so the Host prices the reader's context once,
    // after the durable read has committed. Never a ledger fact, never
    // persisted, and a measurement failure degrades to an explicit
    // `unavailable` — the committed read is never reversed.
    const advice = await this.acceptanceContextAdvice(agent, value)
    return advice === undefined ? value : Object.freeze({ ...value, contextAdvice: advice })
  }

  /**
   * Context advice for one acceptance acknowledged by this read: only when
   * the read carried an unread accept activity AND the Task is still done.
   * Repeat reads (nothing unread), history-style reads, and reopened Tasks
   * carry no advice — the acceptance no longer stands.
   */
  private async acceptanceContextAdvice(agent: Agent, read: AgentTeamThreadReadResult): Promise<AgentTeamContextAdvice | undefined> {
    if (read.task === undefined || read.task.resolution !== 'accepted' || read.task.status !== 'done') return undefined
    const acknowledgedAccept = read.facts.some(entry => entry.unread && entry.fact.kind === 'activity'
      && entry.fact.activity.kind === 'accept')
    if (!acknowledgedAccept) return undefined
    return this.contextAdviceFor(agent)
  }

  /** Price the reading Member's context against its current route's budgets. */
  private async contextAdviceFor(agent: Agent): Promise<AgentTeamContextAdvice> {
    try {
      const limits = await this.routeLimitsForAgent(agent)
      if (limits === undefined) return this.unavailableAdvice()
      const taskBoundaryThreshold = Math.min(ACCEPT_TASK_BOUNDARY_THRESHOLD, limits.handoffAt)
      if (limits.usageTokens >= limits.handoffAt) {
        return Object.freeze({ usageTokens: limits.usageTokens, taskBoundaryThreshold, handoffAt: limits.handoffAt, hardLimit: limits.hardLimit,
          action: 'handoff-now',
          guidance: 'You are at or above the handoff budget. Finish the current atomic action and unsettled evidence, then call context_rollover with a fresh handoff now.' })
      }
      if (limits.usageTokens >= taskBoundaryThreshold) {
        return Object.freeze({ usageTokens: limits.usageTokens, taskBoundaryThreshold, handoffAt: limits.handoffAt, hardLimit: limits.hardLimit,
          action: 'rollover',
          guidance: 'Finish the acceptance closeout, persist only durable reusable conclusions, collect or stop jobs, then call context_rollover with a fresh handoff covering every other active Claim. Do not return to an old checkpoint solely because this Task was accepted.' })
      }
      return Object.freeze({ usageTokens: limits.usageTokens, taskBoundaryThreshold, handoffAt: limits.handoffAt, hardLimit: limits.hardLimit,
        action: 'keep',
        guidance: 'Keep the current context for possible acceptance follow-up. This acceptance is already a timeline boundary; do not create a redundant checkpoint. Record a checkpoint only before the next noisy or risky phase.' })
    } catch {
      // Any measurement failure degrades explicitly; the read stays durable.
      return this.unavailableAdvice()
    }
  }

  private unavailableAdvice(): AgentTeamContextAdvice {
    return Object.freeze({ usageTokens: undefined, taskBoundaryThreshold: undefined, handoffAt: undefined, hardLimit: undefined,
      action: 'unavailable',
      guidance: 'Context usage could not be measured for this acceptance; manage context by your existing pressure policy.' })
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
    try {
      const message = createUserMessage({
        content: [{ type: 'text', text: this.dmRelayText(agent, recipient, request.body.trim(), result.value.receipt.occurredAt, result.value.receipt.operationId, request.workspaceId) }],
        source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'relay' },
      })
      // An idle recipient gets one ordinary turn; a busy one is steered into
      // its current turn — the same wake split subagent continuations use.
      if (handle.agent.status === 'idle') handle.agent.followup(message)
      else handle.agent.steer(message)
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
    return this.requireLedger().threadHistory(actor, request)
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
   * Effective context-pressure budget for one Member's current route:
   * `hardLimit = min(256K, routeWindow - outputReserve)` and
   * `handoffAt = min(200K, hardLimit - handoffReserve)`.
   */
  private contextLimits(routeWindow: number): { readonly hardLimit: number; readonly handoffAt: number } {
    const hardLimit = Math.min(CONTEXT_HARD_LIMIT_CAP, Math.max(0, routeWindow - CONTEXT_SAFE_OUTPUT_RESERVE))
    const handoffAt = Math.min(CONTEXT_HANDOFF_AT_CAP, Math.max(0, hardLimit - CONTEXT_HANDOFF_RESERVE))
    return { hardLimit, handoffAt }
  }

  /**
   * Budget + measurement for one Member's CURRENT routed selection — the
   * member-pinned model or the default selection, resolved through the LLM
   * service so a route change is honored at the next pre-step. The last
   * persisted `request/context` event wins when it matches the current
   * selection (no directory round-trip for an unchanged route). A selection
   * whose capacity cannot be resolved returns `undefined` and the pressure
   * policy fails closed instead of assuming an unbounded route.
   */
  private async routeLimitsForAgent(agent: Agent): Promise<{ readonly usageTokens: number; readonly hardLimit: number; readonly handoffAt: number } | undefined> {
    const member = this.memberForAgent(agent)
    if (member === undefined) return undefined
    // The pressure budget must match the route the CURRENT step actually
    // uses: the live selection ref's `assembled` capture when the step has
    // entered prompt assembly, its `current` selection otherwise. Re-deriving
    // from the ledger or the Host default would race a concurrent default
    // change or live model edit and split the budget from the real route.
    const ref = this.modelSelections.get(member.memberId)
    const selection = ref?.assembled ?? ref?.current ?? member.model ?? this.ctx.agentDefaultModel.currentSelection()
    const meter = agent.ctx.get('tokenMeter')
    const usageTokens = meter?.measure(agent.session)?.totalTokens
    if (usageTokens === undefined) return undefined
    const persisted = agent.session.requestContext()
    let contextWindow: number | undefined
    if (persisted?.provider === selection.provider && persisted.model === selection.model) {
      contextWindow = persisted.contextWindow
    }
    if (contextWindow === undefined) {
      contextWindow = await this.resolvedContextWindow(selection)
    }
    if (contextWindow === undefined) return undefined
    const { hardLimit, handoffAt } = this.contextLimits(contextWindow)
    return { usageTokens, hardLimit, handoffAt }
  }

  /** Cache of resolved context windows per provider/model; unknown stays unknown. */
  private readonly routeWindows = new Map<string, number | undefined>()

  /**
   * Resolve one selection's provider-owned context capacity, cached per
   * route. The LLM service is resolved lazily (not a hard inject): the Host
   * mounts it in every production shape, while ledger-level fixtures provide
   * only the services the Team service itself owns. A missing or throwing
   * resolution is an unknown route — the pressure policy fails closed on it.
   */
  private async resolvedContextWindow(selection: { readonly provider: string; readonly model: string }): Promise<number | undefined> {
    const key = `${selection.provider}::${selection.model}`
    if (this.routeWindows.has(key)) return this.routeWindows.get(key)
    let contextWindow: number | undefined
    try {
      const llm = this.ctx.get('llm')
      const info = llm === undefined ? undefined : await llm.resolveModelInfo(selection.provider, selection.model)
      contextWindow = info?.context?.contextWindow
    } catch {
      contextWindow = undefined
    }
    this.routeWindows.set(key, contextWindow)
    return contextWindow
  }

  /**
   * Resolve one checkpoint ref to its exact seed prefix before any rollover
   * commit. The walk covers the current generation (own events) and archived
   * ancestors through `sessionPersistence`; the same projection definition
   * folds every source. Guards fail closed: unresolved, foreign-lineage,
   * open-turn, or nonshrinking targets reject without any lifecycle effect.
   */
  private async resolveCheckpointSeed(memberId: AgentTeamMemberId, agent: Agent, checkpointRef: AgentTeamContextCheckpointRef): Promise<CheckpointSeed> {
    let sessionId: SessionId | undefined = agent.session.id
    let live = true
    let guard = 0
    while (sessionId !== undefined && guard++ <= MAX_TIMELINE_ANCESTORS) {
      let events: readonly SessionEvent[]
      let inheritedEventCount: SessionLogOffset
      let parentSession: SessionId | undefined
      // Capture this iteration's source identity BEFORE the branch advances
      // the lineage flag: the measurement call below keys on it.
      const sourceIsCurrent = live
      if (live) {
        events = agent.session.snapshotEvents()
        inheritedEventCount = agent.session.inheritedEventCount
        parentSession = agent.session.header.parentSession
        live = false
      } else {
        const read = await this.sessionReader.read(sessionId)
        if (!read.ok) {
          throw new StoredSessionReadError(`checkpoint '${checkpointRef}' could not be resolved: its source Session is unreadable (${read.failure.kind}: ${read.failure.detail})`, read.failure)
        }
        events = read.inspection.events
        inheritedEventCount = read.inspection.inheritedEventCount
        parentSession = read.inspection.header.parentSession
      }
      // Fold the source with its inherited cut respected: inherited events
      // are resolved history in that source, never fresh intent; checkpoints
      // recorded in this source's own span are the selectable targets.
      const state = foldTeamContextProjection(events, { sessionId, inheritedEventCount }, this.contextProjectionHost)
      // A Team-boundary default checkpoint: the boundary's completed-turn
      // anchor is the seed cut, and it is selectable exactly when one
      // Thread's facts entered the context through it — the same proof the
      // timeline requires, revalidated here because the model may cite a
      // boundary the timeline never surfaced.
      const boundary = checkpointRef.startsWith('team-boundary-')
        ? boundaryByRef(state, checkpointRef)
        : undefined
      const entry = checkpointByRef(state, checkpointRef)
      const anchorTurnEndSeq = boundary !== undefined ? boundary.turnEndSeq : entry?.turnEndSeq
      if (anchorTurnEndSeq !== undefined && anchorTurnEndSeq !== -1) {
        if (boundary !== undefined && boundary.kind !== 'team-boundary') {
          throw new Error(`checkpoint '${checkpointRef}' is not a restorable boundary`)
        }
        // The seed is the exact contiguous prefix through the anchor's
        // completed turn end. Balanced by construction — the turn ended.
        const throughSeq = anchorTurnEndSeq + 1
        const prefix = events.slice(0, throughSeq)
        if (boundary !== undefined) {
          // The seed must stay inside one Thread's context: the retained
          // prefix through the anchor holds exactly one Thread's facts, read
          // from the fold's own boundary attributions — the same accumulated
          // set the timeline shows, so a ref the timeline offered is never
          // refused here for a reason it did not state.
          const threads = retainedTopicsThrough(state, anchorTurnEndSeq)
          if (threads.length !== 1) {
            throw new Error(threads.length === 0
              ? `boundary '${checkpointRef}' has no single attributable Thread; write a fresh handoff instead`
              : `boundary '${checkpointRef}' spans multiple Threads; write a fresh handoff instead`)
          }
        }
        // Nonshrinking guard, priced by the SAME source-replayed measurement
        // the timeline shows: the seed's retained cost is the SOURCE's own
        // token count scaled by the anchor share — a small current generation
        // never disguises a large ancestor seed. An unmeasurable source fails
        // closed: pricing the unknown as zero would wave an oversized seed
        // through.
        const limits = await this.routeLimitsForAgent(agent)
        const handoffAt = limits?.handoffAt ?? CONTEXT_HANDOFF_AT_CAP
        const sourceUsage = await this.sourceUsageTokens(sessionId, sourceIsCurrent, agent)
        if (sourceUsage === undefined) {
          throw new Error(`checkpoint '${checkpointRef}' could not be priced: its source Session's context cost cannot be measured; write a fresh handoff instead`)
        }
        const retained = this.retainedEstimate(sourceUsage, events.length, anchorTurnEndSeq)
        if (prefix.length >= events.length) {
          throw new Error('checkpoint return does not shrink the working set; use a fresh handoff instead')
        }
        if (retained >= handoffAt) {
          throw new Error('checkpoint return would retain a context at or above the handoff budget; use a fresh handoff instead')
        }
        // Single-Thread coverage guard: with more than one active Claim the
        // Host cannot prove a rewind stays inside one Thread's context.
        if (this.requireLedger().activeClaimCountForMember(memberId) > 1) {
          throw new Error('multiple active Claims: write a fresh handoff covering all of them instead of returning to a checkpoint')
        }
        return { checkpointRef, sourceSessionId: sessionId, sourceThroughSeq: SessionLogOffset(throughSeq), prefix }
      }
      sessionId = parentSession
    }
    throw new Error(`checkpoint '${checkpointRef}' does not resolve in this Member's lineage`)
  }

  /**
   * Rebuild the handoff for a Member whose rollover committed but whose new
   * Session activated without the handoff delivery (a crash between the
   * ledger commit and the swap's delivery step). The previous Session —
   * recorded in the operation, mirrored by the lineage parent, and available
   * from the ledger even when the new Session's own header never carried it —
   * holds the durable intent; fold it cold and deliver the same handoff
   * envelope first. Idempotent: once any handoff exists in the new Session's
   * own log this never runs.
   */
  private async reconstructMissingHandoff(member: AgentTeamAgentMember, agent: Agent): Promise<void> {
    const previousSessionId = agent.session.header.parentSession
      ?? this.requireLedger().previousSessionForMember(member.memberId)
    if (previousSessionId === undefined) return
    const previousRead = await this.sessionReader.read(previousSessionId)
    if (!previousRead.ok) {
      // Best-effort recovery: the handoff intent stays lost with the
      // unreadable previous Session, but the Member still activates.
      const failure = previousRead.failure
      this.ctx.logger.warn(`agent-team: rollover handoff reconstruction could not read the previous Session '${previousSessionId}' (${failure.kind}): ${failure.detail}`)
      return
    }
    const inspection = previousRead.inspection
    const state = foldTeamContextProjection(
      inspection.events,
      { sessionId: previousSessionId, inheritedEventCount: inspection.inheritedEventCount },
      this.contextProjectionHost,
    )
    if (state.pending === null) return
    const pending = state.pending
    const message = TEAM_CONTEXT_CODEC.createHandoffMessage({
      handoff: pending.handoff,
      previousSessionId,
      newSessionId: agent.session.id,
      trigger: 'model',
      handoffEventSeq: pending.resultSeq as never,
      ...(pending.checkpointRef === undefined ? {} : { checkpointRef: pending.checkpointRef }),
      ...(pending.relatedFiles.length === 0 ? {} : { relatedFiles: pending.relatedFiles }),
    })
    agent.steer(message)
    this.ctx.logger.info(`agent-team: reconstructed the rollover handoff for member '${this.memberLabel(member.memberId)}' from the previous Session '${previousSessionId}'`)
  }

  /**
   * Resolve the exact recorded seed prefix of one committed checkpoint
   * return for crash recovery: cold-read the recorded source Session, take
   * the contiguous prefix of the recorded exclusive length, and verify the
   * source's own fold still resolves the recorded anchor there — an explicit
   * checkpoint through `checkpointByRef`, or a default Team boundary whose
   * recorded ref appears among the source's own boundary keys.
   * Fail-closed by contract: an unreadable source or an unprovable anchor
   * REJECTS the activation — a committed checkpoint return may never
   * downgrade to a blank child.
   */
  private async recordedCheckpointPrefix(seed: { readonly sourceSessionId: SessionId; readonly sourceThroughSeq: SessionLogOffset; readonly checkpointRef: AgentTeamContextCheckpointRef }): Promise<{ readonly prefix: readonly SessionEvent[] }> {
    const seedRead = await this.sessionReader.read(seed.sourceSessionId)
    if (!seedRead.ok) {
      const failure = seedRead.failure
      throw new StoredSessionReadError(`the recorded checkpoint-return seed source Session '${seed.sourceSessionId}' is unreadable (${failure.kind}): ${failure.detail}`, failure)
    }
    const inspection = seedRead.inspection
    const through = Number(seed.sourceThroughSeq)
    if (!Number.isSafeInteger(through) || through < 0 || through > inspection.events.length) {
      throw new Error(`the recorded checkpoint-return seed cut ${through} is not a valid prefix of Session '${seed.sourceSessionId}'`)
    }
    const state = foldTeamContextProjection(
      inspection.events,
      { sessionId: seed.sourceSessionId, inheritedEventCount: inspection.inheritedEventCount },
      this.contextProjectionHost,
    )
    const anchorProven = checkpointByRef(state, seed.checkpointRef) !== undefined
      || boundaryByRef(state, seed.checkpointRef) !== undefined
    if (!anchorProven) {
      throw new Error(`the recorded checkpoint-return anchor '${seed.checkpointRef}' no longer resolves in Session '${seed.sourceSessionId}'`)
    }
    return { prefix: inspection.events.slice(0, through) }
  }

  /**
   * Redeliver the old generation's unconsumed post-intent input to a
   * generation whose durable rollover committed but whose delivery did not
   * finish. Bound to the ledger's recorded transition target — the CURRENT
   * Session being that target — never to whether the handoff itself landed,
   * so a crash after the handoff but before the carried enqueue still
   * replays. The fold is the same durable truth the live transition uses
   * (unconsumed, non-Team, order preserved). Idempotency keys on what is
   * CURRENTLY present: delivered `user/message` ids plus the live inbox's
   * pending next-step/next-turn ids — a historical insert that was already
   * claimed (and removed) but never surfaced is NOT known and must replay.
   * Fail-closed for genuinely unreadable previous Sessions (missing/IO) so
   * the Member's input is never dropped silently, with three bounded
   * exceptions: a generation that already started its own turns needs no
   * replay (its carried input was delivered or superseded while it ran), a
   * log-corruption class error skips with a warning (the Host repairs torn
   * tails; a retired generation's corrupt log must not permanently block the
   * Member's activation), and a deterministic released-format refusal skips
   * with a warning (the candidate's own migration audit refuses that
   * artifact, so no retry can ever read it).
   */
  private async replayCarriedInput(member: AgentTeamAgentMember, agent: Agent, generationStarted: boolean): Promise<number> {
    const transition = this.requireLedger().lastTransitionForMember(member.memberId)
    if (transition === undefined || transition.targetSessionId !== agent.session.id) return 0
    // A generation that already started its own turns needs no previous-Session
    // replay: its carried input was delivered with the handoff (or superseded)
    // before any own turn could run. Skipping the inspect also keeps a later
    // corruption or loss of the retired Session from re-blocking this Member
    // on every restart of the current generation.
    if (generationStarted) {
      this.ctx.logger.info(`agent-team: skipping carried-input replay for member '${this.memberLabel(member.memberId)}': the current Session '${agent.session.id}' already started a generation`)
      return 0
    }
    let inspectionEvents: readonly SessionEvent[]
    let inspectionInherited: SessionLogOffset
    const previousRead = await this.sessionReader.read(transition.previousSessionId)
    if (!previousRead.ok) {
      const failure = previousRead.failure
      // Log-corruption class: bounded fail-open. The current Session's own
      // fold is intact and the Host repairs the retired log's torn tail; a
      // corrupted retired generation must not permanently block activation.
      if (failure.kind === 'corrupt') {
        this.ctx.logger.warn(`agent-team: previous Session '${transition.previousSessionId}' holding carried input for member '${this.memberLabel(member.memberId)}' is corrupt: ${failure.detail}; skipping the replay`)
        return 0
      }
      // Deterministic released-format refusal: the retired artifact is refused
      // by the candidate's own migration audit, which no retry can change.
      // Failing activation here would turn a data problem in a Session the
      // Member no longer runs in into permanent unavailability — the exact
      // failure class this hardening removes. Genuine IO and unknown failures
      // stay fail-closed so carried input is never dropped silently.
      if (failure.kind === 'refused') {
        this.ctx.logger.warn(`agent-team: previous Session '${transition.previousSessionId}' holding carried input for member '${this.memberLabel(member.memberId)}' is refused by the session-format migration: ${failure.detail}; skipping the replay`)
        return 0
      }
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
    if (redelivered > 0) this.ctx.logger.info(`agent-team: redelivered ${redelivered} carried input message(s) for member '${this.memberLabel(member.memberId)}' after the rollover crash recovery`)
    return redelivered
  }

  /**
   * The compaction capability in one Member Agent's preset scope, or undefined
   * when its composition mounts none. Both the pressure policy (the hard limit)
   * and the engine's `context_compact` tool ask through here, so which realm
   * holds the engine is stated once: a preset revision publishes services
   * behind its own isolate, which `agent.ctx.get` cannot see from outside.
   */
  compactionForAgent(agent: Agent): CompactionEngine | undefined {
    return this.ctx.agentPresets.serviceFor(agent, 'compaction')
  }

  /**
   * Agent-only checkpoint request validation: the tool calls this inside its
   * own running turn. Like `context_rollover`, the tool performs no side effect —
   * the durable checkpoint is the successful `tool/call`+`tool/result` pair
   * the Session projection folds; the ref returned here is deterministic
   * from this Member Session's identity plus the tool call id, so the model
   * can cite it before the result exists and a repeated provider call id in
   * another generation never collides with this one.
   */
  recordCheckpointForAgent(agent: Agent, request: AgentTeamCheckpointToolRequest): AgentTeamCheckpointToolOutcome {
    const member = this.memberForAgent(agent)
    if (member === undefined || member.state !== 'enabled') throw new Error('context_checkpoint requires an active Team Member')
    if (this.runningAgents.has(agent.id) !== true) throw new Error('context_checkpoint must run inside this Member\'s own running turn')
    const name = request.name.trim()
    if (name === '') throw new Error('context_checkpoint requires a non-empty name')
    if (name.length > MAX_CHECKPOINT_NAME_CHARS) throw new Error(`context_checkpoint name exceeds ${MAX_CHECKPOINT_NAME_CHARS} characters`)
    return { checkpointRef: checkpointRefFor(agent.session.id, request.callId), name }
  }

  /**
   * Agent-only bounded structural timeline: resolved checkpoints plus Team
   * delivery, handoff, and compaction boundaries across the current
   * generation and its archived ancestor lineage. Structural only — no
   * transcript content. The walk, the per-source folds, the pricing, and the
   * anchor rules are the engine's `readContextTimeline`; Team contributes the
   * fold configuration, the measurement, and the one judgement the engine
   * leaves to its host — which Threads a boundary's retained prefix holds — so
   * a ref this list offers is a ref `context_rollover` accepts.
   */
  async contextTimelineForAgent(agent: Agent, request: AgentTeamTimelineToolRequest): Promise<AgentTeamTimelineToolResult> {
    const member = this.memberForAgent(agent)
    if (member === undefined || member.state !== 'enabled') throw new Error('context_status requires an active Team Member')
    const limit = request.limit === undefined ? DEFAULT_TIMELINE_LIMIT : Math.trunc(request.limit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TIMELINE_LIMIT) throw new Error(`context_status limit must be between 1 and ${MAX_TIMELINE_LIMIT}`)
    const meter = agent.ctx.get('tokenMeter')
    const measurement = meter?.measure(agent.session)
    const usageTokens = measurement?.totalTokens ?? 0
    const limits = await this.routeLimitsForAgent(agent)
    const hardLimit = limits?.hardLimit ?? CONTEXT_HARD_LIMIT_CAP
    const handoffAt = limits?.handoffAt ?? CONTEXT_HANDOFF_AT_CAP
    // One measurement per lineage source, memoized by Session: the engine
    // measures a source once before pricing its anchors, and the boundary
    // overlay below reads the same map to tell an unprovable budget (never
    // priced as free) from a real budget rejection.
    const measurements = new Map<string, number | undefined>()
    const timeline = await readContextTimeline({
      current: {
        sessionId: agent.session.id,
        header: agent.session.header,
        inheritedEventCount: agent.session.inheritedEventCount,
        events: agent.session.snapshotEvents(),
      },
      config: this.contextFoldConfig(),
      readAncestor: sessionId => this.sessionReader.read(sessionId),
      measureSource: source => {
        const key = String(source.sessionId)
        if (!measurements.has(key)) measurements.set(key, this.measureContextSourceForAgent(agent, source))
        return measurements.get(key)
      },
      currentUsageTokens: usageTokens,
      handoffAt,
      limit,
      // Archived ancestors the engine walks; the seed guard resolves a cited
      // ref through the same depth, so the timeline never offers a ref the
      // guard cannot reach.
      maxAncestors: MAX_TIMELINE_ANCESTORS,
    })
    return {
      usageTokens,
      hardLimit,
      handoffAt,
      items: timeline.items.map(item => this.teamTimelineItemFor(item, agent.session.id, handoffAt, measurements)),
      ...(timeline.incompleteFrom === undefined ? {} : { incompleteFrom: timeline.incompleteFrom }),
    }
  }

  /**
   * Map one engine timeline item onto the model-facing Team item. The engine
   * decided the walk, the fold, the pricing, and the head, checkpoint, and
   * measurable-source verdicts; Team restates exactly one policy of its own: a
   * Team boundary is selectable only when the RETAINED PREFIX through it stays
   * inside one Thread — the same proof the seed guard revalidates before it
   * swaps a generation. The engine judges a boundary by its OWN attribution
   * instead, so a boundary that arrived after a second Thread's facts would be
   * offered here and refused by `context_rollover`; Team's stricter rule is
   * what keeps the two surfaces answering one question.
   */
  private teamTimelineItemFor(item: ContextTimelineItem, currentSessionId: SessionId, handoffAt: number, measurements: ReadonlyMap<string, number | undefined>): AgentTeamTimelineItem {
    const source: AgentTeamTimelineItem['source'] = item.source === 'boundary'
      ? item.kind === 'handoff' || item.kind === 'compaction' ? item.kind : 'team-boundary'
      : item.source === 'checkpoint' ? 'agent' : 'head'
    const affectedThreads = item.affectedTopics
    let restorable = item.restorable
    let reason = item.reason
    // A boundary's verdict is Team's to make, but only once its source is
    // measurable: "the budget cannot be proven" is the engine's first
    // rejection and stays first — an unmeasurable boundary is not selectable
    // even when its prefix holds exactly one Thread.
    if (item.source === 'boundary' && measurements.get(String(item.sourceSessionId ?? currentSessionId)) !== undefined) {
      if (source === 'handoff' || source === 'compaction') {
        // A handoff opens a generation and a compaction rewrites the visible
        // surface: rewinding into either is not a proven-safe target. The
        // engine has no vocabulary for that and would answer "no single topic
        // is attributable", which misdescribes why.
        restorable = false
        reason = `source '${source}' is not a restorable checkpoint`
      } else if (affectedThreads.length !== 1) {
        restorable = false
        reason = affectedThreads.length === 0
          ? 'no single Thread is attributable to this boundary'
          : 'multiple Threads entered the context through this boundary; write a fresh handoff instead'
      } else if (item.retainedTokens >= handoffAt) {
        restorable = false
        reason = 'retained context would not materially shrink the working set'
      } else {
        restorable = true
        reason = undefined
      }
    }
    return {
      checkpointRef: item.ref,
      name: item.label,
      source,
      retainedTokens: item.retainedTokens,
      discardedTokens: item.discardedTokens,
      affectedThreads,
      restorable,
      ...(reason === undefined ? {} : { reason }),
      // Team's field semantics, unchanged: every item that is not a
      // checkpoint names the Session it anchors in — an ancestor generation's
      // boundary is how a lineage reads — and a checkpoint is keyed to its own
      // Session by its ref already.
      ...(source === 'agent' ? {} : { sourceSessionId: item.sourceSessionId ?? currentSessionId }),
    }
  }

  /**
   * Replayed measurement of one lineage source: the live current Session
   * measures directly; an archived ancestor measures through a detached
   * Session rebuilt from the source's own log, so a seed's retained cost is
   * priced in the SOURCE's own tokens — never the current generation's.
   * Returns undefined when no meter is available or the source cannot be
   * replayed; callers fail closed on the unknown.
   */
  private async sourceUsageTokens(sessionId: SessionId, live: boolean, agent: Agent): Promise<number | undefined> {
    const meter = agent.ctx.get('tokenMeter')
    if (meter === undefined) return undefined
    if (live) return meter.measure(agent.session)?.totalTokens
    // 0.1.5 removed borrowSession: rebuild a detached Session from the
    // stored log so the seed's retained cost is priced by the SOURCE's own
    // replay, never the current generation's. An unreadable source or a
    // failing meter is unmeasurable and prices as UNKNOWN.
    const read = await this.sessionReader.read(sessionId)
    if (!read.ok) return undefined
    return this.measureDetachedSource(agent, {
      sessionId,
      header: read.inspection.header,
      inheritedEventCount: read.inspection.inheritedEventCount,
      events: read.inspection.events,
    })
  }

  /**
   * One already-read source's replayed measurement: an archived generation is
   * rebuilt as a detached Session and measured in its own tokens. Undefined
   * means unmeasurable, never free.
   */
  private measureDetachedSource(agent: Agent, source: ContextTimelineSource): number | undefined {
    const meter = agent.ctx.get('tokenMeter')
    if (meter === undefined) return undefined
    try {
      const session = Session.create(source.sessionId, source.events, source.header, source.inheritedEventCount)
      return meter.measure(session)?.totalTokens
    } catch {
      return undefined
    }
  }

  /**
   * One source's replayed measurement, in that source's own tokens, for a
   * caller that already holds the source: the live generation measures
   * directly, an archived one is rebuilt from the log it came with. Undefined
   * means unmeasurable — a caller must never price an unknown source as free.
   */
  measureContextSourceForAgent(agent: Agent, source: ContextTimelineSource): number | undefined {
    if (String(source.sessionId) === String(agent.session.id)) {
      return agent.ctx.get('tokenMeter')?.measure(agent.session)?.totalTokens
    }
    return this.measureDetachedSource(agent, source)
  }

  /**
   * The one fold configuration the registered projection unit and every cold
   * fold use, so a generation read back for the timeline reads exactly as the
   * projection folded it — same codec, same boundary attribution.
   */
  contextFoldConfig(): ContextProjectionConfig {
    return createTeamContextProjectionConfig(this.contextProjectionHost)
  }

  /**
   * Monotonic anchor-share estimate of a seed's retained cost, priced in the
   * SOURCE Session's own measurement: the fraction of the source log the
   * seed prefix covers, scaled to the source's replayed token count. The
   * anchor position is exact and the share grows monotonically toward the
   * source's head (100%). A large ancestor's anchor therefore prices at the
   * ancestor's real size even inside a small current generation — the
   * timeline display and the return guard share this one estimate.
   */
  private retainedEstimate(sourceUsageTokens: number, sourceLength: number, anchorTurnEndSeq: number): number {
    if (sourceLength <= 0) return sourceUsageTokens
    const share = Math.min(1, Math.max(0, (anchorTurnEndSeq + 1) / sourceLength))
    return Math.round(sourceUsageTokens * share)
  }

  /**
   * Agent-only rollover request validation: the tool calls this to check its
   * Member binding, exclusivity, and checkpoint ownership. It performs no
   * lifecycle effect — the actual transition reacts to the successful tool
   * result through the context-management coordinator.
   */
  async requestNewContext(agent: Agent, request: AgentTeamNewContextToolRequest): Promise<AgentTeamNewContextToolOutcome> {
    const member = this.memberForAgent(agent)
    if (member === undefined || member.state !== 'enabled') throw new Error('context_rollover requires an active Team Member')
    if (this.contextManagement.isTransitioning(member.memberId)) throw new Error('a context rollover is already scheduled for this Member; wait for it to finish before requesting another')
    if (this.runningAgents.has(agent.id) !== true) {
      // The tool runs inside the Member's own turn, so a non-running agent at
      // this point is a harness anomaly; refuse rather than schedule a swap
      // outside the turn fence.
      throw new Error('context_rollover must run inside this Member\'s own running turn')
    }
    // Job ownership guard: disposing the old Agent cancels its running jobs
    // and orphaned terminal-but-unreported output would vanish with it. The
    // rejection names the jobs so the model can collect or stop them first;
    // the transition rechecks at the lifecycle commit seam because a job may
    // settle between this validation and the swap.
    const blocking = this.ownedJobsBlockingRollover(agent)
    if (blocking.length > 0) {
      throw new Error(`context_rollover is refused while this Member owns jobs that would not survive the switch (${blocking.join(', ')}); collect or stop them first, then retry`)
    }
    if (request.checkpointRef === undefined) return { mode: 'fresh' }
    if (!/^(context-checkpoint-[0-9a-f]{64}|team-boundary-[0-9a-f]{64})$/.test(request.checkpointRef)) throw new Error('checkpointRef must be an opaque ref exactly as returned by context_status')
    // Full current-state prevalidation through the ONE resolver the swap
    // itself uses: a ref that is fabricated, unattributable, nonshrinking,
    // unmeasurable, over-budget, or blocked by multiple active Claims
    // rejects HERE — a model-visible error result instead of a fake
    // `scheduled` whose async swap always fails. The seed is resolved and
    // discarded: the transition seam resolves it again, so only the mutable
    // guard set (jobs, route limits, lineage growth) is revalidated there.
    await this.resolveCheckpointSeed(member.memberId, agent, request.checkpointRef)
    return { mode: 'from-checkpoint' }
  }

  /**
   * Jobs this Agent owns that cannot survive a generation swap: any
   * running/stopping job, and any settled job whose terminal output was
   * never reported (disposal would silently discard it). In-place hard
   * compaction is exempt — it never cancels the owner.
   */
  private ownedJobsBlockingRollover(agent: Agent): readonly string[] {
    const jobs = agent.ctx.get('jobs')
    if (jobs === undefined) return []
    return jobs.list(agent)
      .filter((job: { status: string; reported: boolean }) => job.status === 'running' || job.status === 'stopping' || ((job.status === 'completed' || job.status === 'killed' || job.status === 'failed') && !job.reported))
      .map((job: { id: string; label: string }) => `${job.label} (${job.id})`)
  }

  /**
   * Agent-only session rollover commit: the Member actor must be the target
   * Member on its currently bound live Session. The Host performs the actual
   * generation swap around this write; the ledger records only the durable
   * binding transition and rollover audit envelope.
   */
  async rolloverSessionForAgent(agent: Agent, request: AgentTeamRolloverSessionRequest): Promise<AgentTeamDurableMemberResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().rolloverMemberSession({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
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

  /** Shared Task-creation commit: resolve uploads into metadata lines and append through the ledger. */
  private async sendMessageAs(actor: AgentTeamHumanActor | AgentTeamMemberActor, request: AgentTeamSendMessageRequest): Promise<AgentTeamSendMessageResult> {
    try {
      const metadata = await this.resolveMessageAttachments(request)
      const result = await this.requireLedger().sendMessage({
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

  /** Shared existing-Thread reply commit: same upload resolution and outcome emission. */
  private async replyAs(actor: AgentTeamHumanActor | AgentTeamMemberActor, request: AgentTeamReplyRequest): Promise<AgentTeamReplyResult> {
    try {
      const metadata = await this.resolveMessageAttachments(request)
      const result = await this.requireLedger().reply({
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
   * Validate a pinned model route's reasoning effort against the adapter's own
   * metadata when the LLM service is reachable; unknown routes defer to the
   * LLM layer's runtime check at call time.
   */
  private async assertModelRoute(model: AgentTeamModelSelection | undefined): Promise<void> {
    if (model === undefined || model.reasoningEffort === undefined) return
    try {
      const resolved = await this.ctx.llm.resolveModelInfo(model.provider, model.model)
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

  private async activateMember(member: AgentTeamAgentMember, knownWorkspacePath?: string, knownSessions?: ReadonlySet<SessionId>, forkedFrom?: SessionId, options?: { readonly deferNotify?: boolean; readonly seed?: readonly SessionEvent[]; readonly inheritedEventCount?: SessionLogOffset }): Promise<void> {
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
      // AgentOptions declares only provider/model. Install the full selection
      // through the public Agent model-selection seam so reasoning effort is
      // applied to the next request and not lost during activation.
      const selection = member.model ?? this.ctx.agentDefaultModel.currentSelection()
      const agentOptions = { provider: selection.provider, model: selection.model }
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      // Absent skills.allow loads every discovered private skill; a present
      // allow-list filters the catalog by name through the live ref below.
      // `swap` is bound by the provider at activation (no-op until then).
      const skillSelection: MemberSkillSelectionRef = { current: member.capabilities?.skills?.allow, swap: () => {} }
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
        // Admission gate for pending context rollovers: once a successful
        // context_rollover result is durable, queued input must not open another
        // old-generation model request. The turn-stop boundary captures the
        // inbox (non-Team input is carried to the new generation), and a
        // racing pre-step rejects instead of admitting claimed messages.
        agentCtx.on('agent/turn-stopping', ({ agent }) => {
          if (!this.contextManagement.needsAdmissionGate(agent)) return
          this.contextManagement.captureQueuedInput(agent)
        })
        agentCtx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
          // Check before AND after the waterfall: a rollover pending at either
          // edge must reject this old-generation step, preserving its claimed
          // input for the new generation instead of letting it run or drop.
          if (this.contextManagement.needsAdmissionGate(agent)) {
            this.contextManagement.captureClaimedInput(agent, messages)
            return { kind: 'reject' as const }
          }
          // The engine's pressure policy rides the same pre-step seam after the
          // admission gate: the handoff-budget notice steers into the running
          // turn, the hard limit forces a reduction before the request is
          // forwarded — failing closed blocks the step instead of submitting
          // over the limit — and a step arriving into a large context after a
          // long gap may be held instead of admitted.
          const member = this.memberForAgent(agent)
          const pressure = member === undefined
            ? { kind: 'continue' as const }
            : await this.pressurePolicy.onPreStep(member.memberId, messages, signal)
          if (pressure.kind === 'hold') {
            // The gate kept the messages this step had claimed, and its one
            // rollover instruction is already steered into their place. Arming
            // the hold and keeping those messages are one call; the coordinator
            // owns both exits from here — the input comes back once the driver
            // converges, or rides into the next generation if the rollover
            // lands — so this turn ends with nothing further to do.
            this.contextManagement.holdClaimedInput(agent, messages)
            return { kind: 'reject' as const }
          }
          if (pressure.kind === 'reject') return { kind: 'reject' as const }
          const decision = await next()
          if (decision.kind === 'reject' || !this.contextManagement.needsAdmissionGate(agent)) return decision
          this.contextManagement.captureClaimedInput(agent, messages)
          return { kind: 'reject' as const }
        })
        // Provider context-overflow recovery: one bounded reduce-and-retry
        // sequence per failure chain through the engine's policy.
        agentCtx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
          const member = this.memberForAgent(agent)
          const retry = member !== undefined && await this.pressurePolicy.onRequestError(member.memberId, failure, signal)
          if (retry) return { kind: 'retry' as const }
          return next()
        })
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
      // durable rollover commit and this activation recreates the Session
      // from the ledger binding alone, and the lineage parent is what makes
      // the missing handoff reconstructible on the NEXT failure. A recorded
      // checkpoint seed re-seeds the child here — the crash lost the process
      // memory, but the ledger envelope names the exact source prefix.
      let recordedSeed: readonly SessionEvent[] | undefined
      let recordedSeedCut: SessionLogOffset | undefined
      const rolloverSeed = !persisted && options?.seed === undefined
        ? this.requireLedger().rolloverSeedForMember(member.memberId, member.sessionId)
        : undefined
      if (rolloverSeed !== undefined) {
        // Fail-closed: an unreadable or unprovable recorded seed rejects
        // this activation (the catch below records the diagnostic) instead
        // of silently downgrading a committed checkpoint return to a blank
        // child.
        const resolved = await this.recordedCheckpointPrefix(rolloverSeed)
        recordedSeed = resolved.prefix
        recordedSeedCut = SessionLogOffset(resolved.prefix.length)
      }
      const lineageParent = forkedFrom ?? (!persisted ? this.requireLedger().previousSessionForMember(member.memberId) : undefined)
      let recoveryCarried = 0
      const seededFromLedger = recordedSeed !== undefined
      const effectiveParent = recordedSeed !== undefined ? rolloverSeed!.sourceSessionId : lineageParent
      const seedOptions = options?.seed !== undefined && options.inheritedEventCount !== undefined
        ? { seed: options.seed, inheritedEventCount: options.inheritedEventCount }
        : recordedSeed !== undefined && recordedSeedCut !== undefined
          ? { seed: recordedSeed, inheritedEventCount: recordedSeedCut }
          : {}
      created = persisted
        ? await this.ctx.agents.resume({ resumeSessionId: member.sessionId, agentOptions, setup })
        : await this.ctx.agents.create({
            sessionId: member.sessionId,
            // A context renewal records its fork lineage so the archived
            // previous Session stays discoverable from the durable header; a
            // checkpoint return parents at the seed source and marks the
            // fork seeded with its exact inherited prefix length.
            meta: {
              cwd: workspacePath,
              agentPreset: member.presetId,
              ...(effectiveParent === undefined ? {} : { parentSession: effectiveParent }),
              ...(options?.seed === undefined && !seededFromLedger ? {} : { isSeeded: true }),
            },
            ...seedOptions,
            agentOptions,
            setup,
          })
      this.memberRuntime.mountMemberSkillProvider(member, created.agent.ctx, skillSelection)
      await workspace.attachSession(member.sessionId)
      this.handles.set(member.memberId, created)
      this.memberBySessionId.set(member.sessionId, member.memberId)
      this.modelSelections.set(member.memberId, selected)
      this.clearMemberFailure(member.memberId, 'activation')
      this.nameMemberSession(member, created.agent)
      // The one-shot pressure notice needs no explicit re-arm here: it latches
      // on durable Session evidence, and a fresh generation's own event span
      // starts empty — a new Session is itself the re-arm.
      // Snapshot whether this generation had already started its own turns
      // BEFORE any recovery delivery below: the handoff steer and the Inbox
      // wake legitimately append `turn/start` to this Session, and those must
      // never be mistaken for the generation having run on its own.
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
        // A restart after the rollover committed but before the handoff was
        // delivered activates the new Session with no handoff in its own
        // log — never treat that as an ordinary blank Member Session. The
        // operation's recorded previous Session (the lineage parent) still
        // holds the intent; rebuild the handoff from it. Presence is judged
        // by the projection boundary alone: every handoff this Host ever
        // published classifies under the context source's recognizer,
        // including the history the read-time conversion renamed.
        if (!state.boundaries.some(boundary => boundary.kind === 'handoff')) {
          await this.reconstructMissingHandoff(member, created.agent)
        }
        // Carried input redelivery binds to the committed transition target —
        // this Session — never to the handoff's presence: a crash after the
        // handoff landed but before the carried enqueue still replays here.
        recoveryCarried = await this.replayCarriedInput(member, created.agent, generationStarted)
      } else if (forkedFrom === undefined && lineageParent !== undefined) {
        // A restart recreated a Session that never materialized before the
        // crash (the rollover committed, its activation failed, and this
        // create path just rebuilt it from the ledger binding alone): the
        // same handoff reconstruction applies from the ledger's recorded
        // previous Session, and the old generation's unconsumed post-intent
        // input — the durable fold, the same truth the live transition uses —
        // rides behind the handoff exactly as it would have. The rollover's
        // own activation passes its fork parent explicitly and delivers the
        // handoff right after — that delivery is the plan, never this
        // recovery.
        await this.reconstructMissingHandoff(member, created.agent)
        recoveryCarried = await this.replayCarriedInput(member, created.agent, generationStarted)
      }
      // The ordinary Inbox wake runs LAST, after any recovery delivery above:
      // the handoff must stay the first model-facing context of a recovered
      // generation, with carried input behind it and rederived Team facts
      // behind that. When recovery redelivered carried input, the wake is
      // sequenced behind it (its own follow-up turn) so the steer lane can
      // never leapfrog the carried messages. A rollover activation defers the
      // wake entirely — its caller delivers the handoff (and carried input)
      // first and rederives the Inbox afterwards.
      if (options?.deferNotify !== true) this.notifyMember(created.agent, recoveryCarried > 0)
    } catch (error) {
      await created?.dispose()
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
    return this.enqueueLifecycle(async () => {
      const member = this.requireLedger().getMember(memberId)
      if (member === undefined || member.state !== 'enabled') return false
      const stale = this.handles.get(memberId)
      if (stale !== undefined) {
        this.handles.delete(memberId)
        this.modelSelections.delete(memberId)
        this.memberRuntime.forgetMember(memberId)
        // The composition-loss diagnostic this heal answers is stale once the
        // rebuild starts; a later activation must not resurface it.
        this.clearMemberFailure(memberId, 'compaction')
        this.emitAutoCompactionChanged(memberId)
        await stale.dispose()
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

  private memberStatus(member: AgentTeamAgentMember): AgentTeamAgentMemberStatus {
    if (member.state === 'inactive') return Object.freeze({ member, availability: 'inactive', presence: 'unavailable' })
    if (member.state === 'archived') return Object.freeze({ member, availability: 'archived', presence: 'unavailable' })
    if (member.state === 'suspended') return Object.freeze({ member, availability: 'suspended', presence: 'unavailable' })
    const failures = this.memberFailures.get(member.memberId)
    if (failures?.activation !== undefined) return Object.freeze({ member, availability: 'unavailable', presence: 'unavailable', diagnostic: failures.activation })
    const handle = this.handles.get(member.memberId)
    if (handle === undefined) return Object.freeze({ member, availability: 'unavailable', presence: 'unavailable' })
    // A rollover commits its ledger binding before the old generation retires
    // and the new one activates; during that window the live handle still runs
    // the previous Session. The Member stays visible but must not report the
    // new binding as active — a Client following the row would otherwise open
    // a Session that does not exist yet.
    if (handle.agent.id !== member.sessionId) return Object.freeze({ member, availability: 'unavailable', presence: 'unavailable', diagnostic: { class: 'rollover' as const, detail: 'context rollover in progress' } })
    if (this.ctx.agentPresets.composedPreset(handle.agent.ctx) === undefined) {
      return Object.freeze({ member, availability: 'active', presence: 'error', diagnostic: { class: 'preset-composition' as const, detail: ORPHANED_MEMBER_DIAGNOSTIC } })
    }
    const runtimeError = failures?.runtime ?? failures?.compaction
    if (runtimeError !== undefined) return Object.freeze({ member, availability: 'active', presence: 'error', diagnostic: { class: 'runtime' as const, detail: runtimeError } })
    // Capability warnings are runtime-derived at activation (handles-scoped,
    // like failures): absent while capabilities resolve cleanly.
    const capabilityWarnings = this.memberRuntime.capabilityWarningsFor(member.memberId)
    return Object.freeze({
      member, availability: 'active', presence: handle.agent.status === 'running' ? 'working' : 'available',
      ...(capabilityWarnings === undefined ? {} : { capabilityWarnings }),
    })
  }

  private setMemberFailure(memberId: AgentTeamMemberId, slot: 'runtime' | 'compaction', message: string): void {
    const failures = this.memberFailures.get(memberId) ?? {}
    failures[slot] = message
    this.memberFailures.set(memberId, failures)
  }

  /** Store one structured activation diagnostic; runtime/compaction slots stay plain messages. */
  private setActivationDiagnostic(memberId: AgentTeamMemberId, diagnostic: AgentTeamMemberDiagnostic): void {
    const failures = this.memberFailures.get(memberId) ?? {}
    failures.activation = Object.freeze(diagnostic)
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

  private clearMemberFailure(memberId: AgentTeamMemberId, slot: 'activation' | 'runtime' | 'compaction'): boolean {
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
      if (handle !== undefined) this.afterCommit(`notification for '${this.memberLabel(memberId)}'`, () => this.notifyMember(handle.agent))
    }
    // Task acceptance no longer schedules standalone auto compaction: it is
    // a semantic checkpoint/context cue (delivered as ordinary Team
    // notification), and the Team pressure policy owns compaction entry.
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

  /** Model-visible active-Claim labels for the pressure notice. */
  private activeClaimLabels(memberId: AgentTeamMemberId): readonly string[] {
    const ledger = this.ledger
    if (ledger === undefined) return []
    const labels: string[] = []
    for (const claim of ledger.activeClaimsForMember(memberId)) {
      if (claim.state !== 'active') continue
      labels.push(`${claim.claimRef} (${claim.direction})`)
    }
    return labels
  }

  /** Model-visible running/stopping job labels for the pressure notice. */
  private runningJobLabels(memberId: AgentTeamMemberId): readonly string[] {
    const handle = this.handles.get(memberId)
    if (handle === undefined) return []
    const jobs = handle.agent.ctx.get('jobs')
    if (jobs === undefined) return []
    return jobs.list(handle.agent)
      .filter((job: { status: string }) => job.status === 'running' || job.status === 'stopping')
      .map((job: { id: string; name?: string }) => `${job.name ?? job.id}`)
  }

  private emitAutoCompactionChanged(memberId: AgentTeamMemberId): void {
    for (const workspaceId of this.ledger?.workspacesOf(memberId) ?? []) this.emitPresenceChanged(workspaceId)
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

  /** Wake from durable unread state with bounded facts for direct and state-changing work. */
  private notifyMember(agent: Agent, sequenced = false): void {
    const member = this.memberForAgent(agent)
    if (member === undefined || member.state !== 'enabled') return
    const notifications = this.requireLedger().notificationFacts(member.memberId)
    if (notifications.length === 0) {
      this.notifiedInbox.delete(member.memberId)
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
    if (this.notifiedInbox.get(member.memberId) === signature) return
    const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
    // steerResume already combines the recovery instruction and these durable
    // facts. Its synchronous running transition must not replace that notice.
    if (pending.some(message => this.isRecoveryNotice(message))) {
      this.notifiedInbox.set(member.memberId, signature)
      return
    }
    const existingInboxHint = pending.find(message => this.isInboxNotice(message))
    if (existingInboxHint !== undefined) agent.inbox.remove(existingInboxHint.id)
    const hint = createUserMessage({
      content: [{ type: 'text', text: this.notificationText(notifications, member.memberId) }],
      source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: INBOX_NOTICE_SUMMARY },
    })
    this.notifiedInbox.set(member.memberId, signature)
    try {
      // Steer normally claims the nearest step boundary — which would
      // preempt carried input that a rollover or crash recovery queued as
      // ordinary next-turn messages. The sequenced mode enqueues the
      // rederived Inbox as its own follow-up turn instead, so the delivery
      // order stays handoff → carried input → rederived Inbox.
      if (sequenced) agent.followup(hint)
      else agent.steer(hint)
    } catch (error) {
      this.clearMemberNotificationState(member.memberId)
      throw error
    }
  }

  private isInboxNotice(message: UserMessage): boolean {
    const source = message.source
    return isAgentTeamSource(source)
      && source.form === 'notice' && source.summary === INBOX_NOTICE_SUMMARY
  }

  private isRecoveryNotice(message: UserMessage): boolean {
    const source = message.source
    return isAgentTeamSource(source)
      && source.form === 'notice' && source.summary === RECOVERY_NOTICE_SUMMARY
  }

  private notificationText(notifications: ReturnType<AgentTeamLedger['notificationFacts']>, readerId?: AgentTeamMemberId): string {
    const maxCharacters = 32 * 1024
    const sections: string[] = ['Team Inbox has unread work.']
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
          const detail = ['Direct Team mention', `Occurred at: ${formatTeamTimestamp(fact.occurredAt)}`, `From: ${sender}`, `Channel: ${item.channelRef}`,
            ...(item.task === undefined ? [] : [`Task: ${item.task.taskRef}`]),
            `Thread: ${item.thread.threadRef}`, `Message ref: ${fact.message.messageRef}`,
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
    const limit = 8 * 1024
    return body.length <= limit ? body : `${body.slice(0, limit)}\n[Message body truncated; use team_thread read for the full Message.]`
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
      await handle.dispose()
      this.handles.delete(memberId)
    }
    this.memberBySessionId.delete(member.sessionId)
    this.modelSelections.delete(memberId)
    this.memberRuntime.forgetMember(memberId)
    this.clearMemberFailure(memberId, 'activation')
  }

  private clearMemberRecoveryState(member: Pick<AgentTeamAgentMember, 'memberId' | 'sessionId'>): void {
    this.recovery.stopTracking(member.memberId)
    this.clearMemberFailure(member.memberId, 'runtime')
    this.clearMemberNotificationState(member.memberId)
  }

  private clearMemberNotificationState(memberId: AgentTeamMemberId): void {
    this.notifiedInbox.delete(memberId)
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

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    this.requireAccepting()
    const result = this.lifecycleTail.then(operation)
    this.lifecycleTail = result.then(() => {}, () => {})
    return result
  }
}
