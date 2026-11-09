/**
 * Durable Agent Team Host capability.
 *
 * The Host owns the append-only collaboration ledger and all Member lifecycle
 * effects. Session history and browser state are projections, never Team facts.
 * @module @contexera/dsh-agent-team
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { installModelSelection, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-app-boot'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-tools'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { DomainFacility, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { ATTACHMENT_MAX_BYTES, attachmentPayloadPath, attachmentsRoot, copyPathAttachment, pathAttachmentId, readAttachment, removeAttachment, sanitizeMediaType, sweepAttachmentCache, validatePathAttachment, writeRequestScopedAttachment } from './attachments.ts'
import { reportEnvironment } from './environment-check.ts'
import { HUMAN_PROFILE_DEFAULT_NAME, HUMAN_PROFILE_REPO_URL, HUMAN_PROFILE_VERSION, assertValidHumanName, normalizeHumanName, parseLegacyHumanProfile, parseRowHumanProfile, type LegacyHumanProfileFields } from './human-profile.ts'
import { TEAM_HOST_ROW_SETTINGS_SCHEMA, planHostRowWrite, type Config, type HostRowWrite } from './host-row-settings.ts'
import { HUMAN_PROFILE_SETTINGS_NAMESPACE, LEGACY_HUMAN_PROFILE_SETTINGS_NAMESPACE } from './human-settings.ts'
import { readableSidebarOrders, sanitizeSidebarOrderRefs, sidebarOrderKeyProblem } from './sidebar-order.ts'
import { humanAvatarsRoot, readHumanAvatar, removeHumanAvatar, writeHumanAvatar } from './human-avatar.ts'
import { createHumanUpdateChecker } from './human-update-check.ts'
import { AgentTeamInvariantError } from './invariant.ts'
import { createCheckpointContinuationMessage } from './context-codec.ts'
import { TeamContextManagement, type TeamTransitionPlan } from './team-context-management.ts'
import { decideWakeRecycle, type WakeRecycleConfig, type WakeRecyclePlan } from './wake-recycle.ts'
import { createAcceptanceReminder, planAcceptanceContext } from './acceptance-context.ts'
import { installMemberCompaction, type MemberCompactionConfig } from './member-compaction.ts'
import { AGENT_TEAM_PLUGIN_ID, isAgentTeamContextSource, isAgentTeamSource } from './context-source.ts'
import { surfaceVisibilityProbe, teamMessageSurface, visibleTeamSurface, isFactOnSurface, isMainEntryOnSurface } from './surface-visibility.ts'
export { teamMessageSurface, visibleTeamSurface, missingMessageRange } from './surface-visibility.ts'
export { activityFact, activityText, type ActivityFact } from './activity-facts.ts'
import { carriedInputOf, createTeamContextProjectionDefinition, foldTeamContextProjection, isAcceptanceNotice, TEAM_INBOX_NOTICE_SUMMARY, TEAM_RECOVERY_NOTICE_SUMMARY, type TeamContextProjectionState } from './context-projection.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID, AgentTeamLedger, agentTeamHostActor, agentTeamHumanActor } from './ledger.ts'
import { AGENT_TEAM_TOOL_NAMES, deepCopyCapabilities, memberMemoryDirectoryName, MemberRuntime, type TurnBoundary } from './member-runtime.ts'
import { classifyRecoverableError, failureDetail, RecoveryCoordinator, type RecoveryFact } from './recovery.ts'
import { StoredSessionReadError, StoredSessionReader, sessionFailureOf, type StoredSessionInspection } from './stored-session-reader.ts'
import { WorkerRefusal, WorkerRegistry, type AgentTeamWorkerRun, type WorkerDelegationRequest } from './worker-service.ts'
import { coldInboxOf } from './cold-inbox.ts'
import { agentTeamDomainSpec } from './spec.ts'
import { subscriptionDomainSpec } from './subscription-store.ts'
import { INITIAL_CHECKPOINT, SubscriptionScheduler, type SubscriptionCheckpoint, type SubscriptionRunOutcome } from './subscription-runtime.ts'
import { baselineIdsOf, failureCategory, failureTail, missingCredentials, probeShellFamily, runSubscriptionScript, type ShellFamilyProbe, type SubscriptionCredentials, type SubscriptionRunCategory, type SubscriptionRunReport, type SubscriptionShellExecutor } from './subscription-runner.ts'
import { deliveryEntryOf, deliveryKey, deliveryKeysOf, deliveryRecordOf, evictedDeliveries, evictedRunKeys, failedDeliveries, replayKey, replayKeysOf, runRecordOf, runSummaryOf, subscriptionRunKey, subscriptionRunKeysOf, SUBSCRIPTION_DELIVERY_LIMIT, SUBSCRIPTION_RUN_HISTORY_LIMIT, type SubscriptionDeliveryInput, type SubscriptionDeliveryRecord, type SubscriptionReplayRecord, type SubscriptionRunRecord, type SubscriptionRunTrigger } from './subscription-runs.ts'
import { snapshotScript, subscriptionDefinitionProblem, SUBSCRIPTION_FAILURES_BEFORE_PAUSE, SUBSCRIPTION_PENDING_MAX, SUBSCRIPTION_SCRIPT_MAX_BYTES, type SubscriptionCredential, type SubscriptionEvent, type SubscriptionScriptSnapshot, type SubscriptionTriggers } from './subscriptions.ts'
import { SqliteStorageBackend } from './vendor/storage-sqlite/index.ts'
import { formatTeamTimestamp } from './time-format.ts'
import { planInboxDelivery, type InboxDeliveryPlan, type InboxMemberReminder } from './inbox-delivery.ts'
import { renderInboxNotice, type RenderedInboxNotice } from './inbox-notice.ts'
import { MemberIdleTracker } from './member-idle.ts'
import type {
  AgentTeamAddMemberRequest,
  AgentTeamAddMemberResult,
  AgentTeamAgentMember,
  AgentTeamAgentMemberStatus,
  AgentTeamArchiveProjectRequest,
  AgentTeamArchiveProjectResult,
  AgentTeamArchiveMemberRequest,
  AgentTeamArchiveMemberResult,
  AgentTeamChangeScope,
  AgentTeamDelegationTarget,
  AgentTeamWorkerAnswer,
  AgentTeamWorkerStateView,
  AgentTeamChangesRequest,
  AgentTeamChangesResult,
  AgentTeamActivityRef,
  AgentTeamClaimList,
  AgentTeamClaimRequest,
  AgentTeamClaimResult,
  AgentTeamClientMemberStatus,
  AgentTeamActor,
  AgentTeamAttachmentId,
  AgentTeamBaselineSubscriptionRequest,
  AgentTeamCreateSubscriptionRequest,
  AgentTeamCreateSubscriptionRequestIntent,
  AgentTeamModelSelection,
  AgentTeamCreateProjectRequest,
  AgentTeamCreateProjectResult,
  AgentTeamEnvironmentRequest,
  AgentTeamEnvironmentResult,
  AgentTeamGetAttachmentRequest,
  AgentTeamGetAttachmentResult,
  AgentTeamGetHumanAvatarRequest,
  AgentTeamGetHumanAvatarResult,
  AgentTeamHumanProfileRequest,
  AgentTeamSidebarOrderRequest,
  AgentTeamSidebarOrderResult,
  AgentTeamSidebarOrderWriteRequest,
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
  AgentTeamMainStreamHistory,
  AgentTeamMainStreamHistoryRequest,
  AgentTeamMainStreamReadRequest,
  AgentTeamMainStreamReadResult,
  AgentTeamPostMainMessageRequest,
  AgentTeamPostMainMessageResult,
  AgentTeamStartThreadRequest,
  AgentTeamStartThreadResult,
  AgentTeamSetHumanProfileRequest,
  AgentTeamSetHumanProfileResult,
  AgentTeamSetMemberStateRequest,
  AgentTeamStatus,
  AgentTeamSubscription,
  AgentTeamSubscriptionBaselineResult,
  AgentTeamSubscriptionChangeResult,
  AgentTeamSubscriptionDeliveriesRequest,
  AgentTeamSubscriptionDeliveriesResult,
  AgentTeamSubscriptionDraftTrialRequest,
  AgentTeamSubscriptionDraftTrialResult,
  AgentTeamSubscriptionListRequest,
  AgentTeamSubscriptionListResult,
  AgentTeamSubscriptionMetadata,
  AgentTeamSubscriptionLogEntry,
  AgentTeamSubscriptionLogsRequest,
  AgentTeamSubscriptionLogsResult,
  AgentTeamSubscriptionRef,
  AgentTeamSubscriptionReplayRequest,
  AgentTeamSubscriptionReplayResult,
  AgentTeamSubscriptionReplayVersion,
  AgentTeamSubscriptionScriptSource,
  AgentTeamSubscriptionRequestIntent,
  AgentTeamSubscriptionStateRequest,
  AgentTeamSubscriptionTrialFailure,
  AgentTeamSubscriptionTrialResult,
  AgentTeamSubscriptionWriteResult,
  AgentTeamTask,
  AgentTeamTaskBoard,
  AgentTeamTaskBoardRequest,
  AgentTeamTaskRequest,
  AgentTeamTaskResult,
  AgentTeamTransferTaskRequest,
  AgentTeamTransferTaskResult,
  AgentTeamThreadAttentionRequest,
  AgentTeamThreadAttentionResult,
  AgentTeamMainAttentionResult,
  AgentTeamThreadAttentionStatus,
  AgentTeamMainAttentionStatus,
  AgentTeamProjectRef,
  AgentTeamThreadHistory,
  AgentTeamThreadHistoryRequest,
  AgentTeamThreadReadRequest,
  AgentTeamThread,
  AgentTeamThreadReadResult,
  AgentTeamMemberDiagnostic,
  AgentTeamThreadObservations,
  AgentTeamThreadObservationsRequest,
  AgentTeamTestSubscriptionRequest,
  AgentTeamUpdateProjectRequest,
  AgentTeamUpdateSubscriptionRequest,
  AgentTeamProject,
  AgentTeamProjectOwnerRequest,
  AgentTeamProjectOwnerResult,
  AgentTeamUpdateProjectResult,
  AgentTeamUpdateMemberRequest,
  AgentTeamUpdateMemberResult,
  AgentTeamView,
  AgentTeamViewRequest,
  AgentTeamMemberReminderView,
  AgentTeamMemberReminderListRequest,
  AgentTeamMemberReminderCreateRequest,
  AgentTeamMemberReminderCreateResult,
  AgentTeamMemberReminderCancelRequest,
  AgentTeamMemberReminderCancelResult,
  AgentTeamUnreadMemberReminder,
  AgentTeamWebhookIntakeRequest,
  AgentTeamWebhookIntakeResult,
} from './types.ts'

export { agentTeamDomainSpec, agentTeamOperationSchema } from './spec.ts'
export { subscriptionDomainSpec } from './subscription-store.ts'
export { SubscriptionScheduler, type SubscriptionAdmissionPolicy, type SubscriptionCheckpoint, type SubscriptionRunOutcome } from './subscription-runtime.ts'
export { baselineIdsOf, detectShellFamily, failureTail, missingCredentials, probeShellFamily, runSubscriptionScript, type ShellFamilyProbe, type SubscriptionCredentials, type SubscriptionRunReport } from './subscription-runner.ts'
export {
  parseSubscriptionOutput,
  scriptHash,
  snapshotScript,
  subscriptionDefinitionProblem,
  SUBSCRIPTION_ENV_PREFIX,
  SUBSCRIPTION_FAILURES_BEFORE_PAUSE,
  SUBSCRIPTION_MAX_PER_PROJECT,
  SUBSCRIPTION_MIN_INTERVAL_MINUTES,
  SUBSCRIPTION_PENDING_MAX,
  SUBSCRIPTION_PUBLISH_PER_MINUTE,
  SUBSCRIPTION_RUN_TIMEOUT_MS,
  SUBSCRIPTION_SCRIPT_MAX_BYTES,
  SUBSCRIPTION_STDOUT_MAX_BYTES,
  type SubscriptionCredential,
  type SubscriptionEvent,
  type SubscriptionScriptSnapshot,
  type SubscriptionShell,
  type SubscriptionTriggers,
} from './subscriptions.ts'
import { WEBHOOK_QUEUE_LIMIT, WEBHOOK_QUEUE_RETRY_AFTER_SECONDS, webhookAddress, webhookOriginRefusal,
  WEBHOOK_PUMP_INTERVAL_MS, webhookRetryDelayMs, webhookStdin } from './subscription-webhook.ts'
import { admissionAttemptRequestId, admissionDeliveryRef, admissionKey, admissionKeysOf, admissionRefFor, dueAdmissions,
  type SubscriptionAdmissionRecord } from './subscription-admissions.ts'
export type * from './types.ts'
export { AGENT_TEAM_HUMAN_HANDLE, AGENT_TEAM_HUMAN_MEMBER_ID, AGENT_TEAM_INITIALIZE_REQUEST_ID } from './ledger.ts'
export { HUMAN_PROFILE_DEFAULT_NAME, HUMAN_PROFILE_REPO_URL, HUMAN_PROFILE_SETTINGS_SCHEMA, HUMAN_PROFILE_VERSION, assertValidHumanName, normalizeHumanName } from './human-profile.ts'
export { DEFAULT_WEBHOOK_CONFIG, HOST_ROW_FIELDS, MEMBER_COMPACTION_SETTINGS_SCHEMA, TEAM_HOST_ROW_SETTINGS_SCHEMA, WAKE_RECYCLE_SETTINGS_SCHEMA, WEBHOOK_SETTINGS_SCHEMA, planHostRowWrite, type Config, type HostRowField, type HostRowWrite, type WebhookConfig } from './host-row-settings.ts'
export { HUMAN_PROFILE_SETTINGS_NAMESPACE, LEGACY_HUMAN_PROFILE_SETTINGS_NAMESPACE } from './human-settings.ts'
export { humanAvatarsRoot } from './human-avatar.ts'
export { AGENT_TEAM_TOOL_NAMES } from './member-runtime.ts'
export { MEMBER_REMINDER_REF_PATTERN, reminderRefForCallId, reminderRefIsStorable } from './member-reminders.ts'

/** Process-stable marker carried by the final Team message tool definition. */
export const AGENT_TEAM_PRESET_MARKER = Symbol.for('@contexera/dsh-agent-team.preset')

const ORPHANED_MEMBER_DIAGNOSTIC = 'Member preset composition was lost after a reload; its tools are unavailable. Resume rebuilds the member in place.'
const NOTIFICATION_QUEUE_THRESHOLD = 8
/**
 * How many consecutive Member-reminder consumption writes may fail before the
 * Host stops rederiving the notice for them. Each retry spends one of the
 * Member's turns, so a persistent storage outage must not spend them forever;
 * the occurrence stays owed and the coverage stays dropped either way.
 */
const MAX_MEMBER_REMINDER_CONSUME_RETRIES = 3

/** Node caps one `setTimeout` delay at 2^31-1 ms and silently shortens a longer one to 1 ms, so a farther wake arms in capped slices and re-evaluates when a slice ends. */
const MEMBER_REMINDER_TIMER_MAX_DELAY_MS = 2 ** 31 - 1

/** Read one profile or settings document, or `undefined` when it is absent or unreadable; both are steady states on a first boot. */
async function readProfileDocument(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

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
 * What one finished run answers: what it produced, the ref that names it, and
 * whether its private record exists. The last two are deliberately independent —
 * losing the diagnostic copy must not turn a delivered output into a failure.
 */
interface SubscriptionRunResult {
  readonly outcome: 'accepted' | 'empty' | 'failed' | 'backlog' | 'deferred'
  readonly report: SubscriptionRunReport
  readonly runRef: string
  readonly recorded: boolean
  /** Events this run had accepted into the ledger; 0 unless the outcome is `accepted`. */
  readonly eventCount: number
}

/** What accepting one run's output decided, read under the subscription's write lock. */
type AgentTeamAcceptDecision =
  | { readonly outcome: 'accepted'; readonly eventCount: number }
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'backlog' }
  | { readonly outcome: 'deferred' }
  | { readonly outcome: 'dropped' }

/**
 * Why one Inbox wake ran: the committed operation (with its request id) or the lifecycle step rederiving the same durable facts.
 * A retry after a failed wake is a new attempt over the same facts, never a new request.
 */
type NotificationCause =
  | { readonly kind: 'commit'; readonly receipt: AgentTeamOperationReceipt; readonly operationKind: AgentTeamOperation['kind'] }
  | { readonly kind: 'transition'; readonly requestId: AgentTeamRequestId; readonly previousSessionId: SessionId }
  | { readonly kind: 'activation'; readonly previousSessionId?: SessionId }
  | { readonly kind: 'running' }
  | { readonly kind: 'consumption-retry' }

/**
 * One Member's Inbox notice delivery state. `covered` is the durable fact set the queued notice answers;
 * `attempt` counts delivery attempts. A failed delivery keeps `attempt` and drops `covered`, so the next fact rederives and retries.
 */
interface InboxNoticeDelivery {
  readonly covered: string
  readonly attempt: number
  /**
   * Threads whose facts the last notice could not render — the section cap or
   * the character budget dropped them. They keep their facts out of the next
   * signature, so an unchanged rederivation retries them rather than treating
   * them as delivered by a notice that never named them.
   */
  readonly undelivered: readonly AgentTeamThreadRef[]
}

function sameChangeScope(left: AgentTeamChangeScope, right: AgentTeamChangeScope): boolean {
  if (left.kind === 'workspace' && right.kind === 'workspace') return left.workspaceId === right.workspaceId
  if (left.kind === 'project' && right.kind === 'project') return left.projectRef === right.projectRef
  if (left.kind === 'thread' && right.kind === 'thread') return left.threadRef === right.threadRef
  if (left.kind === 'presence' && right.kind === 'presence') return left.workspaceId === right.workspaceId
  return false
}

export function markAgentTeamPreset<T extends object>(definition: T): T {
  Object.defineProperty(definition, AGENT_TEAM_PRESET_MARKER, { value: true })
  return definition
}

/**
 * Whether the running dsh loads workspace packages from source via tsx.
 * tsx honors the Harness tsconfig path map onto `src/`, while a profile-installed bundle resolves compiled `lib/`: two module instances with independent scope keys.
 */
export function isTsxDevMode(): boolean {
  const flags = [...process.execArgv]
  const nodeOptions = process.env.NODE_OPTIONS
  if (nodeOptions !== undefined) flags.push(...nodeOptions.split(/\s+/))
  return flags.some(flag => flag.includes('tsx'))
}

/**
 * Activation diagnostic for a dsh-scope module-instance mismatch: the harness sees a scope key this bundle does not,
 * so the two sides loaded different physical copies of `@deepseek-ai/dsh-scope`.
 */
export function teamPresetScopeMismatchMessage(tsxDevMode: boolean): string {
  if (tsxDevMode) {
    return 'selected preset is not team-enabled: the dsh CLI is running from source via tsx (tsconfig paths resolve @deepseek-ai/dsh-scope to src/), so the harness and this bundle load different module instances; start dsh with the compiled CLI instead (pnpm dsh, node apps/cli/lib/bin.js, or npx @deepseek-ai/dsh)'
  }
  return 'selected preset is not team-enabled: this bundle and the harness resolved different physical copies of @deepseek-ai/dsh-scope; run pnpm install in the profile directory so node_modules matches the lockfile, then restart'
}

/**
 * One adoption's ledger request id. The event sequence restarts with every Session, so a Member that changes generation
 * would reuse the previous generation's id at the same sequence: the ledger's collision guard refuses that write and the
 * adoption is dropped silently. The Session is part of the identity, and the route comparison keeps a replay idempotent.
 */
export function adoptionRequestId(memberId: AgentTeamMemberId, sessionId: SessionId, seq: number): AgentTeamRequestId {
  return `${memberId}:${sessionId}:request-${seq}` as AgentTeamRequestId
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
    'agent-team/committed'(event: AgentTeamCommitted): void
  }
}

export default class AgentTeam extends TypertRemoteService {
  static Config = TEAM_HOST_ROW_SETTINGS_SCHEMA
  static inject = [
    'storageDomain',
    'tokenMeter',
    'workspaceRegistry',
    'agents',
    'agentDefaultModel',
    'agentPresets',
    'tools',
    'sessionPersistence',
    'sessionProjections',
  ]

  private backend?: SqliteStorageBackend
  private domain?: Domain<typeof agentTeamDomainSpec>
  private ledger?: AgentTeamLedger
  /** The scheduler's private state: deleting it changes no domain fact, so it is not part of the ledger. */
  private subscriptionDomain?: Domain<typeof subscriptionDomainSpec>
  private subscriptionTable?: KvTable<AgentTeamSubscriptionRef, SubscriptionCheckpoint>
  /** The last fifty runs of every subscription, keyed by subscription then start instant. */
  private subscriptionRunsTable?: KvTable<string, SubscriptionRunRecord>
  /** The deliveries whose automatic retries were spent, waiting for an owner. */
  private subscriptionDeliveriesTable?: KvTable<string, SubscriptionDeliveryRecord>
  /** The answer each replay request already got, keyed by subscription then request id. */
  private subscriptionReplaysTable?: KvTable<string, SubscriptionReplayRecord>
  /** The deliveries still owing work: one row per admission. */
  private subscriptionAdmissionsTable?: KvTable<string, SubscriptionAdmissionRecord>
  /** The pass that runs due webhook deliveries; it stops with the Host. */
  private admissionPumpTimer?: ReturnType<typeof setInterval> | undefined
  /** One pass at a time: a second one would read the same rows and start them twice. */
  private admissionPumpRunning = false
  private subscriptionScheduler?: SubscriptionScheduler
  private readonly subscriptionCheckpoints = new Map<AgentTeamSubscriptionRef, SubscriptionCheckpoint>()
  /**
   * One subscription's private read-modify-write steps, serialized. Two webhook
   * deliveries that arrive together must not both add one to the same old
   * failure count, or three spent retries would pause later than the third.
   */
  private readonly subscriptionWriteTails = new Map<AgentTeamSubscriptionRef, Promise<void>>()
  /** The probe once it answers with a family, cached for the composition's lifetime; a refusal is retried. */
  private subscriptionShellProbe: Promise<ShellFamilyProbe> | undefined
  private readonly handles = new Map<AgentTeamMemberId, AgentHandle>()
  /** Reader of the awaited context-projection registration; unloading Team releases it. */
  private contextProjection: ProjectionHandle<TeamContextProjectionState> | undefined
  /** Agent ids with a turn in flight; restarts must wait for the boundary. */
  private readonly runningAgents = new Set<SessionId>()
  private readonly memberRuntime = new MemberRuntime({
    ctx: this.ctx,
    liveMemberContext: memberId => this.liveContextFor(memberId),
    runningAgents: this.runningAgents,
  })
  /**
   * The single seam for every per-Session stored read: handle lifecycle and failure normalization live here,
   * and consumers choose policy by failure category instead of matching error text.
   */
  private readonly sessionReader = new StoredSessionReader(this.ctx)
  /**
   * Why one Member shows error presence, per failure source. Reads prefer activation, then runtime, then compaction;
   * slots clear independently, so a recovered runtime error re-reveals an outstanding compaction failure.
   * Keyed by Member rather than Session so a restarted Session cannot leak stale keys.
   */
  private readonly memberFailures = new Map<AgentTeamMemberId, {
    activation?: AgentTeamMemberDiagnostic
    runtime?: string
    /** A Team wake was discarded before the Agent opened its turn boundary. */
    preTurnCancellation?: AgentTeamMemberDiagnostic
    /** The post-commit configuration apply failed; the stored row is ahead of the live surface. */
    capabilityApply?: AgentTeamMemberDiagnostic
  }>()
  /**
   * The Workers this Host started. Team owns the execution record and the refusal
   * rules; the Harness subagent service owns admission and the parent notice.
   */
  private readonly workerRegistry = new WorkerRegistry(this.ctx, {
    config: () => this.config.worker.get(),
    projectExists: projectRef => this.requireLedger().hasProject(projectRef),
    projectOwners: projectRef => this.requireLedger().projectOwnerIds(projectRef),
    recordStarted: async write => {
      const result = await this.requireLedger().recordWorkerStarted(write)
      if (result.committed) this.emitCommitted(result.value.receipt)
      return result.value.execution
    },
    // A bound run's ending is the fact that wakes its initiator, so the commit
    // that made it durable is what publishes it.
    recordSettled: async write => {
      const result = await this.requireLedger().recordWorkerSettled(write)
      if (result.committed) this.emitCommitted(result.value.receipt)
    },
    warn: message => { this.ctx.logger.warn(`agent-team: ${message}`) },
  })
  /** Team notice ids waiting for a turn boundary, keyed by the live Agent message id. */
  private readonly pendingTeamWakes = new Map<string, { readonly memberId: AgentTeamMemberId; readonly sessionId: SessionId }>()
  /** Agents that already spent their one acceptance boundary; cleared when the Agent settles. */
  private readonly acceptanceBoundaries = new WeakSet<Agent>()
  /** Notice removals initiated by Team itself, which are normal replacement/disposal operations. */
  private readonly expectedInboxDiscards = new Set<string>()
  /**
   * Per-Member Inbox notice delivery: the unread facts the last attempt covered and the attempts they have spent.
   * A retry after a failed wake spends the next attempt over the same durable facts, never a second operation.
   */
  private readonly inboxNoticeDeliveries = new Map<AgentTeamMemberId, InboxNoticeDelivery>()
  /**
   * Queued Team notices that carry Member reminders, keyed by message id. The
   * claim of a message is the only evidence that its reminders reached a turn,
   * and each entry names the occurrences that message actually rendered, so a
   * claim consumes exactly those and nothing newer.
   */
  private readonly memberReminderWakes = new Map<string, { readonly memberId: AgentTeamMemberId; readonly reminders: readonly InboxMemberReminder[] }>()
  /**
   * Consecutive Member-reminder consumption writes that failed for one Member.
   * Process-local like the notice coverage it bounds: a restart starts over, and
   * a successful write clears it.
   */
  private readonly memberReminderConsumeFailures = new Map<AgentTeamMemberId, number>()
  /** The timer armed for the next Member-reminder occurrence, rearmed after every raise. */
  private memberReminderTimer?: ReturnType<typeof setTimeout> | undefined
  private attachmentGcTimer?: ReturnType<typeof setInterval> | undefined
  /**
   * New-release check behind the settings footnote. Memory-only and background-refreshed,
   * so the profile read path never waits on the network and every failure settles as "no update known".
   */
  private readonly humanUpdateCheck = createHumanUpdateChecker({ currentVersion: HUMAN_PROFILE_VERSION })

  private readonly memberIdle = new MemberIdleTracker()
  private reminderEvaluationTail: Promise<void> = Promise.resolve()
  private reminderEvaluationRequested = false

  private readonly recovery = new RecoveryCoordinator({
    wake: memberId => { this.injectRecovery(memberId) },
    report: fact => { this.reportRecovery(fact) },
  })
  private readonly contextManagement = new TeamContextManagement({
    memberForAgent: agent => this.memberForAgent(agent),
    projectionForMember: (memberId, sessionId) => {
      const handle = this.handles.get(memberId)
      if (handle === undefined || handle.agent.session.id !== sessionId) return undefined
      return this.contextProjection?.stateOf(handle.agent.session)
    },
    executeTransition: (memberId, plan) => this.executeMemberTransition(memberId, plan),
    messages: {
      continuation: checkpointRef => createCheckpointContinuationMessage(checkpointRef),
    },
    log: message => { this.ctx.logger.warn(`agent-team: ${message}`) },
  })
  /**
   * Per-Member lifecycle chains: one Member's long waits (turn boundary, idle) hold only that Member's later operations.
   * Order within a chain is submission order; cross-Member commits stay ordered by the ledger's single writer queue.
   */
  private readonly memberLifecycleTails = new Map<AgentTeamMemberId, Promise<void>>()
  private readonly retiringAgents = new WeakSet<Agent>()
  private readonly enteredMemberChains = new AsyncLocalStorage<ReadonlySet<AgentTeamMemberId>>()
  private readonly enteredAdditionChains = new AsyncLocalStorage<ReadonlySet<AgentTeamRequestId>>()
  /**
   * addMember chains by request id: the Member id does not exist until the
   * commit answers, and concurrent duplicates of one request must serialize
   * so exactly one of them activates the replayed id.
   */
  private readonly additionLifecycleTails = new Map<AgentTeamRequestId, Promise<void>>()
  /** Deferred notification effects leave durable writes and Client invalidation on the caller's path; each Member keeps its own effect chain. */
  private readonly notificationEffectTails = new Map<AgentTeamMemberId, Promise<void>>()
  /** Resolves when Host teardown starts: in-chain idle waits release on it instead of outliving the Host. */
  private readonly shutdown = (() => {
    let resolve!: () => void
    const promise = new Promise<void>(finish => { resolve = finish })
    return Object.freeze({ promise, resolve })
  })()
  /** Aborts every Host-owned background operation that would otherwise outlive teardown. */
  private readonly shutdownController = new AbortController()
  private accepting = true
  /** One adoption attempt per boot: the two readiness edges fire once each, and this keeps their attempt single. */
  private legacyAdoptionStarted = false
  /**
   * Presence wake epoch: Agent running/idle/failure has no durable fact behind it, so the presence scope counts those edge wakes in process.
   * It never takes part in a projection waiter's comparison.
   */
  private presenceEpoch = 0
  private readonly changeWaiters = new Set<ChangeWaiter>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentTeam')
    this.ctx.inject(['settings'], settingsCtx => {
      settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, this.ctx.fiber))
      this.migrateLegacyHostRow()
    })
    this.ctx.on('loader/volatile-update', () => {
      this.syncHumanHandle()
    })
  }

  private openTeamStorage(): DomainFacility {
    if (this.ctx.fiber.entry === undefined) return this.ctx.storageDomain
    // Bundle toggling must not replace the Host's global DomainFacility.
    const storageCtx = this.ctx.isolate('storage')
    const storage = new Storage(storageCtx)
    this.backend = new SqliteStorageBackend({ path: dshHomePath('storages', 'agent_team.sqlite'), journalMode: 'wal' })
    storage.backend.register('sqlite', this.backend)
    const facility = new DomainFacility(storageCtx, { backend: 'sqlite', routes: {} })
    storage.mount('domain', facility)
    return facility
  }

  private printableSender(memberId: AgentTeamMemberId): string {
    return memberId === AGENT_TEAM_HUMAN_MEMBER_ID
      ? 'human'
      : this.requireLedger().getMember(memberId)?.handle ?? memberId
  }

  /** What every reply in this window answers, resolved in one pass: a read is a bounded batch and the resolution is a pure ledger lookup. */
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
   * The same fact with its reply target attached, as a new object: writing a read-time projection into a durable read's payload
   * would freeze-throw or leave a stored record carrying a field its schema does not know.
   */
  private withReplyTo(fact: AgentTeamThreadFact, contexts: ReadonlyMap<AgentTeamMessageRef, AgentTeamMessageReplyContext>): AgentTeamThreadFact {
    if (fact.kind !== 'message') return fact
    const ref = fact.message.replyToMessageRef
    const replyTo = ref === undefined ? undefined : contexts.get(ref)
    return replyTo === undefined ? fact : Object.freeze({ ...fact, replyTo })
  }

  /**
   * The `Replies to:` line for one notice, or nothing when it answers nothing.
   * An unresolvable target (e.g. an archived Project) falls back to the bare ref.
   */
  private repliesToLine(message: AgentTeamMessage, workspaceId: WorkspaceId): string | undefined {
    const ref = message.replyToMessageRef
    if (ref === undefined) return undefined
    const parent = this.requireLedger().resolveMessageRefs(workspaceId, [ref])[0]
    return parent === undefined
      ? `Replies to: ${ref}`
      : `Replies to: @${this.printableSender(parent.sender)} — "${parent.excerpt}" [${ref}]`
  }

  /** The live agent context of one Member, resolved at call time; throws when the Member has no live handle. */
  private liveContextFor(memberId: AgentTeamMemberId): Context {
    const handle = this.handles.get(memberId)
    if (handle === undefined) throw new Error(`Agent Member '${this.memberLabel(memberId)}' has no live session for a tool-policy update`)
    return handle.agent.ctx
  }

  private wakeRecycleConfig(): WakeRecycleConfig {
    return this.config.wakeRecycle.get()
  }

  private memberCompactionConfig(): MemberCompactionConfig {
    return this.config.memberCompaction.get()
  }

  /**
   * Whether this generation should be replaced before the next message reaches it. Cheap gates decide from the log's newest event time;
   * only a generation that passed them is priced, because pricing rebuilds a cold Session (a whole-log replay).
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
    } catch (error) {
      this.ctx.logger.warn(`agent-team: could not price Session '${agent.id}' for the wake swap: ${failureDetail(error)}; the generation is kept`)
      return null
    }
  }

  private measureStoredContext(sessionId: SessionId, inspection: StoredSessionInspection): number | null {
    try {
      const session = Session.create(sessionId, inspection.events, inspection.header, inspection.inheritedEventCount)
      // The driver owns the inbox projection and publishes no reader, so this prices the Session's own durable splices; an invalid history keeps the generation.
      const inbox = coldInboxOf(inspection.events)
      if (inbox === undefined || [...inbox['next-turn'], ...inbox['next-step']].some(message => this.isOrdinaryInput(message))) return null
      return this.ctx.tokenMeter.measure(session).totalTokens
    } catch (error) {
      this.ctx.logger.warn(`agent-team: could not price Session '${sessionId}' for the wake swap: ${failureDetail(error)}; the generation is kept`)
      return null
    }
  }

  /**
   * Record the configured route on a resumed Agent. A route the ledger names without an effort keeps the effort its own log recorded for that same route, so a Session-level model edit that never entered the ledger survives the next activation.
   */
  private applyConfiguredRoute(agent: Agent, selection: AgentTeamModelSelection): void {
    const previous = agent.model.current()
    const inherited = previous !== undefined && previous.provider === selection.provider && previous.model === selection.model
      ? previous.reasoningEffort
      : undefined
    const effort = selection.reasoningEffort ?? inherited
    agent.model.select({ provider: selection.provider, model: selection.model, ...effort === undefined ? {} : { reasoningEffort: effort } })
  }

  /**
   * Carry the route a Member's Session actually sent into the ledger.
   *
   * The composer writes its choice into the Session log; this is the only bridge from there into the Team ledger, and it runs on
   * `request/header` — after compaction and the model-switch guard have passed — rather than on the selection event, because a
   * switch the Host refuses (a window that cannot hold the context) keeps the old route and must never become the durable one.
   * A request whose route already equals what the Member would run next is a no-op, so the route Team writes back on activation
   * cannot feed itself through the ledger. Only the route is recorded: the reasoning effort stays a Session-log fact that
   * activation re-reads for that route, so adoption can neither drop an inherited tier nor pin it permanently.
   */
  private adoptMemberRouteFromRequest(memberId: AgentTeamMemberId, agent: Agent, sessionId: SessionId, event: Extract<SessionEvent, { type: 'request/header' }>): void {
    if (this.retiringAgents.has(agent)) return
    let ledger: AgentTeamLedger
    try {
      ledger = this.requireLedger()
    } catch {
      return
    }
    const member = ledger.getMember(memberId)
    if (member === undefined || member.state !== 'enabled') return
    const config = event.data.header.config
    // The header's route was fixed at step preparation, so a pick made since then (settings page or composer) is newer than
    // this request: adopting it here would write the replaced route back over the Human's choice.
    const live = agent.model.current()
    if (live === undefined || live.provider !== config.provider || live.model !== config.model) return
    const running = member.model ?? this.ctx.agentDefaultModel.currentSelection()
    if (running.provider === config.provider && running.model === config.model) return
    // The route alone: the effort belongs to the Session log, where activation re-reads it for the same route. Writing it
    // here would turn an inherited tier into a permanent one that later edits cannot lower.
    const model: AgentTeamModelSelection = Object.freeze({ provider: config.provider, model: config.model })
    const requestId = adoptionRequestId(member.memberId, sessionId, event.seq)
    void ledger.updateMember({
      requestId, memberId: member.memberId, handle: member.handle, description: member.description,
      model, actor: agentTeamHumanActor(),
    }).then((result) => {
      if (result.committed) this.emitCommitted(result.value.receipt)
    }).catch((error: unknown) => {
      this.ctx.logger.warn(`agent-team: could not adopt the request route for member '${this.memberLabel(memberId)}' requestId '${requestId}': ${failureDetail(error)}`)
    })
  }

  private async recycleColdGeneration(member: AgentTeamAgentMember, agent: Agent): Promise<Error | undefined> {
    const queued = this.queuedInputOf(agent)
    if (queued.length > 0) {
      this.ctx.logger.info(`agent-team: ${this.memberScope(member.memberId, agent.id)} keeps its generation: ${queued.length} queued message(s) are still waiting for a turn`)
      return undefined
    }
    const plan = await this.planWakeForMember(member, agent)
    if (plan.action !== 'recycle') return undefined
    this.ctx.logger.info(`agent-team: waking ${this.memberScope(member.memberId, agent.id)} swaps its cold generation: idle ${plan.idleMs}ms over ${plan.thresholds.idleMs}ms, context ${plan.contextTokens} over ${plan.thresholds.minContextTokens}`)
    await this.contextManagement.requestRecycle(member.memberId, { ...member, sessionId: agent.session.id })
    if (this.handles.has(member.memberId)) return undefined
    return new Error('the generation swap did not finish; the recorded Session transition is finished by the next wake or by Member recovery')
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

  /** Current human profile reference from this Host row's Config. `avatarRef` is present only when configured, never explicit `undefined` (exactOptionalPropertyTypes). */
  humanProfile(): { readonly name: string; readonly avatarRef?: string } {
    const avatarRef = this.config.avatarRef.get()
    return Object.freeze({ name: this.humanHandle(), ...(avatarRef === undefined ? {} : { avatarRef }) })
  }

  /** Push the current Config name into the ledger's runtime @ handle; the ledger may not be open yet, and the post-open sync covers that. */
  private syncHumanHandle(): void {
    this.ledger?.setHumanDisplayHandle(this.humanHandle())
  }

  /**
   * The judgements the Config schema cannot make about a Human name: the same non-empty floor as Member handles,
   * plus global uniqueness against live Members. Runs before the write so a colliding rename rejects instead of persisting.
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
   * One-time migration of Host row values that predate the current stored
   * shape. Two sources, in upgrade order: the pre-rename settings namespace
   * (see {@link migrateRenamedHostRowNow}), then the retired
   * `agent-team-human` settings section (see `LEGACY_HUMAN_PROFILE_SECTION`).
   * Whichever readiness edge fires second (settings service, ledger open)
   * starts the attempt; both write only fields the current namespace stores
   * nothing for, once per boot.
   */
  private migrateLegacyHostRow(): void {
    if (this.legacyAdoptionStarted) return
    if (this.ctx.get('settings') === undefined || this.ledger === undefined) return
    this.legacyAdoptionStarted = true
    void this.migrateLegacyHostRowNow().catch((error: unknown) => {
      this.ctx.logger.warn('agent-team: legacy host row migration failed: %s', String(error))
    })
  }

  private async migrateLegacyHostRowNow(): Promise<void> {
    await this.migrateRenamedHostRowNow()
    await this.adoptRetiredHumanSectionNow()
  }

  /**
   * The Host row's own USER layer in the current namespace: exactly the fields
   * the Human wrote there. The resolved config is the wrong signal — it carries
   * schema defaults, so a Human who explicitly stored a value equal to the
   * default would read as "nothing stored" and be overwritten.
   */
  private storedHostRowFields(): Readonly<Record<string, unknown>> {
    const descriptor = this.ctx.get('settings')?.describe().find(row => row.ns === HUMAN_PROFILE_SETTINGS_NAMESPACE)
    return (descriptor?.user ?? {}) as Readonly<Record<string, unknown>>
  }

  /**
   * Writes one migration decision into the current namespace and reports
   * whether anything went out. Every field of the row is volatile, so the
   * settings write is also what makes the value live; nothing else may write
   * the running config.
   *
   * The name still passes the Remote's own judgement: adopting a display name a
   * live Member handle already claims would make the Human unaddressable. That
   * drops only the name — the operational settings in the same plan are
   * independent of it.
   */
  private async writeHostRowValues(plan: HostRowWrite): Promise<boolean> {
    const settings = this.ctx.get('settings')
    if (settings === undefined) return false
    const ops: SettingsPathOp[] = []
    let name = plan.name
    if (name !== undefined) {
      try {
        this.validateHumanProfile({ name })
      } catch (error) {
        this.ctx.logger.warn('agent-team: kept the Host row display name unset: %s', String(error))
        name = undefined
      }
    }
    if (name !== undefined) ops.push({ op: 'set', path: ['name'], value: name })
    // The reference is carried only while its bytes still draw: the avatar
    // store, not the document, is the authority for whether it exists at all.
    if (plan.avatarRef !== undefined && await readHumanAvatar(humanAvatarsRoot(), plan.avatarRef) !== undefined) {
      ops.push({ op: 'set', path: ['avatarRef'], value: plan.avatarRef })
    }
    if (plan.wakeRecycle !== undefined) ops.push({ op: 'set', path: ['wakeRecycle'], value: plan.wakeRecycle })
    if (plan.memberCompaction !== undefined) ops.push({ op: 'set', path: ['memberCompaction'], value: plan.memberCompaction })
    if (ops.length === 0) return false
    await settings.mutate(HUMAN_PROFILE_SETTINGS_NAMESPACE, ops)
    return true
  }

  /**
   * Carries the whole Host row across the `@wowyuarm` → `@contexera` row rename.
   *
   * The settings namespace IS the Host row id, so the rename left every value
   * the row stored — the Human's name and avatar reference AND the operational
   * settings this Host runs with — under an id that no loader entry answers to
   * any more: the composition skips that patch, and the row restarts from
   * schema defaults. That is a silent behaviour reset, not only a cosmetic one:
   * an operator who switched Member compaction off would silently get it back
   * on. The stored values survive only in the profile's own patch document, so
   * this reads them there and writes every field the current namespace stores
   * nothing for.
   *
   * Fields that hold a Cordis expression are not carried: the loader would
   * evaluate them in the row's own context, and this runs outside it, so their
   * source text must never be written back as the value.
   */
  private async migrateRenamedHostRowNow(): Promise<void> {
    const profile = this.ctx.get('profileContext')
    if (profile === undefined) return
    const document = await readProfileDocument(profile.patchPath)
    if (document === undefined) return
    const carried = parseRowHumanProfile(document, LEGACY_HUMAN_PROFILE_SETTINGS_NAMESPACE)
    if (carried === undefined) return
    const plan = planHostRowWrite(this.storedHostRowFields(), carried)
    if (plan === undefined) return
    if (!await this.writeHostRowValues(plan)) return
    this.ctx.logger.info('agent-team: migrated the host row off the pre-rename settings namespace in %s', profile.patchPath)
  }

  private async adoptRetiredHumanSectionNow(): Promise<void> {
    // A profile-launched Host always carries the profile context; a Host booted
    // without one still adopts from the DSH home, which is where the
    // document may still live. Read through `get`: cordis refuses a direct
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
        // Absent candidates are the steady state; the live document is one only because the first boot after the upgrade can race the importer that renames it.
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
    // The same rule as the rename above, on the same signal: a value the Human
    // stored in the current namespace outranks this older document too, so the
    // two migrations cannot disagree about which source wins.
    const plan = planHostRowWrite(this.storedHostRowFields(), { ...legacy })
    if (plan === undefined) return
    if (!await this.writeHostRowValues(plan)) return
    this.ctx.logger.info('agent-team: adopted the retired human settings section from %s', source)
  }

  protected async [Service.init](): Promise<void> {
    // Registered once per Host: the framework keeps one unit per projection key and drives it for every Session, so the fold is session-agnostic.
    // The registration rides this plugin's fiber, so unloading Team releases the key and its cached cells; one owner, never a second disposer.
    this.contextProjection = await this.ctx.sessionProjections.register(createTeamContextProjectionDefinition())
    this.ctx.on('agent/error', ({ agent, error }) => {
      const member = this.memberForAgent(agent)
      if (member === undefined) return
      const message = error instanceof Error ? error.message : String(error)
      this.setMemberFailure(member.memberId, 'runtime', message)
      // Every occurrence is classified here, including verdicts the coordinator reports no state change for;
      // those are logged at diagnostic level to explain why no automatic recovery was scheduled.
      const kind = classifyRecoverableError(error)
      this.ctx.logger.debug(`agent-team: ${this.memberScope(member.memberId, agent.id)} reported an error classified as ${kind === undefined ? 'not automatically recoverable' : `recoverable ${kind}`}: ${message}`)
      this.recovery.onError(member.memberId, error)
      this.emitMemberPresenceChanged(member)
    })
    this.ctx.on('agent/status', ({ agent, status }) => {
      const member = this.memberForAgent(agent)
      if (status === 'running') this.runningAgents.add(agent.id)
      else this.runningAgents.delete(agent.id)
      if (member !== undefined) this.memberIdle.status(member.memberId, status, Date.now())
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
      // The idle transition is presence-affecting (working → available), so it wakes presence watchers like the running transition; otherwise cached Client rows keep showing the Member as working.
      if (status === 'idle' && member !== undefined) {
        this.acceptanceBoundaries.delete(agent)
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
      // The notice reached a turn: that is the moment a Member reminder stops
      // being owed. A Host that dies before this write leaves the marker
      // unconsumed, so the next wake redelivers the same occurrence.
      const carried = this.memberReminderWakes.get(message.id)
      if (carried === undefined) return
      this.memberReminderWakes.delete(message.id)
      this.consumeMemberReminders(carried)
    })
    this.ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      // A discard this Host itself initiated is expected whatever tracked it: the
      // acceptance reminder is not in `pendingTeamWakes`, so this check must not
      // sit behind that lookup or the id would be retained forever.
      if (this.expectedInboxDiscards.delete(message.id)) return
      const pending = this.pendingTeamWakes.get(message.id)
      if (pending === undefined) return
      this.pendingTeamWakes.delete(message.id)
      this.memberReminderWakes.delete(message.id)
      const member = this.memberForAgent(agent)
      if (member === undefined || member.state !== 'enabled' || agent.id !== pending.sessionId) return
      this.setPreTurnCancellation(member.memberId, pending.sessionId)
      this.emitMemberPresenceChanged(member)
    })
    const storageDomain = this.openTeamStorage()
    const domain = await storageDomain.open(agentTeamDomainSpec)
    const subscriptionDomain = await storageDomain.open(subscriptionDomainSpec)
    this.ctx.effect(() => async () => {
      this.accepting = false
      // Stop admitting runs before anything they write stops being served, and
      // wait for the ones already executing: a late result must never reach a
      // store this shutdown is about to close.
      await this.subscriptionScheduler?.stop()
      // Host shutdown must not depend on a turn that may never end: release
      // every wait (in-chain idle waits through the gate, boundary waits
      // through the runtime), so the chains below can drain to zero first.
      this.shutdown.resolve()
      this.shutdownController.abort({ kind: 'disposed' })
      this.memberRuntime.releaseTurnWaits()
      this.recovery.dispose()
      this.contextManagement.dispose()
      await this.workerRegistry.dispose()
      if (this.attachmentGcTimer !== undefined) clearInterval(this.attachmentGcTimer)
      this.attachmentGcTimer = undefined
      if (this.admissionPumpTimer !== undefined) clearInterval(this.admissionPumpTimer)
      this.admissionPumpTimer = undefined
      if (this.memberReminderTimer !== undefined) clearTimeout(this.memberReminderTimer)
      this.memberReminderTimer = undefined
      this.memberReminderWakes.clear()
      this.memberReminderConsumeFailures.clear()
      this.emitChanged()
      // Every lifecycle operation enqueued before `accepting` flipped is in
      // one of the two maps (new ones reject at enqueue), so this snapshot
      // drains them all.
      await Promise.all([...this.memberLifecycleTails.values(), ...this.additionLifecycleTails.values()])
      await this.reminderEvaluationTail
      await Promise.all([...this.handles.values()].map(handle => this.disposeWithWakeGuard(handle)))
      this.handles.clear()
      this.memberRuntime.disposeAll()
      this.runningAgents.clear()
      await domain.close()
      await subscriptionDomain.close()
      await this.backend?.close()
    }, 'agentTeam.dispose')
    this.domain = domain
    const ledger = new AgentTeamLedger(domain.table('operations'), {
      areFactsVisible: surfaceVisibilityProbe(memberId => this.handles.get(memberId)?.agent),
      areMainEntriesVisible: (memberId, entries, projectRef) => {
        const agent = this.handles.get(memberId)?.agent
        if (agent === undefined) return false
        const surface = visibleTeamSurface(agent)
        return entries.every(entry => isMainEntryOnSurface(surface, entry, projectRef))
      },
    })
    this.ledger = ledger
    // A live Config edit in the constructor's window may have arrived before
    // the ledger existed; sync once here so @ matching starts from the stored
    // name.
    this.syncHumanHandle()
    this.migrateLegacyHostRow()
    const initialization = await ledger.initialize()
    if (initialization.committed) this.emitCommitted(initialization.value)
    this.startAttachmentGc(ledger)
    // A downtime make-up is derived from the durable ledger, so boot evaluates
    // it once rather than waiting for the next scheduled occurrence.
    this.scheduleMemberReminderEvaluation()
    // One metadata listing serves every Member restore; per-member list calls
    // would repeat the same I/O linearly during startup.
    const persistedSessions = new Set((await this.persistedSessionHeaders()).map(snapshot => snapshot.header.id))
    await this.sweepWorkspaceParticipations(ledger)
    for (const member of ledger.listMembers()) {
      if (member.state === 'enabled') {
        // A swap that committed but never finished leaves no live handle to reveal it: startup derives the outstanding effects from the ledger and the registry's archive set.
        // A Workspace fault must not keep the Member from running, so activation still runs when the retire half cannot be finished.
        try {
          await this.finishMemberTransition(member.memberId, { knownSessions: persistedSessions })
        } catch (error) {
          this.ctx.logger.warn(`agent-team: could not finish the recorded Session transition for member '${member.handle}': ${error instanceof Error ? error.message : String(error)}`)
        }
        // Activation reads the binding as it stands NOW: finishing the
        // transition above may have moved the Member onto its successor, and
        // activating the row this loop was entered with would resume the
        // generation the ledger already retired.
        const current = ledger.getMember(member.memberId)
        if (current !== undefined && !this.handles.has(current.memberId)) {
          await this.activateMember(current, undefined, persistedSessions)
        }
      } else {
        // Every other durable state converges through the effect table its operation runs after commit, finishing a crash or failed call between commit and effect.
        // One Member's fault must not fail the boot: it is logged and retried at the next startup.
        try {
          await this.convergeMemberEffects(member)
        } catch (error) {
          this.ctx.logger.warn(`agent-team: could not converge member '${member.handle}' to its '${member.state}' state: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    // Timers start last: every Member is settled, so a run that finishes
    // immediately can already reach the owners it must notify.
    await this.startSubscriptionRuntime(subscriptionDomain)
  }

  /**
   * Lazy Workspace-deletion handling: deletion is detectable only through the registry (no event).
   * A dead non-default participation is withdrawn through the normal leave path; a dead default Workspace is left alone and the Member surfaces as unavailable.
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
   * Whether one Member Session has durable persisted content, decided through {@link SessionPersistence.stat}:
   * it reports a still-draining session via its pending header, so a resume racing a suspend's final flush cannot fork a fresh generation over it.
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

  @Remote('createProject')
  async createProject(request: AgentTeamCreateProjectRequest): Promise<AgentTeamCreateProjectResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const ledger = this.requireLedger()
    if (!ledger.hasCommitted(request.requestId)) this.assertProjectMembersAvailable(request.memberIds)
    const result = await ledger.createProject({ ...request, actor: agentTeamHumanActor() })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Human rename of one Project's display facts; identity refs are immutable. */
  @Remote('updateProject')
  async updateProject(request: AgentTeamUpdateProjectRequest): Promise<AgentTeamUpdateProjectResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const result = await this.requireLedger().updateProject({ ...request, actor: agentTeamHumanActor() })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /**
   * Archive one Project: hidden from every surface with all facts kept. Member sessions stay live,
   * active Claims on its Threads release, and affected Members' Attention clears.
   */
  @Remote('archiveProject')
  async archiveProject(request: AgentTeamArchiveProjectRequest): Promise<AgentTeamArchiveProjectResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const result = await this.requireLedger().archiveProject({ ...request, actor: agentTeamHumanActor() })
    if (result.committed) this.emitCommitted(result.value.receipt)
    // Archiving stops every subscription the Project owns, so their queues and
    // history are cleared at the decision instead of waiting for the next boot.
    if (result.committed) await this.forgetProjectSubscriptions(request.projectRef)
    return result.value
  }

  /** Drop the private state of every subscription a Project owns: none of it can run or publish again. */
  private async forgetProjectSubscriptions(projectRef: AgentTeamProjectRef): Promise<void> {
    for (const subscription of this.requireLedger().subscriptionsOfProject(projectRef)) {
      await this.forgetSubscriptionPrivateState(subscription.subscriptionRef)
    }
  }

  /** Human grant of Project ownership to one Agent Member of the Project's Workspace. */
  @Remote('addProjectOwner')
  async addProjectOwner(request: AgentTeamProjectOwnerRequest): Promise<AgentTeamProjectOwnerResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const result = await this.requireLedger().addProjectOwner({ ...request, actor: agentTeamHumanActor() })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Human withdrawal of one Agent Member's Project ownership; the Human owner cannot be removed. */
  @Remote('removeProjectOwner')
  async removeProjectOwner(request: AgentTeamProjectOwnerRequest): Promise<AgentTeamProjectOwnerResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const result = await this.requireLedger().removeProjectOwner({ ...request, actor: agentTeamHumanActor() })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Create a durable Member and atomically grant its declared initial Projects. */
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

  /** Commit suspended intent, then dispose the owned AgentHandle; the Session stays. */
  async suspendMember(request: AgentTeamSetMemberStateRequest): Promise<AgentTeamMemberResult> {
    return this.enqueueLifecycle(request.memberId, async () => {
      const result = await this.requireLedger().suspendMember({ ...request, actor: agentTeamHumanActor() })
      if (result.committed) this.emitCommitted(result.value.receipt)
      await this.convergeMemberEffects(result.value.member)
      return Object.freeze({ receipt: result.value.receipt, status: this.memberStatus(result.value.member) })
    })
  }

  async resumeMember(request: AgentTeamSetMemberStateRequest): Promise<AgentTeamMemberResult> {
    return this.enqueueLifecycle(request.memberId, async () => {
      const result = await this.requireLedger().resumeMember({ ...request, actor: agentTeamHumanActor() })
      if (result.committed) this.emitCommitted(result.value.receipt)
      this.dropInboxCoverage(result.value.member.memberId)
      // The suspended Session's log is durable once its retirement completes, and agents.resume() waits for exactly that.
      // Re-listing the persistence tree would race the retirement on Windows (transient staging entries surface as ENOENT), so pass the known session.
      await this.activateMember(result.value.member, undefined, new Set([result.value.member.sessionId]))
      return Object.freeze({ receipt: result.value.receipt, status: this.memberStatus(result.value.member) })
    })
  }

  /**
   * Operator nudge for a Member that stopped making progress: steer a continuation prompt into its live session,
   * rebuild it after an orphaned preset composition, or re-run activation when none is live.
   * Runtime-only (no ledger operation); also cancels any pending automatic recovery episode.
   * A non-enabled Member still holding a live handle is an interrupted suspend/archive/remove; recovery finishes that cleanup.
   */
  @Remote('recoverMember')
  async recoverMember(request: AgentTeamRecoverMemberRequest): Promise<AgentTeamRecoverMemberResult> {
    this.requireAccepting()
    const member = this.requireLedger().getMember(request.memberId)
    if (member === undefined || !this.requireLedger().participatesIn(request.memberId, request.workspaceId)) throw new Error(`unknown Member '${request.memberId}' in workspace '${request.workspaceId}'`)
    this.recovery.stopTracking(request.memberId, 'manual')
    const handle = this.handles.get(request.memberId)
    // A committed renewal or rollover whose retire or activation never finished leaves no live generation (or the retired one still live):
    // recovery finishes that recorded transition rather than restarting a Session the ledger has moved off.
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
    // A live handle on a non-enabled Member is residue of a suspend, archive, or removal whose disposal failed after commit:
    // recovery re-runs that state's effects instead of resuming or rebuilding the stray generation.
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
      // A refusal stays a deterministic failure the retry reports again; the
      // restart does not heal it.
      await this.reactivateMember(request.memberId)
      return Object.freeze({ status: this.memberStatus(member) })
    }
    this.steerResume(member, this.manualResumeText(), 'operator recovery')
    return Object.freeze({ status: this.memberStatus(member) })
  }

  /**
   * Finish one Member's committed Session transition, whichever half a failure interrupted. Each external effect is derived fresh:
   * retire a generation still live on the old Session, archive the retired Session unless the registry already reports it archived,
   * and activate the target when no live generation runs it. A live handle alone never decides completion; the registry's archive set is the evidence for the archive step.
   *
   * `forkedFrom` marks a planned in-process activation (the caller just retired that Session): its absence tells `activateMember` the Session may never have materialized, so it runs the carried-input replay.
   * Callers must hold the lifecycle queue (or run before other lifecycle work); this method does not re-enter it.
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
   * Converge one Member's external effects onto its durable lifecycle state: the effect table every lifecycle operation runs after commit and startup re-runs for non-enabled Members.
   *
   * - `suspended`: no live handle; the Session and private memory stay.
   * - `archived`: no live handle; the Session is hidden from grouping surfaces; log and private memory stay.
   * - `inactive`: no live handle; the Session is archived and private memory deleted.
   *
   * `enabled` has no entry: its effects belong to the Session transition and activation. Every step is derived from durable state and safe to repeat,
   * so a repeat after a crash runs exactly the owed steps and never a second durable write. Callers must hold the lifecycle queue (or run before other lifecycle work).
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
    await this.waitLogged('wait-external', { label: this.memberLabel(memberId), sessionId: previousSessionId },
      'for the retired Agent to release its Session write path',
      () => this.disposeWithWakeGuard(active))
    this.handles.delete(memberId)
    this.memberRuntime.forgetMember(memberId)
    this.clearMemberFailure(memberId, 'activation')
    this.dropInboxCoverage(memberId)
    // The previous log survives on disk; archiving hides it from every
    // grouping surface so one Member keeps exactly one visible Session.
    await this.waitLogged('wait-external', { label: this.memberLabel(memberId), sessionId: previousSessionId },
      'for the Workspace registry to archive the retired Session',
      () => this.ctx.workspaceRegistry.archiveSession(previousSessionId))
  }

  private isOrdinaryInput(message: UserMessage): boolean {
    return !this.isTeamWake(message) && !isAgentTeamContextSource(message)
  }

  private queuedInputOf(agent: Agent): readonly UserMessage[] {
    return [...agent.inbox.nextTurn, ...agent.inbox.nextStep].filter(message => this.isOrdinaryInput(message))
  }

  private async archiveRetiredSession(sessionId: SessionId): Promise<void> {
    if (!this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) await this.ctx.workspaceRegistry.archiveSession(sessionId)
  }

  /**
   * Execute one prepared generation swap at a true idle boundary: commit the idempotent Host-actor operation, retire the previous generation, activate the fresh Session.
   * The Team Inbox is rederived, never copied; there is no handoff envelope, because a successor told it received one performs the handoff instead of reading its memory.
   */
  private async executeMemberTransition(memberId: AgentTeamMemberId, plan: TeamTransitionPlan): Promise<void> {
    await this.enqueueLifecycle(memberId, async () => {
      this.requireAccepting()
      const stored = this.requireLedger().getMember(memberId)
      if (stored === undefined || stored.state !== 'enabled') throw new Error(`Agent Member '${memberId}' cannot recycle: not enabled`)
      if (stored.sessionId !== plan.previousSessionId) throw new Error(`Agent Member '${stored.handle}' is no longer bound to the recycled Session`)
      const active = this.handles.get(memberId)
      if (active !== undefined) {
        // Public idle status also includes maintenance; whenIdle waits for both.
        await this.waitLogged('wait-turn', { label: stored.handle, sessionId: stored.sessionId },
          'for the turn to converge before the Session transition',
          () => Promise.race([active.agent.whenIdle(), this.shutdown.promise]))
        if (this.runningAgents.has(active.agent.id)) throw new Error(`Agent Member '${stored.handle}' is still running; the recycle must wait for idle`)
        const queued = this.queuedInputOf(active.agent)
        if (queued.length > 0) {
          throw new Error(`the context recycle is deferred: this generation has ${queued.length} queued message(s) that would not survive the switch`)
        }
        // Disposal cancels the Agent's jobs, so a case that would silently
        // discard unfinished or unreported output keeps the old generation.
        const blockingJobs = this.ownedJobsBlockingRecycle(active.agent)
        if (blockingJobs.length > 0) {
          throw new Error(`the context recycle is refused: this Member now owns jobs that would not survive the switch (${blockingJobs.join(', ')})`)
        }
      }
      const commit = (inputFromSeq?: SessionLogOffset) => this.requireLedger().recycleMemberSession({
        requestId: plan.requestId,
        workspaceId: stored.workspaceId,
        memberId,
        previousSessionId: plan.previousSessionId,
        newSessionId: plan.newSessionId,
        actor: agentTeamHostActor(),
        ...(inputFromSeq === undefined ? {} : { inputFromSeq }),
      })
      const recycled = active === undefined ? await commit() : await active.agent.runMaintenance(async () => {
        // Maintenance holds later waking input in the durable inbox until the
        // ledger has recorded where its successor must start replaying.
        const result = await commit(active.agent.session.seq)
        this.retiringAgents.add(active.agent)
        active.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
        return result
      })
      this.emitCommitted(recycled.value.receipt)
      if (active === undefined) await this.archiveRetiredSession(plan.previousSessionId)
      else await this.retireMemberGeneration(memberId, active, plan.previousSessionId)
      // Linear succession: the new Session's lineage parent is the one it
      // replaces. Activation defers the Inbox wake until input replay completes.
      await this.activateMember(recycled.value.member, undefined, undefined, plan.previousSessionId, { deferNotify: true })
      const reactivated = this.handles.get(memberId)
      if (reactivated === undefined) {
        throw new Error(`Agent Member '${stored.handle}' failed to activate its next context: ${this.memberFailures.get(memberId)?.activation ?? 'unknown error'}`)
      }
      const notifications = this.requireLedger().notificationFacts(recycled.value.member.memberId)
      if (notifications.length > 0 || this.requireLedger().mainNotificationFacts(recycled.value.member.memberId).length > 0) {
        this.notifyMember(reactivated.agent, {
          kind: 'transition',
          requestId: plan.requestId,
          previousSessionId: plan.previousSessionId,
        })
      }
    })
  }

  private memberLabel(memberId: AgentTeamMemberId): string {
    return this.ledger?.getMember(memberId)?.handle ?? memberId
  }

  /**
   * Run one lifecycle wait and log its class, subject, and duration, so an operator can tell a Member parked on its own turn (`wait-turn`)
   * from one parked on an external service (`wait-external`).
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
   * Cache GC: uploads referenced by a Message survive 72h from upload; orphans (never sent) go after 24h.
   * Runs at startup and then daily, in-process only because the cache is transient.
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
   * Steer one continuation message into a Member's live session and log the delivery. Throws when no handle exists so the coordinator stops tracking.
   * Appends the inbox snapshot when there is anything new; a steered continuation is queued for the next step, not read.
   */
  private steerResume(member: AgentTeamAgentMember, text: string, trigger: 'automatic recovery' | 'operator recovery'): void {
    const handle = this.handles.get(member.memberId)
    if (handle === undefined) throw new Error(`member '${member.handle}' has no active session`)
    const material = this.requireLedger().notificationSnapshot(member.memberId)
    const notifications = material.threads
    const mainNotifications = material.main
    const memberReminders = material.memberReminders
    // A Member reminder is unread like any other durable fact, so the recovery
    // instruction carries it too: otherwise the reminder would be answered by a
    // notice that never mentioned it, and a one-shot would never fire again.
    const notice = notifications.length === 0 && mainNotifications.length === 0 && memberReminders.length === 0 ? undefined
      : this.notificationText(handle.agent, notifications, member.memberId, mainNotifications, undefined, text, memberReminders,
        material.workers)
    const body = notice === undefined ? text : `${text}\n\n${notice.text}`
    const hint = createUserMessage({
      content: [{ type: 'text', text: body }],
      source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: TEAM_RECOVERY_NOTICE_SUMMARY,
        teamFacts: teamMessageSurface(body, notice?.messages ?? [], notice?.activities ?? []) },
    })
    for (const pending of [...handle.agent.inbox.nextStep, ...handle.agent.inbox.nextTurn]) {
      if (this.isInboxNotice(pending)) this.removeExpectedTeamWake(handle.agent, pending)
    }
    this.trackTeamWake(handle.agent, hint)
    // The occurrences this recovery instruction rendered are the ones its claim
    // consumes, exactly as an Inbox notice's claim does.
    if (notice !== undefined && notice.deliveredReminders.length > 0) {
      this.memberReminderWakes.set(hint.id, { memberId: member.memberId, reminders: notice.deliveredReminders })
    }
    handle.agent.steer(hint)
    this.ctx.logger.info(`agent-team: ${trigger} continuation steered for ${this.memberScope(member.memberId, handle.agent.session.id)}${notifications.length === 0 && mainNotifications.length === 0 && memberReminders.length === 0 ? '' : ` carrying ${this.notificationIdentity(notifications, mainNotifications, memberReminders)}`}: it is queued for the Member's next step, not yet read by the model`)
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
   * Human edit of one Member's mutable facts. A live model edit records the new route in the Session log through the public model-selection seam, so no Agent is disposed: disposing an Agent emits session/disposed,
   * which makes the Web Client permanently mark the same Session id unavailable even if Team recreates it.
   */
  @Remote('updateMember')
  async updateMember(request: AgentTeamUpdateMemberRequest): Promise<AgentTeamUpdateMemberResult> {
    return this.enqueueLifecycle(request.memberId, async () => {
      await this.assertModelRoute(request.model)
      const previous = this.requireLedger().getMember(request.memberId)
      const result = await this.requireLedger().updateMember({ ...request, actor: agentTeamHumanActor() })
      if (result.committed) this.emitCommitted(result.value.receipt)
      // A replayed request resolves to the member as it was at its own commit; driving the runtime from that history would let a late retry roll back a newer configuration.
      // Apply and report the currently accepted member instead (lifecycle calls serialize).
      const current = this.requireLedger().getMember(request.memberId)
      if (current === undefined) throw new Error(`Agent Member '${request.memberId}' no longer exists`)
      const active = this.handles.get(request.memberId)
      let effect: AgentTeamMemberEffect = 'deferred:no-live-handle'
      if (active !== undefined) {
        effect = 'already-applied'
        if (!isDeepStrictEqual(previous?.model ?? undefined, current.model ?? undefined)) {
          // The public model-selection seam records the new route in the Session log: the current turn keeps its fixed route and the next step picks this one up, so no Agent disposal is needed.
          active.agent.model.select(current.model ?? this.ctx.agentDefaultModel.currentSelection())
          effect = 'applied'
        }
        if (!this.memberRuntime.appliedCapabilitiesMatch(current.memberId, current.capabilities)) {
          try {
            effect = await this.applyCapabilityEdit(active, current)
          } catch (error) {
            // The rejection stays loud for the caller; the failure is also kept as a routable, member-visible diagnostic and logged before it escapes.
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
   * Live-apply a capability edit at a turn boundary: the current turn keeps its schemas and catalog; once idle, the next step recomputes them
   * from the new restriction and selection, with the same Session and history. Suspend/remove during the wait cancels the swap.
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
   * Whether this Member's live handle was replaced while `applyCapabilityEdit` waited for the turn boundary (suspend, removal, restart),
   * so the queued edit must not apply to the generation it originally targeted.
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
   * Archive one Member: commit the archival, dispose its live session (private memory and the Session log stay on disk),
   * and archive the Session from every grouping surface. All active Claims release and the Member's Attention clears.
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

  /**
   * Human-only Task responsibility transfer. It shares the ledger path, the request/result contract, and the
   * authority rules with `transferTaskForAgent`: the Host decides whether the actor may move this Task and whether
   * the target is a legal accountable, so the Client offers targets without re-implementing either judgement. From
   * rules version 3 a target need only take part in the Project, so following the Thread is offered by the dialog
   * rather than required by the Host.
   */
  @Remote('transferTask')
  async transferTask(request: AgentTeamTransferTaskRequest): Promise<AgentTeamTransferTaskResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const result = await this.requireLedger().transferTask({ ...request, actor: agentTeamHumanActor() })
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

  /** Human top-level start of a discussion or Task Thread. */
  @Remote('startThread')
  async startThread(request: AgentTeamStartThreadRequest): Promise<AgentTeamStartThreadResult> {
    return this.startThreadAs(this.humanCall(request.workspaceId), request)
  }

  /** Human Main stream Message. Unread Main stream entries come back as a typed outcome. */
  @Remote('postMainMessage')
  async postMainMessage(request: AgentTeamPostMainMessageRequest): Promise<AgentTeamPostMainMessageResult> {
    return this.postMainMessageAs(this.humanCall(request.workspaceId), request)
  }

  /** Human's durable, atomically acknowledged Main stream read. */
  @Remote('readMainStream')
  async readMainStream(request: AgentTeamMainStreamReadRequest): Promise<AgentTeamMainStreamReadResult> {
    return this.readMainStreamAs(this.humanCall(request.workspaceId), request)
  }

  /** Human's non-mutating Main stream page with the Human's own unread standing. */
  @Remote('mainStreamHistory')
  mainStreamHistory(request: AgentTeamMainStreamHistoryRequest): AgentTeamMainStreamHistory {
    this.requireWorkspace(request.workspaceId)
    return this.requireLedger().mainStreamHistory(agentTeamHumanActor(), request)
  }

  /**
   * Resolve uploaded ids and agent-supplied absolute paths into one attachment metadata list. All paths are validated before anything is copied,
   * so one rejection leaves the cache untouched; each copy takes a request-derived id, so a retry converges instead of writing an orphan.
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
   * Local environment check for the settings page: which DSH line this Host runs against and whether it is inside this bundle's declared range.
   * Human-scoped and read-only; the verdict comes from the Harness's own compatibility evaluator.
   *
   * The wire type and `EnvironmentReport` keep separate field lists on purpose: the contract states every fact as optional because a Transport may withhold any,
   * while the report is stricter. This assignment is where the compiler holds them together.
   */
  @Remote('environment')
  environmentForClient(_request: AgentTeamEnvironmentRequest): AgentTeamEnvironmentResult {
    return Object.freeze(reportEnvironment())
  }

  /**
   * Human profile read for the settings page and footnote: name and avatar reference from the live Config plus version facts.
   * `latestVersion` is absent until a background refresh observes a newer published release.
   */
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
   * Upload one human avatar image into the persistent store; the caller stores the returned ref in settings.
   * Bytes never enter the TTL-bound attachment cache.
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
   * Overwrite the Human profile fields the caller supplies. The schema supplies the shape; this method adds the two judgements it cannot make
   * (a non-empty name, a name no live Member answers to); the settings service persists the result and applies it live.
   * No expected revision: the last write wins. The stored document can also change outside this method (settings document opener, text editor).
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
      // The settings namespace is this Host row's id, addressed by name rather than `ctx.fiber.entry`: a Remote call runs under its caller's context,
      // whose fiber entry is the RPC gateway's row (`typert-gateway`). shipping.spec.ts pins the constant to the row `cordis.patch.yml` declares.
      await settings.mutate(HUMAN_PROFILE_SETTINGS_NAMESPACE, ops)
    }
    return Object.freeze({ ...this.humanProfile() })
  }

  /**
   * The Human's own sidebar row order. Presentation only: it rides the Host row
   * beside the profile because it must survive a browser, and it never becomes a
   * ledger fact or an Agent-readable preference.
   */
  @Remote('sidebarOrder')
  sidebarOrderForClient(_request: AgentTeamSidebarOrderRequest): AgentTeamSidebarOrderResult {
    return Object.freeze({ lists: readableSidebarOrders(this.config.sidebarOrder.get().lists) })
  }

  /**
   * Replace one sidebar list's saved order. Last write wins, like the profile
   * beside it: two windows dragging the same list resolve to whichever drop
   * landed last, and the next drag corrects it.
   */
  @Remote('setSidebarOrder')
  async setSidebarOrder(request: AgentTeamSidebarOrderWriteRequest): Promise<AgentTeamSidebarOrderResult> {
    this.requireAccepting()
    const problem = sidebarOrderKeyProblem(request.key)
    if (problem !== undefined) throw new Error(problem)
    const refs = sanitizeSidebarOrderRefs(request.refs)
    const settings = this.ctx.get('settings')
    if (settings === undefined) throw new Error('the settings service is unavailable')
    // One gesture, one write: the path addresses this list inside the row's
    // `sidebarOrder.lists` dict, so neither the other Workspaces' lists nor the
    // sibling Host-row groups are restated.
    await settings.mutate(HUMAN_PROFILE_SETTINGS_NAMESPACE, [{ op: 'set', path: ['sidebarOrder', 'lists', request.key], value: refs }])
    return Object.freeze({ lists: readableSidebarOrders({ ...this.config.sidebarOrder.get().lists, [request.key]: refs }) })
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
  async changeAttention(request: AgentTeamThreadAttentionRequest): Promise<AgentTeamThreadAttentionResult | AgentTeamMainAttentionResult> {
    const actor = this.humanCall(request.workspaceId)
    const result = await this.requireLedger().changeAttention({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Human Inbox projection; the Web Client consumes the direct-only slice as its mention queue. */
  @Remote('inbox')
  inbox(request: AgentTeamInboxRequest): AgentTeamInbox {
    this.requireWorkspace(request.workspaceId)
    this.scheduleTaskReminderEvaluation()
    return this.requireLedger().inbox(agentTeamHumanActor(), request)
  }

  @Remote('taskBoard')
  taskBoard(request: AgentTeamTaskBoardRequest): AgentTeamTaskBoard {
    this.requireWorkspace(request.workspaceId)
    return this.requireLedger().taskBoard(agentTeamHumanActor(), request)
  }

  /** Human's durable, atomically acknowledged Thread read. */
  @Remote('readThread')
  async readThread(request: AgentTeamThreadReadRequest): Promise<AgentTeamThreadReadResult> {
    const actor = this.humanCall(request.workspaceId)
    const result = await this.requireLedger().readThread({ ...request, actor })
    // A read that made no progress commits no operation and carries no receipt.
    const receipt = result.committed ? result.value.receipt : undefined
    if (receipt !== undefined) this.emitCommitted(receipt)
    return this.withWorkerStates(result.value)
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
    return this.withWorkerStates(this.requireLedger().threadHistory(agentTeamHumanActor(), request))
  }

  /** Return the existing bounded public Workspace discovery projection. */
  @Remote('view')
  view(request: AgentTeamViewRequest): AgentTeamView {
    this.requireWorkspace(request.workspaceId)
    return this.requireLedger().view(request)
  }

  /** Agent-only start of a discussion or Task Thread; Project owners only. */
  async startThreadForAgent(agent: Agent, request: AgentTeamStartThreadRequest): Promise<AgentTeamStartThreadResult> {
    return this.startThreadAs(this.memberCall(agent, request.workspaceId), request)
  }

  /** Agent-only Main stream Message. */
  async postMainMessageForAgent(agent: Agent, request: AgentTeamPostMainMessageRequest): Promise<AgentTeamPostMainMessageResult> {
    return this.postMainMessageAs(this.memberCall(agent, request.workspaceId), request)
  }

  /** Agent-only Main stream read; a read with nothing to acknowledge commits nothing. */
  async readMainStreamForAgent(agent: Agent, request: AgentTeamMainStreamReadRequest,
    select?: (read: AgentTeamMainStreamReadResult & { readonly visibleMessageRefs: readonly AgentTeamMessageRef[]; readonly visibleActivityRefs: readonly AgentTeamActivityRef[] }) => number,
  ): Promise<AgentTeamMainStreamReadResult & { readonly visibleMessageRefs: readonly AgentTeamMessageRef[]; readonly visibleActivityRefs: readonly AgentTeamActivityRef[] }> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().readMainStream({ ...request, actor }, select === undefined ? undefined
      : preview => select(this.mainReadContext(agent, actor, request, preview)))
    if (result.committed && result.value.receipt !== undefined) this.emitCommitted(result.value.receipt)
    return this.mainReadContext(agent, actor, request, result.value)
  }

  private mainReadContext(agent: Agent, actor: AgentTeamMemberActor, request: AgentTeamMainStreamReadRequest, read: AgentTeamMainStreamReadResult) {
    const surface = visibleTeamSurface(agent)
    const unread = read.entries.filter(entry => entry.unread)
    const history = this.requireLedger().mainStreamHistory(actor, { ...request,
      beforeSequence: unread[0]?.sequence ?? read.standing.head + 1, limit: 4 })
    const background = history.entries.filter(entry => entry.kind === 'message'
      && !unread.some(fact => fact.sequence === entry.sequence)
      && !isMainEntryOnSurface(surface, entry, read.projectRef))
      .map(entry => ({ ...entry, unread: false, direct: false }))
    const visibleMessageRefs = unread.flatMap(entry => entry.kind === 'message'
      && isMainEntryOnSurface(surface, entry, read.projectRef) ? [entry.message.messageRef] : [])
    const visibleActivityRefs = unread.flatMap(entry => entry.kind === 'activity'
      && isMainEntryOnSurface(surface, entry, read.projectRef) ? [entry.activity.activityRef] : [])
    // The ledger's page keeps its already-read Thread cards: a card is current
    // state, not unread work, and dropping it hid every Thread the reader had
    // already acknowledged once a newer entry arrived.
    const page = read.entries.filter(entry => entry.kind === 'thread-card')
    const merged = [...page, ...background, ...unread]
      .filter((entry, index, entries) => entries.findIndex(item => item.sequence === entry.sequence) === index)
      .sort((left, right) => left.sequence - right.sequence)
    return { ...read, entries: merged, visibleMessageRefs, visibleActivityRefs }
  }

  mainStreamHistoryForAgent(agent: Agent, request: AgentTeamMainStreamHistoryRequest): AgentTeamMainStreamHistory {
    const actor = this.memberActor(agent)
    this.requireAgentWorkspace(actor, request.workspaceId)
    return this.requireLedger().mainStreamHistory(actor, request)
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
  async changeAttentionForAgent(agent: Agent, request: AgentTeamThreadAttentionRequest): Promise<AgentTeamThreadAttentionResult | AgentTeamMainAttentionResult> {
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

  /** The Agent's own Main stream Attention on one Project, answered without writing. */
  mainAttentionStatusForAgent(agent: Agent, request: { workspaceId: AgentTeamViewRequest['workspaceId']; projectRef: AgentTeamProjectRef }): AgentTeamMainAttentionStatus {
    const actor = this.memberActor(agent)
    this.requireAgentWorkspace(actor, request.workspaceId)
    return this.requireLedger().mainAttentionStatus(actor, request)
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

  async promoteThreadForAgent(agent: Agent, request: AgentTeamPromoteThreadRequest): Promise<AgentTeamPromoteThreadResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().promoteThread({ ...request, actor })
    this.emitCommittedOutcome(result)
    return result.value
  }

  /** Agent-only Task resolution: accept (in_review, never self-executed), close, reopen. */
  async changeTaskForAgent(agent: Agent, request: AgentTeamTaskRequest): Promise<AgentTeamTaskResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().changeTask({ ...request, actor })
    this.emitCommittedOutcome(result)
    return result.value
  }

  /** Agent-only accountability transfer to another enabled Project member or the Human. */
  async transferTaskForAgent(agent: Agent, request: AgentTeamTransferTaskRequest): Promise<AgentTeamTransferTaskResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().transferTask({ ...request, actor })
    this.emitCommittedOutcome(result)
    return result.value
  }

  taskBoardForAgent(agent: Agent, request: Omit<AgentTeamTaskBoardRequest, 'workspaceId'> & { readonly workspaceId?: WorkspaceId }): AgentTeamTaskBoard {
    const actor = this.memberActor(agent)
    if (request.workspaceId === undefined) return this.requireLedger().memberTaskBoard(actor, request)
    this.requireAgentWorkspace(actor, request.workspaceId)
    return this.requireLedger().taskBoard(actor, { ...request, workspaceId: request.workspaceId })
  }

  /**
   * Agent-only read of the caller's own Member reminders. Reading also re-derives
   * what is due, so a Member that just learned it has reminders sees them raised.
   */
  memberRemindersForAgent(agent: Agent, request: { readonly workspaceId?: WorkspaceId }): readonly AgentTeamMemberReminderView[] {
    const actor = this.memberActor(agent)
    if (request.workspaceId !== undefined) this.requireAgentWorkspace(actor, request.workspaceId)
    this.scheduleMemberReminderEvaluation()
    return this.requireLedger().memberRemindersOf(actor.memberId)
  }

  /** Agent-only creation of a reminder for the caller itself: a reminder has exactly one recipient. */
  async createMemberReminderForAgent(agent: Agent, request: Omit<AgentTeamMemberReminderCreateRequest, 'actor'>): Promise<AgentTeamMemberReminderCreateResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().createMemberReminder({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Agent-only withdrawal of one of the caller's own reminders. */
  async cancelMemberReminderForAgent(agent: Agent, request: Omit<AgentTeamMemberReminderCancelRequest, 'actor'>): Promise<AgentTeamMemberReminderCancelResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().cancelMemberReminder({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Human read of one Member's reminders, for Member detail. */
  @Remote('memberReminders')
  memberRemindersForClient(request: AgentTeamMemberReminderListRequest): readonly AgentTeamMemberReminderView[] {
    this.requireWorkspace(request.workspaceId)
    const ledger = this.requireLedger()
    if (!ledger.participatesIn(request.memberId, request.workspaceId)) {
      throw new Error(`Member '${request.memberId}' does not participate in Workspace '${request.workspaceId}'`)
    }
    return ledger.memberRemindersOf(request.memberId)
  }

  /** Human withdrawal of one Member's reminder, for Member detail; the Human may withdraw any. */
  @Remote('cancelMemberReminder')
  async cancelMemberReminderForClient(request: Omit<AgentTeamMemberReminderCancelRequest, 'actor'>): Promise<AgentTeamMemberReminderCancelResult> {
    this.requireWorkspace(request.workspaceId)
    const result = await this.requireLedger().cancelMemberReminder({ ...request, actor: agentTeamHumanActor() })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  inboxForAgent(agent: Agent, request: { readonly workspaceId?: WorkspaceId; readonly limit?: number }): AgentTeamInbox {
    this.scheduleTaskReminderEvaluation()
    const actor = this.memberActor(agent)
    if (request.workspaceId === undefined) return this.requireLedger().memberInbox(actor, request)
    this.requireAgentWorkspace(actor, request.workspaceId)
    return this.requireLedger().inbox(actor, { ...request, workspaceId: request.workspaceId })
  }

  async readThreadForAgent(agent: Agent, request: AgentTeamThreadReadRequest,
    select?: (read: AgentTeamThreadReadResult & { readonly visibleMessageRefs: readonly AgentTeamMessageRef[]; readonly visibleActivityRefs: readonly AgentTeamActivityRef[] }) => number,
  ): Promise<AgentTeamThreadReadResult & { readonly visibleMessageRefs: readonly AgentTeamMessageRef[]; readonly visibleActivityRefs: readonly AgentTeamActivityRef[] }> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().readThread({ ...request, actor }, select === undefined ? undefined
      : preview => select(this.threadReadContext(agent, actor, request, preview)))
    const receipt = result.committed ? result.value.receipt : undefined
    if (receipt !== undefined) this.emitCommitted(receipt)
    const read = this.withWorkerStates(this.threadReadContext(agent, actor, request,
      result.committed ? result.value : { ...result.value, reminders: [] }))
    if (receipt !== undefined) this.afterAcceptanceRead(agent, actor.memberId, read)
    return read
  }

  /**
   * Attach the durable state of every Worker run bound to this Thread. The states
   * come from the execution records, never from the facts this window returned: a
   * run outside a long Thread's page still stands where its record says.
   */
  private withWorkerStates<T extends { readonly thread: AgentTeamThread }>(read: T): T {
    const states = this.requireLedger().threadWorkerStates(read.thread.threadRef)
    if (states.length === 0) return read
    const workerStates: readonly AgentTeamWorkerStateView[] = Object.freeze(states.map(entry => Object.freeze({
      ...entry,
      // A live run of this Host is the only thing that makes `running` truthful.
      unconfirmed: entry.state === 'running' && !this.workerRegistry.isLive(entry.workerRef),
    })))
    return Object.freeze({ ...read, workerStates })
  }

  private threadReadContext(agent: Agent, actor: AgentTeamMemberActor, request: AgentTeamThreadReadRequest, snapshot: AgentTeamThreadReadResult) {
    const surface = visibleTeamSurface(agent)
    const unread = snapshot.facts.filter(entry => entry.unread)
    const history = this.requireLedger().threadHistory(actor, { ...request,
      beforeSequence: unread[0]?.fact.sequence ?? snapshot.thread.revision + 1, limit: 4 })
    const anchor = { fact: { kind: 'message' as const, sequence: snapshot.anchor.sequence, message: snapshot.anchor,
      mentions: snapshot.anchorMentions, occurredAt: snapshot.anchor.occurredAt }, unread: false, direct: false }
    const background = [anchor, ...history.facts.filter(fact => fact.kind === 'message')
      .map(fact => ({ fact, unread: false, direct: false }))]
      .filter((entry, index, entries) => !unread.some(item => item.fact.sequence === entry.fact.sequence)
        && entries.findIndex(item => item.fact.sequence === entry.fact.sequence) === index
        && !isFactOnSurface(surface, entry, snapshot.thread.threadRef))
    const facts = [...background, ...unread].sort((left, right) => left.fact.sequence - right.fact.sequence)
    const read = this.withReplyContexts({ ...snapshot, facts }, request.workspaceId)
    const visibleMessageRefs = unread.flatMap(entry => entry.fact.kind === 'message'
      && isFactOnSurface(surface, entry, read.thread.threadRef) ? [entry.fact.message.messageRef] : [])
    const visibleActivityRefs = unread.flatMap(entry => entry.fact.kind === 'activity'
      && isFactOnSurface(surface, entry, read.thread.threadRef) ? [entry.fact.activity.activityRef] : [])
    return { ...read, visibleMessageRefs, visibleActivityRefs }
  }

  /**
   * A read that acknowledged the acceptance of work this Member contributed to hands the reader one reminder to write down what is durable,
   * and, above the acceptance budget, one compaction once the Agent settles. Priced from the committed read, never persisted, never reverses it.
   */
  private afterAcceptanceRead(agent: Agent, memberId: AgentTeamMemberId, read: AgentTeamThreadReadResult): void {
    // A retiring Agent is about to be disposed; a reminder injected into its
    // Session would be discarded unread.
    if (this.retiringAgents.has(agent)) return
    const task = read.task
    if (task === undefined || task.resolution !== 'accepted' || task.status !== 'done') return
    if (!this.acceptedOwnWork(read, memberId)) return
    // One boundary per turn: several accepted reads in one turn must not queue
    // several identical reminders or race two compactions.
    if (this.acceptanceBoundaries.has(agent)) return
    this.acceptanceBoundaries.add(agent)
    const engine = this.compactionEngineFor(agent)
    const plan = planAcceptanceContext({ usageTokens: this.measureContext(agent), canCompact: engine !== undefined })
    try {
      agent.followup(createAcceptanceReminder(plan.action))
    } catch (error) {
      this.ctx.logger.warn(`agent-team: could not deliver the acceptance reminder to ${this.memberScope(memberId, agent.id)}: ${failureDetail(error)}`)
      return
    }
    if (plan.action === 'compact' && engine !== undefined) this.scheduleAcceptanceCompaction(agent, memberId, engine)
  }

  /**
   * Whether this read acknowledged an acceptance that concluded the reader's own
   * work. An observer following the Thread sees the same accept as unread, and a
   * boundary that told it to close its books would be describing someone else's
   * finished Task.
   */
  private acceptedOwnWork(read: AgentTeamThreadReadResult, memberId: AgentTeamMemberId): boolean {
    const ledger = this.requireLedger()
    return read.facts.some(entry => {
      if (!entry.unread || entry.fact.kind !== 'activity') return false
      const activity = entry.fact.activity
      if (activity.kind !== 'accept') return false
      const own = [...activity.acceptedClaimRefs ?? [], ...activity.completedClaimRefs ?? []]
      return own.some(claimRef => ledger.getClaim(claimRef)?.owner === memberId)
    })
  }

  /** Measured context, or undefined when the meter cannot price this Session. */
  private measureContext(agent: Agent): number | undefined {
    try {
      return this.ctx.tokenMeter.measure(agent.session).totalTokens
    } catch (error) {
      this.ctx.logger.warn(`agent-team: could not price Session '${agent.id}' for the acceptance boundary: ${failureDetail(error)}`)
      return undefined
    }
  }

  /** The compaction engine in one Member Agent's preset scope, or undefined when it mounts none. */
  private compactionEngineFor(agent: Agent): CompactionEngine | undefined {
    return this.ctx.agentPresets.serviceFor(agent, 'compaction')
  }

  /**
   * Compact once the Agent settles. Acceptance usually lands mid-turn, so the
   * work is deferred to the boundary the engine requires: `compactNow` opens its
   * own maintenance phase, which the loop refuses while a turn is running, and
   * it is the only public entry that compacts without an open turn.
   */
  private scheduleAcceptanceCompaction(agent: Agent, memberId: AgentTeamMemberId, engine: CompactionEngine): void {
    void this.runAcceptanceCompaction(agent, memberId, engine).catch(error => {
      this.ctx.logger.warn(`agent-team: acceptance compaction failed for ${this.memberScope(memberId, agent.id)}: ${failureDetail(error)}`)
    })
  }

  private async runAcceptanceCompaction(agent: Agent, memberId: AgentTeamMemberId, engine: CompactionEngine): Promise<void> {
    await Promise.race([agent.whenIdle(), this.shutdown.promise])
    if (this.shutdownController.signal.aborted || !this.accepting) return
    // Re-read after every wait: a swap or a dispose may have replaced the Agent,
    // and compacting a retiring Session would append a `compaction/start` to a
    // log whose writer is being released.
    if (this.retiringAgents.has(agent) || this.handles.get(memberId)?.agent !== agent) return
    const result = await engine.compactNow(agent, this.shutdownController.signal)
    if (result === null) {
      this.ctx.logger.info(`agent-team: ${this.memberScope(memberId, agent.id)} had no compactable range at its acceptance boundary`)
      return
    }
    this.ctx.logger.info(`agent-team: compacted ${this.memberScope(memberId, agent.id)} at its acceptance boundary: ${result.shadowedSeqs.length} history item(s), ~${result.shadowedTokenCount} tokens`)
  }

  /**
   * Agent-only direct message: append the audit-only dm-sent operation, then inject the body into the recipient's live session.
   * The commit is the durable fact; a missing handle or failed wake returns a structured delivery error while the DM stays durable for recovery.
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
    // A cold generation is swapped before the relay lands, and an in-flight swap holds the relay until the successor exists,
    // since delivering into a Session about to be disposed would lose the DM. The handle is re-read afterwards because a swap replaces the Agent.
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
    const history = this.withWorkerStates(this.requireLedger().threadHistory(actor, request))
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
  /** Active Projects the Agent's Member owns, for the per-step Member context; undefined while the ledger predates Project owners. */
  ownedProjectsForAgent(agent: Agent): readonly AgentTeamProject[] | undefined {
    const member = this.memberForAgent(agent)
    const ledger = this.requireLedger()
    if (member === undefined || ledger.status().rulesVersion < 2) return undefined
    return ledger.ownedProjects(member.memberId)
  }

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
    const view = this.requireLedger().view({ ...request, includeWorkspaceDirectory: true }, member.memberId)
    return Object.freeze({ ...view, workspaces: Object.freeze(view.workspaces.map(participation => {
      const title = this.ctx.workspaceRegistry.get(participation.workspaceId)?.title
      return title === undefined ? participation : Object.freeze({ ...participation, title })
    })) })
  }

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
    if (generationStarted && transition.inputFromSeq === undefined) return this.skipCarriedInput(member.memberId, agent.session.id, 'started-generation')
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
      { sessionId: transition.previousSessionId, inheritedEventCount: inspectionInherited,
        ...(transition.inputFromSeq === undefined ? {} : { inputFromSeq: transition.inputFromSeq }) },
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

  private assertProjectMembersAvailable(memberIds: readonly AgentTeamMemberId[] | undefined): void {
    for (const memberId of memberIds ?? []) {
      const member = this.requireLedger().getMember(memberId)
      if (member === undefined) throw new Error(`unknown Agent Member '${memberId}'`)
      if (this.memberStatus(member).availability !== 'active') throw new Error(`Agent Member '${memberId}' is not available for Project membership`)
    }
  }

  /**
   * Shared append envelope for both message commits: resolve uploads, append through the chosen ledger method, emit the committed receipt,
   * and on failure drop the cache entries this attempt prepared. Keeping the order here once stops send and reply from drifting.
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

  private startThreadAs(actor: AgentTeamHumanActor | AgentTeamMemberActor, request: AgentTeamStartThreadRequest): Promise<AgentTeamStartThreadResult> {
    return this.commitMessageAs(actor, request, authorized => this.requireLedger().startThread(authorized))
  }

  private postMainMessageAs(actor: AgentTeamHumanActor | AgentTeamMemberActor, request: AgentTeamPostMainMessageRequest): Promise<AgentTeamPostMainMessageResult> {
    return this.commitMessageAs(actor, request, authorized => this.requireLedger().postMainMessage(authorized))
  }

  private async readMainStreamAs(actor: AgentTeamHumanActor | AgentTeamMemberActor, request: AgentTeamMainStreamReadRequest): Promise<AgentTeamMainStreamReadResult> {
    const result = await this.requireLedger().readMainStream({ ...request, actor })
    // A read that made no progress commits no operation and carries no receipt.
    if (result.committed && result.value.receipt !== undefined) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Read one Message back verbatim, whoever is asking. */
  private readMessageAs(actor: AgentTeamHumanActor | AgentTeamMemberActor, request: AgentTeamReadMessageRequest): AgentTeamReadMessageResult {
    return this.requireLedger().readMessage(actor, request)
  }

  private replyAs(actor: AgentTeamHumanActor | AgentTeamMemberActor, request: AgentTeamReplyRequest): Promise<AgentTeamReplyResult> {
    return this.commitMessageAs(actor, request, authorized => this.requireLedger().reply(authorized))
  }

  /**
   * After a failed message or reply attempt, remove the request-stable cache copies it could have prepared unless a committed Message references them.
   * The ledger's reference set is the guard; uploads are untouched (the GC owns unreferenced ones). Cleanup failures are logged and never mask the original error.
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
    // No LLM service means no adapter to check against. It is read through `get`, not `ctx.llm`: the Host does not hard-inject it,
    // and an undeclared property read throws instead of yielding `undefined`.
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
   * Session headers currently durable in the persistence backend. A disposed Session's log is retired without awaiting,
   * so the JSONL backend's transient win32 staging directories (.dsh-mkdir-*) can surface as ENOENT; the idempotent read backs off briefly.
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
      // A restart or resume meets the same wake boundary a message does: a cold stored generation is replaced instead of resumed.
      // A planned activation of a successor (`forkedFrom`) never re-decides; the swap that built it already did.
      if (forkedFrom === undefined && persisted) {
        const plan = await this.planWakeForMember(member, undefined)
        if (plan.action === 'recycle') {
          this.ctx.logger.info(`agent-team: activating ${this.memberScope(member.memberId, member.sessionId)} swaps its cold generation: idle ${plan.idleMs}ms over ${plan.thresholds.idleMs}ms, context ${plan.contextTokens} over ${plan.thresholds.minContextTokens}`)
          await this.contextManagement.requestRecycle(member.memberId, member)
          return
        }
      }
      // AgentOptions carries the whole configured route, so a fresh Session records its effort on the first request instead of through a synthetic selection event.
      const selection = member.model ?? this.ctx.agentDefaultModel.currentSelection()
      const agentOptions = { ...selection }
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
        // Only a resumed Session records the configured route, and it inherits the effort its own log recorded for that route; a fresh Session's route rides AgentOptions, exactly as the driver's own resume does.
        if (persisted) this.applyConfiguredRoute(agent, selection)
        installModelSelection(agentCtx)
        agentCtx.on('session/event', (session, event) => {
          if (session !== agent.session || event.type !== 'request/header') return
          this.adoptMemberRouteFromRequest(member.memberId, agent, session.id, event)
        })
        installMemberCompaction(
          agentCtx, agent, () => this.memberCompactionConfig(),
          () => this.compactionEngineFor(agent), () => this.retiringAgents.has(agent),
        )
        agentCtx.on('agent/pre-step', async ({ agent }, next) => {
          // The original inbox insertion is the durable replay source even if
          // this driver already claimed it; requeueing can reorder later input.
          return this.retiringAgents.has(agent) ? { kind: 'reject' as const } : next()
        })
        return {
          commit: () => {
            // The member scope composes no sandbox-policy service, so read the last logged mode from the session log (`sandbox/mode` is log-only).
            // Re-appending only when the effective mode differs keeps resumed members from growing redundant events.
            const logged = agent.session.ownEvents().toReversed().find(event => event.type === 'sandbox/mode')
            if (logged?.data.mode !== 'danger-full-access') setSandboxMode(agent.session, 'danger-full-access')
          },
        }
      }
      // The Session this generation replaces, read from the ledger's transition record when the caller names none:
      // a crash between the durable swap commit and this activation recreates the Session from the ledger binding alone.
      // The Host session header does NOT carry it: a rollover's lineage is the ledger's own transition, and `parentSession`
      // now names a subagent's creator, so writing it here would misreport the relation to every reader of the header.
      const lineageParent = forkedFrom ?? (!persisted ? this.requireLedger().previousSessionForMember(member.memberId) : undefined)
      let recoveryCarried = 0
      created = persisted
        ? await this.ctx.agents.resume({ resumeSessionId: member.sessionId, agentOptions, setup })
        : await this.ctx.agents.create({
            sessionId: member.sessionId,
            meta: {
              cwd: workspacePath,
              agentPreset: member.presetId,
            },
            agentOptions,
            setup,
          })
      this.memberRuntime.mountMemberSkillProvider(member, created.agent.ctx, member.capabilities?.skills?.allow)
      // Both capability effects are now live: record the intent the surface reflects so a later edit or retry compares against reality.
      this.memberRuntime.recordAppliedCapabilities(member.memberId, member.capabilities)
      await workspace.attachSession(member.sessionId)
      this.handles.set(member.memberId, created)
      this.memberIdle.status(member.memberId, created.agent.status, Date.now())
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
        )
        if (state.pending !== null) this.contextManagement.recoverPendingTransition(member.memberId, created.agent, member.sessionId)
        // A restart between a checkpoint's durable result and its quiet follow-up delivery repairs exactly once.
        this.contextManagement.repairContinuations(created.agent, state)
        // Carried input redelivery binds to the committed transition target (this Session), so a crash after the binding flipped still replays here.
        recoveryCarried = await this.replayCarriedInput(member, created.agent, generationStarted)
      } else if (lineageParent !== undefined) {
        recoveryCarried = await this.replayCarriedInput(member, created.agent, generationStarted)
      }
      // Give carried input its own turn before the rederived Inbox notice;
      // steering the notice could otherwise overtake that input.
      if (options?.deferNotify !== true) {
        this.notifyMember(created.agent, {
          kind: 'activation',
          ...(lineageParent === undefined ? {} : { previousSessionId: lineageParent }),
        }, recoveryCarried > 0)
      }
      this.scheduleTaskReminderEvaluation()
    } catch (error) {
      if (created !== undefined) {
        await this.disposeWithWakeGuard(created)
        if (this.handles.get(member.memberId) === created) this.handles.delete(member.memberId)
      }
      this.memberRuntime.forgetMember(member.memberId)
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`agent-team: activation failed for member '${this.memberLabel(member.memberId)}': ${message}`)
      this.setActivationDiagnostic(member.memberId, this.activationDiagnosticOf(error, member.sessionId))
    } finally {
      this.emitMemberPresenceChanged(member)
    }
  }


  /**
   * Rebuild one enabled Member in place from its persisted Session. A bundle-row reload prunes the preset roster mount while live agents keep dead scope bindings,
   * so the Member loses its composed tools. Re-running composition needs a fresh Agent; disposal marks the recreated Session unavailable in the Web Client until reopened, as suspend/resume does.
   */
  private reactivateMember(memberId: AgentTeamMemberId): Promise<boolean> {
    return this.enqueueLifecycle(memberId, async () => {
      const member = this.requireLedger().getMember(memberId)
      if (member === undefined || member.state !== 'enabled') return false
      const stale = this.handles.get(memberId)
      if (stale !== undefined) {
        this.handles.delete(memberId)
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
      // Different module instances of @deepseek-ai/dsh-scope (commonly from running the CLI from source via tsx).
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
   * Route one activation failure to its diagnostic class: preset composition failures by error class, session failures by the seam's typed classification,
   * everything else as an unclassified activation failure.
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

  /** Coalesce event-driven checks; reminders themselves never recursively schedule another pass. */
  private scheduleTaskReminderEvaluation(): void {
    if (!this.accepting || this.ledger === undefined) return
    this.reminderEvaluationRequested = true
    void this.evaluateTaskReminders()
  }

  private evaluateTaskReminders(): Promise<void> {
    this.reminderEvaluationTail = this.reminderEvaluationTail.then(async () => {
      if (this.ledger === undefined) return
      do {
        this.reminderEvaluationRequested = false
        const nowMs = Date.now()
        const idleMs = (memberId: AgentTeamMemberId) => this.memberIdle.idleMs(memberId, nowMs)
        const candidates = this.requireLedger().planReminders(nowMs, idleMs)
        for (const candidate of candidates) {
          const receipt = await this.requireLedger().raiseReminder(candidate, nowMs, idleMs)
          if (receipt !== undefined) this.emitCommitted(receipt)
        }
      } while (this.reminderEvaluationRequested)
    }).catch(error => {
      this.ctx.logger.warn(`agent-team: Task reminder evaluation failed: ${failureDetail(error)}`)
    })
    return this.reminderEvaluationTail
  }

  // ── Project subscriptions ────────────────────────────────────────────────

  /**
   * Open the scheduler's private store and give every timer subscription its
   * first due instant. Boot never resets a persisted due instant or a
   * publication window: a Host that was away catches up once instead of
   * restarting the window.
   */
  private async startSubscriptionRuntime(domain: Domain<typeof subscriptionDomainSpec>): Promise<void> {
    this.subscriptionDomain = domain
    const table = domain.table('checkpoints')
    this.subscriptionTable = table
    this.subscriptionRunsTable = domain.table('runs')
    this.subscriptionDeliveriesTable = domain.table('deliveries')
    this.subscriptionReplaysTable = domain.table('replays')
    this.subscriptionAdmissionsTable = domain.table('admissions')
    for (const [subscriptionRef, checkpoint] of table.entries()) this.subscriptionCheckpoints.set(subscriptionRef, checkpoint)
    // A deletion that could not finish its cleanup — a crash between the ledger
    // commit and the row drops, or a storage fault — leaves rows nobody will ever
    // read. Boot converges them instead of trusting the caller to have done it.
    await this.convergeSubscriptionPrivateState()
    const scheduler = new SubscriptionScheduler({
      now: () => Date.now(),
      random: () => Math.random(),
      schedule: (run, delayMs) => {
        const timer = setTimeout(run, delayMs)
        // A pending timer must never be the reason the Host process stays alive.
        timer.unref()
        return timer
      },
      cancel: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
      log: message => { this.ctx.logger.warn(`agent-team: ${message}`) },
      // Every subscription, deleted ones included: a run that started before a
      // deletion still names the record it came from.
      subscriptions: () => this.ledger === undefined ? [] : this.ledger.subscriptions(),
      // What admission re-reads before it spends a slot: a queued entry holds a
      // snapshot, and a delete or an archive must still stop it. A ref the
      // ledger never stored is a create's draft trial, which has no record to
      // reconcile against.
      current: subscriptionRef => this.ledger?.subscription(subscriptionRef),
      projectActive: subscription => this.requireLedger().getProject(subscription.projectRef)?.state === 'active',
      workspacePath: subscription => this.subscriptionWorkspaceRoot(subscription),
      pending: subscriptionRef => this.requireLedger().pendingSubscriptionEvents(subscriptionRef)
        .map(entry => ({ acceptedSequence: entry.acceptedSequence, eventId: entry.event.id })),
      run: subscription => this.runTimerSubscription(subscription),
      publish: (subscription, acceptedSequence, eventId) => this.commitSubscriptionPublication(subscription, acceptedSequence, eventId),
      pauseForFailures: subscription => this.commitFailurePause(subscription),
      checkpoint: subscriptionRef => this.subscriptionCheckpoints.get(subscriptionRef) ?? { subscriptionRef, ...INITIAL_CHECKPOINT },
      save: (subscriptionRef, change) => this.updateCheckpoint(subscriptionRef, change),
    })
    this.subscriptionScheduler = scheduler
    await scheduler.settleBoot()
    scheduler.start()
    // Deliveries accepted before the last shutdown are due now: the queue is
    // durable, so a boot is the moment it resumes rather than a fresh start.
    void this.pumpWebhookAdmissions()
    this.admissionPumpTimer = setInterval(() => { void this.pumpWebhookAdmissions() }, WEBHOOK_PUMP_INTERVAL_MS)
    this.admissionPumpTimer.unref?.()
  }

  /**
   * Change one checkpoint, under the subscription's write lock.
   *
   * A checkpoint is one row that four writers touch: a run settling its due
   * instant, a spent delivery being counted, the publish window advancing, and a
   * success clearing the streak. Each of them changes one field, so a writer that
   * composed its record from an earlier read drops whatever the others committed
   * meanwhile — and the loss is silent, because the last write wins. This is the
   * only form of checkpoint write there is.
   *
   * `change` runs on the record read inside the lock, and `undefined` means the
   * ledger no longer serves the subscription: nothing is written, so a run that
   * finished after the deletion cannot recreate the row the deletion dropped.
   */
  private updateCheckpoint(subscriptionRef: AgentTeamSubscriptionRef,
    change: (checkpoint: SubscriptionCheckpoint) => SubscriptionCheckpoint): Promise<SubscriptionCheckpoint | undefined> {
    return this.serializeSubscriptionWrite(subscriptionRef, () => this.updateCheckpointLocked(subscriptionRef, change))
  }

  /** {@link updateCheckpoint} for a caller that already holds the subscription's lock. */
  private async updateCheckpointLocked(subscriptionRef: AgentTeamSubscriptionRef,
    change: (checkpoint: SubscriptionCheckpoint) => SubscriptionCheckpoint): Promise<SubscriptionCheckpoint | undefined> {
    const subscription = this.writableSubscription(subscriptionRef)
    if (subscription === undefined) return undefined
    const checkpoint = change(this.checkpointFor(subscriptionRef))
    // Persist first, project second: a failed write must leave the live
    // checkpoint where the durable one still is, or a storage error would look
    // like a saved wake-up that no restart finds.
    await this.subscriptionTable?.put(subscriptionRef, checkpoint)
    this.subscriptionCheckpoints.set(subscriptionRef, checkpoint)
    return checkpoint
  }

  /**
   * The success linearization: end the streak, in the segment that accepted the
   * output. Its caller holds the subscription's write lock, so no delivery the
   * ingress counts can land between the accept and this write — the streak it
   * clears is exactly the defeats counted before the accept, and one that
   * arrives afterwards starts a new streak.
   */
  private async clearSubscriptionFailuresLocked(subscriptionRef: AgentTeamSubscriptionRef, accepted: boolean,
    sourceRevision: number): Promise<void> {
    try {
      if (this.writableSubscription(subscriptionRef)?.revision !== sourceRevision) return
      await this.updateCheckpointLocked(subscriptionRef, checkpoint => Object.freeze({ ...checkpoint,
        consecutiveFailures: 0, ...(accepted ? { lastSuccessAt: new Date().toISOString() } : {}) }))
    } catch (error) {
      // The output is already in the ledger: a count that cannot be cleared is
      // no reason to call a delivered run a failure, and the next success
      // clears it again.
      this.ctx.logger.warn(`agent-team: could not clear the failure count of '${subscriptionRef}': ${failureDetail(error)}`)
    }
  }

  private checkpointFor(subscriptionRef: AgentTeamSubscriptionRef): SubscriptionCheckpoint {
    return this.subscriptionCheckpoints.get(subscriptionRef) ?? { subscriptionRef, ...INITIAL_CHECKPOINT }
  }

  /**
   * The stored record when its private state may still be written: it exists, it
   * is not deleted, and its Project still runs. Every private write reads the
   * ledger through this first — a terminal barrier that only the caller checks
   * is a barrier the next caller forgets.
   */
  private writableSubscription(subscriptionRef: AgentTeamSubscriptionRef): AgentTeamSubscription | undefined {
    const stored = this.ledger?.subscription(subscriptionRef)
    if (stored === undefined || stored.state === 'deleted') return undefined
    return this.ledger?.getProject(stored.projectRef)?.state === 'active' ? stored : undefined
  }

  /**
   * Every private row naming one subscription. A checkpoint is keyed by the ref
   * itself; the other tables put the ref before a `|`, and a ref never contains
   * one, so the key prefix is the ref either way.
   */
  private privateKeysOf(table: { keys(): Iterable<string> }, subscriptionRef: AgentTeamSubscriptionRef): readonly string[] {
    const prefix = `${subscriptionRef}|`
    return [...table.keys()].filter(key => key === subscriptionRef || key.startsWith(prefix))
  }

  /** The private tables a subscription owns, each with the word a failed delete logs it as. */
  private subscriptionPrivateTables(): readonly (readonly [{ keys(): Iterable<string>; delete(key: string): Promise<boolean> } | undefined, string])[] {
    return [
      [this.subscriptionTable, 'checkpoint'],
      [this.subscriptionRunsTable, 'run'],
      [this.subscriptionDeliveriesTable, 'delivery'],
      [this.subscriptionReplaysTable, 'replay'],
      [this.subscriptionAdmissionsTable, 'admission'],
    ]
  }

  /**
   * Drop one subscription's private state, ordered against its other private
   * writes by the same lock.
   *
   * A cleanup that ran beside a replay's own answer commit could delete the rows
   * first and see them written back after: the deleting side must take the lock
   * the writing side holds, so either the write finishes and the cleanup drops
   * it, or the cleanup lands first and the write's barrier read finds nothing
   * live and writes nothing.
   */
  private forgetSubscriptionPrivateState(subscriptionRef: AgentTeamSubscriptionRef): Promise<void> {
    return this.serializeSubscriptionWrite(subscriptionRef, () => this.dropSubscriptionPrivateState(subscriptionRef))
  }

  /**
   * Drop every private row of one subscription: its checkpoint, its runs, its
   * failed deliveries, and the answers already given to replay requests. Awaited,
   * so a caller that reported the deletion has actually cleaned up; a row that
   * will not delete is logged and left to the boot sweep, never retried here.
   */
  private async dropSubscriptionPrivateState(subscriptionRef: AgentTeamSubscriptionRef): Promise<void> {
    this.subscriptionCheckpoints.delete(subscriptionRef)
    for (const [table, label] of this.subscriptionPrivateTables()) {
      if (table === undefined) continue
      for (const key of this.privateKeysOf(table, subscriptionRef)) {
        try {
          await table.delete(key)
        } catch (error) {
          this.ctx.logger.warn(`agent-team: could not drop a ${label} record: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  /**
   * Convergence at boot: a deletion that never finished its cleanup — a crash
   * between the ledger commit and the row drops, or a storage fault — must not
   * leave rows that nobody can read or ever remove. A dead subscription is one
   * the ledger no longer serves, which covers both a deletion and an archived
   * Project.
   */
  private async convergeSubscriptionPrivateState(): Promise<void> {
    for (const [table, label] of this.subscriptionPrivateTables()) {
      if (table === undefined) continue
      // Snapshot the keys: this loop deletes the rows it is walking.
      for (const key of Array.from(table.keys())) {
        const cut = key.indexOf('|')
        const subscriptionRef = (cut < 0 ? key : key.slice(0, cut)) as AgentTeamSubscriptionRef
        if (this.writableSubscription(subscriptionRef) !== undefined) continue
        this.subscriptionCheckpoints.delete(subscriptionRef)
        try {
          await table.delete(key)
        } catch (error) {
          this.ctx.logger.warn(`agent-team: could not drop the stale ${label} record of '${subscriptionRef}': ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  /** The Project's Workspace root as the Host's own registry holds it — never the process cwd. */
  private subscriptionWorkspaceRoot(subscription: AgentTeamSubscription): string | undefined {
    const project = this.ledger?.getProject(subscription.projectRef)
    return project === undefined ? undefined : this.ctx.workspaceRegistry.get(project.workspaceId)?.path
  }

  private shellExecutor(): SubscriptionShellExecutor | undefined {
    return this.ctx.get('shell') as SubscriptionShellExecutor | undefined
  }

  private credentialProvider(): SubscriptionCredentials | undefined {
    return this.ctx.get('credentials') as SubscriptionCredentials | undefined
  }

  /**
   * The mounted executor's family answer, decided by behavior once and cached;
   * a refusal is retried because the executor may be mounted later.
   */
  private mountedShellProbe(): Promise<ShellFamilyProbe> {
    if (this.subscriptionShellProbe === undefined) {
      this.subscriptionShellProbe = probeShellFamily(this.shellExecutor()).then(answer => {
        if (answer.family === undefined) this.subscriptionShellProbe = undefined
        return answer
      })
    }
    return this.subscriptionShellProbe
  }

  private async executeSubscriptionRun(subscription: AgentTeamSubscription, trigger: SubscriptionRunTrigger,
    extra: { readonly stdin?: string | undefined; readonly deliveryId?: string | undefined } = {}): Promise<SubscriptionRunReport> {
    const probe = await this.mountedShellProbe()
    return runSubscriptionScript({
      executor: this.shellExecutor(),
      credentials: this.credentialProvider(),
      liveShell: probe.family,
      ...(probe.failure === undefined ? {} : { liveShellFailure: probe.failure }),
      subscription,
      trigger,
      workspaceRoot: this.subscriptionWorkspaceRoot(subscription),
      lastSuccessAt: this.checkpointFor(subscription.subscriptionRef).lastSuccessAt,
      ...(extra.stdin === undefined ? {} : { stdin: extra.stdin }),
      ...(extra.deliveryId === undefined ? {} : { deliveryId: extra.deliveryId }),
    })
  }

  /**
   * Record one finished run in the subscription's private history. A draft the
   * ledger never stored — a create's trial — has no subscription to keep a
   * record under, and a deletion drops the records it wrote.
   *
   * The record is one row of the same private state the deletion cleans up, so
   * it is written under the subscription's write lock and reads the barrier
   * there, beside the `put` and the eviction that belongs with it: a deletion
   * that committed first owns the rows and this write refuses, and one that
   * commits while this segment runs waits for it and then drops what it wrote.
   * The script already finished, so the lock is held for one write, not a run.
   *
   * The answer says whether the record was written. A private write that fails
   * is a diagnostic failure, never a failed run: the ledger already holds what
   * the run produced.
   */
  private recordSubscriptionRun(record: SubscriptionRunRecord): Promise<boolean> {
    const table = this.subscriptionRunsTable
    if (table === undefined) return Promise.resolve(false)
    return this.serializeSubscriptionWrite(record.subscriptionRef, async () => {
      if (this.writableSubscription(record.subscriptionRef) === undefined) return false
      try {
        await table.put(subscriptionRunKey(record), record)
        for (const key of evictedRunKeys(subscriptionRunKeysOf(table.keys(), record.subscriptionRef))) await table.delete(key)
        return true
      } catch (error) {
        this.ctx.logger.warn(`agent-team: could not record a run of '${record.subscriptionRef}': ${failureDetail(error)}`)
        return false
      }
    })
  }

  /**
   * One run end to end: execute the pinned definition, then commit what it
   * printed. The record is written after the accept, because a run succeeded at
   * the instant its output became durable — the same instant that clears the
   * failure count.
   *
   * `runRef` and `recorded` are separate answers on purpose: the ref names the
   * run whatever happened to the private copy, and `recorded` says whether the
   * copy exists. A caller that treated a missing record as a failed run would
   * report a delivered output as undelivered and run it again.
   *
   * `undefined` means the subscription or its Project stopped being live while
   * the script ran. That is a terminal barrier, not a failure of the script, and
   * it writes nothing: the records it would touch were dropped with the
   * subscription, so writing here would recreate them with nobody to clean up.
   */
  private async runSubscriptionOnce(subscription: AgentTeamSubscription, trigger: Exclude<SubscriptionRunTrigger, 'test'>,
    extra: {
      readonly stdin?: string | undefined
      readonly delivery?: { readonly deliveryRef: string; readonly attempt: number } | undefined
      /**
       * The id the script reads as `DSH_TEAM_DELIVERY_ID`: the Host's own admission (or
       * the delivery ref), so a retry and a replay run under the id the first attempt saw.
       */
      readonly scriptDeliveryId?: string | undefined
      /**
       * The request this run answers, when the caller has one — a replay or a queued
       * delivery. The accept then commits under that id, so the ledger itself
       * remembers that this request delivered, and a caller whose private
       * bookkeeping failed reads the answer back instead of running the script again.
       */
      readonly requestId?: AgentTeamRequestId | undefined
      /** Where a batch with no room goes: the row that owes the delivery, or nowhere. */
      readonly holdEvents?: ((events: readonly SubscriptionEvent[]) => Promise<void>) | undefined
    } = {},
  ): Promise<SubscriptionRunResult | undefined> {
    const startedAt = Date.now()
    const report = await this.executeSubscriptionRun(subscription, trigger, {
      ...(extra.stdin === undefined ? {} : { stdin: extra.stdin }),
      ...(extra.scriptDeliveryId === undefined && extra.delivery === undefined
        ? {} : { deliveryId: extra.scriptDeliveryId ?? extra.delivery!.deliveryRef }),
    })
    // `eventCount` is what this run had accepted into the ledger, so it is known
    // only once the deduplication has run — never the count the script printed,
    // which counts what was already known as if it were new.
    const finish = async (outcome: SubscriptionRunResult['outcome'], category: SubscriptionRunCategory,
      eventCount: number): Promise<SubscriptionRunResult> => {
      const record = runRecordOf({ subscription, trigger, startedAt, durationMs: Date.now() - startedAt, category, eventCount, report,
        ...(extra.delivery === undefined ? {} : { delivery: extra.delivery }) })
      return { outcome, report, runRef: record.runRef, eventCount, recorded: await this.recordSubscriptionRun(record) }
    }
    if (!report.ok) return finish('failed', failureCategory(report), 0)
    const committed = await this.commitRunOutput(subscription, report, extra.requestId, extra.holdEvents)
    if (committed === undefined) return undefined
    if (committed.outcome === 'empty') return finish('empty', 'empty', 0)
    if (committed.outcome === 'backlog') return finish('backlog', 'backlog-full', 0)
    if (committed.outcome === 'deferred') return finish('deferred', 'backlog-full', 0)
    return finish('accepted', 'accepted', committed.eventCount)
  }

  /**
   * Commit what one run printed: drop the ids the subscription already knows,
   * accept the rest, and end the failure streak — all in one segment under the
   * subscription's write lock.
   *
   * They belong together because the clear is only honest for defeats counted
   * before it. A delivery the ingress counted beside the run must fall either
   * inside the streak this success ends or outside it entirely, and nothing but
   * the lock can say which: read the count, accept, then clear leaves the window
   * where a defeat lands in between and is cleared with the rest. The script
   * runs outside the lock — holding it for the script would stall every delivery
   * for its whole duration.
   *
   * `undefined` means the subscription or its Project stopped being live while
   * the script ran: a terminal barrier, not a failure of the script, and it
   * writes nothing at all.
   */
  private commitRunOutput(subscription: AgentTeamSubscription, report: SubscriptionRunReport,
    requestId: AgentTeamRequestId | undefined,
    holdEvents?: ((events: readonly SubscriptionEvent[]) => Promise<void>) | undefined,
  ): Promise<{ readonly outcome: 'accepted' | 'empty' | 'backlog' | 'deferred'; readonly eventCount: number } | undefined> {
    const subscriptionRef = subscription.subscriptionRef
    const ledger = this.requireLedger()
    return this.serializeSubscriptionWrite(subscriptionRef, async () => {
      // Nothing admits this write but its caller, so the barrier is read here,
      // inside the lock, rather than from the snapshot the run started with.
      if (this.writableSubscription(subscriptionRef) === undefined) return undefined
      const known = ledger.subscriptionKnownIds(subscriptionRef)
      const fresh = report.events.filter(event => !known.has(event.id))
      const decision = await this.acceptFreshEvents(subscription, fresh, requestId ?? (randomUUID() as AgentTeamRequestId), holdEvents)
      if (decision.outcome === 'dropped') return undefined
      return Object.freeze({ outcome: decision.outcome, eventCount: decision.outcome === 'accepted' ? decision.eventCount : 0 })
    })
  }

  /**
   * Accept one run's new events, or say why they wait. The caller holds the write
   * lock and has read the terminal barrier in it. No room is not a failure: `hold`
   * keeps a batch its request can never fetch again.
   */
  private async acceptFreshEvents(subscription: AgentTeamSubscription, events: readonly SubscriptionEvent[],
    requestId: AgentTeamRequestId, hold?: ((events: readonly SubscriptionEvent[]) => Promise<void>) | undefined,
  ): Promise<AgentTeamAcceptDecision> {
    const ledger = this.requireLedger()
    const subscriptionRef = subscription.subscriptionRef
    if (events.length === 0) {
      // Nothing new is a success that accepts nothing: it ends the streak and
      // leaves the waterline where it was.
      await this.clearSubscriptionFailuresLocked(subscriptionRef, false, subscription.revision)
      return Object.freeze({ outcome: 'empty' as const })
    }
    if (events.length > SUBSCRIPTION_PENDING_MAX) {
      this.ctx.logger.warn(`agent-team: subscription '${subscriptionRef}' printed ${events.length} events, past the ${SUBSCRIPTION_PENDING_MAX} it can still publish; this batch was refused`)
      return Object.freeze({ outcome: 'backlog' as const })
    }
    const pending = ledger.pendingSubscriptionEvents(subscriptionRef).length
    if (pending + events.length > SUBSCRIPTION_PENDING_MAX) {
      this.ctx.logger.warn(`agent-team: subscription '${subscriptionRef}' already holds ${pending} unpublished events; ${events.length} more wait for room`)
      if (hold !== undefined) await hold(events)
      return Object.freeze({ outcome: 'deferred' as const })
    }
    const project = ledger.getProject(subscription.projectRef)
    if (project === undefined) return Object.freeze({ outcome: 'dropped' as const })
    try {
      const result = await ledger.acceptSubscriptionEvents({
        requestId, workspaceId: project.workspaceId,
        projectRef: subscription.projectRef, subscriptionRef, subscriptionRevision: subscription.revision,
        scriptHash: subscription.script.sha256, events, actor: agentTeamHostActor(),
      })
      if (result.committed) this.emitCommitted(result.value.receipt)
    } catch (error) {
      // A subscription deleted, or a Project archived, while the script ran
      // is a terminal barrier rather than a failure of the script.
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('subscription_deleted') && !message.includes('archived')) throw error
      this.ctx.logger.warn(`agent-team: subscription '${subscriptionRef}' finished after it stopped being live; the output was dropped`)
      return Object.freeze({ outcome: 'dropped' as const })
    }
    await this.clearSubscriptionFailuresLocked(subscriptionRef, true, subscription.revision)
    return Object.freeze({ outcome: 'accepted' as const, eventCount: events.length })
  }

  /**
   * One timer run for the scheduler. The outcome tells it whether to count a
   * failure, so a run that printed nothing new never pauses a subscription. A
   * batch past the unpublished ceiling is a failure — the script printed more
   * than the Project can still take — while a subscription already at the
   * ceiling never reaches this method: admission skips it before it starts.
   */
  private async runTimerSubscription(subscription: AgentTeamSubscription): Promise<SubscriptionRunOutcome> {
    const subscriptionRef = subscription.subscriptionRef
    const ledger = this.requireLedger()
    const project = ledger.getProject(subscription.projectRef)
    // The subscription or its Project stopped being live before the run got a
    // slot: nothing to record, and nothing the script could have done.
    if (project === undefined || ledger.subscription(subscriptionRef)?.state === 'deleted') return 'dropped'
    const run = await this.runSubscriptionOnce(subscription, 'interval')
    if (run === undefined) return 'dropped'
    if (ledger.subscription(subscriptionRef)?.revision !== subscription.revision) return 'dropped'
    if (run.outcome === 'failed') {
      this.ctx.logger.warn(`agent-team: subscription '${subscriptionRef}' run failed: ${run.report.reason ?? 'unknown reason'}`)
    }
    return run.outcome
  }

  private async commitSubscriptionPublication(subscription: AgentTeamSubscription, acceptedSequence: number, eventId: string): Promise<void> {
    const project = this.requireLedger().getProject(subscription.projectRef)
    if (project === undefined) return
    const result = await this.requireLedger().publishSubscriptionEvent({
      requestId: randomUUID() as AgentTeamRequestId, workspaceId: project.workspaceId, projectRef: subscription.projectRef,
      subscriptionRef: subscription.subscriptionRef, acceptedSequence, eventId, actor: agentTeamHostActor(),
    })
    if (result.committed) this.emitCommitted(result.value.receipt)
  }

  /** Three failed runs in a row pause a subscription: the ledger records it and the Main stream tells every owner. */
  private async commitFailurePause(subscription: AgentTeamSubscription): Promise<void> {
    const ledger = this.requireLedger()
    const project = ledger.getProject(subscription.projectRef)
    const current = ledger.subscription(subscription.subscriptionRef)
    if (project === undefined || current === undefined || current.state !== 'active') return
    const result = await ledger.pauseSubscription({
      requestId: randomUUID() as AgentTeamRequestId, workspaceId: project.workspaceId, projectRef: current.projectRef,
      subscriptionRef: current.subscriptionRef, expectedRevision: current.revision, actor: agentTeamHostActor(), reason: 'failures',
    })
    if (result.committed) this.emitCommitted(result.value.receipt)
  }

  private subscriptionListEntries<T>(request: AgentTeamSubscriptionListRequest,
    select: (subscription: AgentTeamSubscription) => T): AgentTeamSubscriptionListResult<T> {
    const ledger = this.requireLedger()
    const entries = ledger.subscriptionsOfProject(request.projectRef).map(stored => {
      const subscriptionRef = stored.subscriptionRef
      const accepted = ledger.subscriptionEvents(subscriptionRef)
      const lastRun = this.runRecordsOf(subscriptionRef)[0]
      const dueAt = this.checkpointFor(subscriptionRef).dueAt
      return Object.freeze({
        subscription: select(stored),
        unpublished: ledger.pendingSubscriptionEvents(subscriptionRef).length,
        eventCount: accepted.length,
        ...(accepted.length === 0 ? {} : { lastEventAt: accepted.at(-1)!.acceptedAt }),
        ...(lastRun === undefined ? {} : { lastRun: runSummaryOf(lastRun) }),
        ...(dueAt === undefined ? {} : { nextRunAt: new Date(dueAt).toISOString() }),
      })
    })
    return Object.freeze({ entries: Object.freeze(entries) })
  }

  private listSubscriptions(actor: AgentTeamActor, request: AgentTeamSubscriptionListRequest): AgentTeamSubscriptionListResult {
    this.requireLedger().assertSubscriptionReadAuthority(actor, request.projectRef, request.workspaceId)
    return this.subscriptionListEntries(request, subscription => subscription)
  }

  /** Agent discovery returns no script, credential reference or webhook arm, even to a Project member. */
  subscriptionsForAgent(agent: Agent, request: AgentTeamSubscriptionListRequest): AgentTeamSubscriptionListResult<AgentTeamSubscriptionMetadata> {
    const actor = this.memberCall(agent, request.workspaceId)
    this.requireLedger().assertSubscriptionMetadataAuthority(actor, request.projectRef, request.workspaceId)
    return this.subscriptionListEntries(request, subscription => {
      const { script: _script, credentials: _credentials, webhook: _webhook, ...metadata } = subscription
      return metadata
    })
  }

  @Remote('subscriptions')
  subscriptionsForClient(request: AgentTeamSubscriptionListRequest): AgentTeamSubscriptionListResult {
    return this.listSubscriptions(this.humanCall(request.workspaceId), request)
  }

  /**
   * One subscription's recorded runs, newest first. Two runs can start in the
   * same millisecond, so the answer is ordered by start instant and falls back
   * to the ref: the key order alone is only start order while instants differ.
   */
  private runRecordsOf(subscriptionRef: AgentTeamSubscriptionRef): readonly SubscriptionRunRecord[] {
    const table = this.subscriptionRunsTable
    if (table === undefined) return []
    const records = subscriptionRunKeysOf(table.keys(), subscriptionRef)
      .map(key => table.get(key))
      .filter((record): record is SubscriptionRunRecord => record !== undefined)
    return Object.freeze(records.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt)
      || (left.runRef < right.runRef ? -1 : 1)))
  }

  /**
   * Start one Worker for the calling Member. The target is resolved and ownership
   * of its Project checked before anything is written or started, and that binding
   * is what the run's result follows from then on: a bound run reports in its
   * Thread and wakes this Member through the Inbox, an unbound one keeps the
   * direct parent result. It reads only the handle's identity, `ctx.get(
   * 'workingDirectory')` and the `session` passed to it, which is the stub surface
   * a lane without a real Session needs; `worker-host-thread.spec.ts` pins it.
   */
  async workerStartForAgent(agent: Agent, request: WorkerDelegationRequest): Promise<AgentTeamWorkerRun> {
    const actor = this.memberActor(agent)
    const target = this.workerDelegationTarget(request)
    const workingDirectory = agent.ctx.get('workingDirectory') as { get(session: Agent['session']): string } | undefined
    const cwd = request.cwd ?? workingDirectory?.get(agent.session)
    return this.workerRegistry.start({ actor, parent: agent }, {
      requestId: request.requestId,
      workspaceId: target.workspaceId,
      projectRef: target.projectRef,
      ...(target.kind === 'thread' ? { threadRef: target.threadRef } : {}),
      ...(target.kind === 'thread' && target.taskRef !== undefined ? { taskRef: target.taskRef } : {}),
      ...(request.engine === undefined ? {} : { engine: request.engine }),
      task: request.task,
      ...(cwd === undefined ? {} : { cwd }),
    })
  }

  /** The Project a delegation belongs to, taken from its target; every refusal precedes any write. */
  private workerDelegationTarget(request: WorkerDelegationRequest): Extract<AgentTeamDelegationTarget, { kind: 'project' | 'thread' }> {
    const target = this.requireLedger().delegationTarget({ projectRef: request.projectRef,
      threadRef: request.threadRef, taskRef: request.taskRef })
    switch (target.kind) {
      case 'project':
      case 'thread': return target
      case 'target-required':
        throw new WorkerRefusal('worker_target_required', 'A delegation names the Thread, Task, or Project it works on.')
      case 'project-unknown':
        throw new WorkerRefusal('worker_project_unknown', `${target.projectRef} is not a Project in this Team.`)
      case 'thread-unknown':
        throw new WorkerRefusal('worker_thread_unknown', `${target.threadRef} is not a Thread in this Team.`)
      case 'task-unknown':
        throw new WorkerRefusal('worker_task_unknown', `${target.taskRef} is not a Task in this Team.`)
      case 'target-conflict':
        throw new WorkerRefusal('worker_target_conflict', `Task ${target.taskRef} is not in Thread ${target.threadRef}.`)
    }
  }

  /** Every Worker this Host started, for the caller's own inspection. */
  workerRunsForAgent(agent: Agent): readonly AgentTeamWorkerRun[] {
    this.memberActor(agent)
    return this.workerRegistry.list()
  }

  /** One run as the caller may read it: the summary always, the output only an owner. */
  private logEntryOf(record: SubscriptionRunRecord, seesOutput: boolean): AgentTeamSubscriptionLogEntry {
    const summary = runSummaryOf(record)
    if (!seesOutput) return Object.freeze({ ...summary })
    return Object.freeze({ ...summary, ...(record.reason === undefined ? {} : { reason: record.reason }),
      stdoutTail: record.stdoutTail, stderrTail: record.stderrTail, scriptHash: record.scriptHash, attempt: record.attempt,
      ...(record.deliveryRef === undefined ? {} : { deliveryRef: record.deliveryRef }) })
  }

  /**
   * What a subscription's recent runs did. Every Project member may read the
   * summary; the halves only an owner reads are the script's own output and the
   * sentence a failure explains itself with, because the script runs with the
   * Project's credentials and its output may carry what they unlocked.
   */
  private subscriptionLogs(actor: AgentTeamActor, request: AgentTeamSubscriptionLogsRequest): AgentTeamSubscriptionLogsResult {
    const ledger = this.requireLedger()
    ledger.assertSubscriptionReadAuthority(actor, request.projectRef, request.workspaceId)
    const subscription = ledger.subscription(request.subscriptionRef)
    if (subscription === undefined || subscription.projectRef !== request.projectRef) {
      throw new Error(`subscription '${request.subscriptionRef}' does not belong to Project '${request.projectRef}'`)
    }
    if (subscription.state === 'deleted') throw new Error(`subscription '${request.subscriptionRef}' is deleted (subscription_deleted)`)
    const seesOutput = actor.kind === 'human'
      || (actor.kind === 'member' && ledger.projectOwnerIds(request.projectRef).includes(actor.memberId))
    const limit = Math.min(Math.max(request.limit ?? SUBSCRIPTION_RUN_HISTORY_LIMIT, 1), SUBSCRIPTION_RUN_HISTORY_LIMIT)
    return Object.freeze({ subscription,
      runs: Object.freeze(this.runRecordsOf(request.subscriptionRef).slice(0, limit).map(record => this.logEntryOf(record, seesOutput))) })
  }

  /** An Agent Member reads one subscription's runs; the authority split decides what it sees. */
  subscriptionLogsForAgent(agent: Agent, request: AgentTeamSubscriptionLogsRequest): AgentTeamSubscriptionLogsResult {
    return this.subscriptionLogs(this.memberCall(agent, request.workspaceId), request)
  }

  /** The Human page reads the same records, and always carries the output. */
  @Remote('subscriptionLogs')
  subscriptionLogsForClient(request: AgentTeamSubscriptionLogsRequest): AgentTeamSubscriptionLogsResult {
    return this.subscriptionLogs(this.humanCall(request.workspaceId), request)
  }

  /**
   * The delivery records of one subscription, still failing. They outlive the
   * run records on purpose: the run that failed may be evicted long before an
   * owner gets to replay the request that produced it.
   */
  private deliveryRecordsOf(subscriptionRef: AgentTeamSubscriptionRef): readonly SubscriptionDeliveryRecord[] {
    const table = this.subscriptionDeliveriesTable
    if (table === undefined) return []
    const records = deliveryKeysOf(table.keys(), subscriptionRef)
      .map(key => table.get(key))
      .filter((record): record is SubscriptionDeliveryRecord => record !== undefined)
    return Object.freeze(records)
  }

  private subscriptionDeliveries(actor: AgentTeamActor, request: AgentTeamSubscriptionDeliveriesRequest): AgentTeamSubscriptionDeliveriesResult {
    const ledger = this.requireLedger()
    // A failed delivery holds the request body it arrived with, so the list is
    // the owners' read, not every member's.
    ledger.assertSubscriptionAuthority(actor, request.projectRef, request.workspaceId)
    const subscription = ledger.subscription(request.subscriptionRef)
    if (subscription === undefined || subscription.projectRef !== request.projectRef) {
      throw new Error(`subscription '${request.subscriptionRef}' does not belong to Project '${request.projectRef}'`)
    }
    if (subscription.state === 'deleted') throw new Error(`subscription '${request.subscriptionRef}' is deleted (subscription_deleted)`)
    const records = this.deliveryRecordsOf(request.subscriptionRef)
    const failures = failedDeliveries(records, Date.now(), this.replayedDeliveryRefs(request.subscriptionRef, records))
    return Object.freeze({ deliveries: Object.freeze(failures.map(deliveryEntryOf)) })
  }

  /** An Agent owner lists the deliveries whose automatic retries are spent. */
  subscriptionDeliveriesForAgent(agent: Agent, request: AgentTeamSubscriptionDeliveriesRequest): AgentTeamSubscriptionDeliveriesResult {
    return this.subscriptionDeliveries(this.memberCall(agent, request.workspaceId), request)
  }

  /** The same list for the Human's page: the failed deliveries an owner reads and replays. */
  @Remote('subscriptionDeliveries')
  subscriptionDeliveriesForClient(request: AgentTeamSubscriptionDeliveriesRequest): AgentTeamSubscriptionDeliveriesResult {
    return this.subscriptionDeliveries(this.humanCall(request.workspaceId), request)
  }

  /**
   * One subscription's private read-modify-write steps, run one at a time: the ingress
   * is the only writer the scheduler does not admit, and two deliveries arriving
   * together would otherwise read the same failure count and lose one increment.
   */
  private serializeSubscriptionWrite<T>(subscriptionRef: AgentTeamSubscriptionRef, task: () => Promise<T>): Promise<T> {
    const previous = this.subscriptionWriteTails.get(subscriptionRef) ?? Promise.resolve()
    const next = previous.then(task, task)
    const settled = next.then(() => {}, () => {})
    this.subscriptionWriteTails.set(subscriptionRef, settled)
    void settled.then(() => {
      if (this.subscriptionWriteTails.get(subscriptionRef) === settled) this.subscriptionWriteTails.delete(subscriptionRef)
    })
    return next
  }

  /** Every admission one subscription still owes work for, in no particular order. */
  private admissionRecordsOf(subscriptionRef: AgentTeamSubscriptionRef): readonly SubscriptionAdmissionRecord[] {
    const table = this.subscriptionAdmissionsTable
    if (table === undefined) return []
    return admissionKeysOf(table.keys(), subscriptionRef)
      .map(key => table.get(key))
      .filter((record): record is SubscriptionAdmissionRecord => record !== undefined)
  }

  /**
   * The public entry's whole decision: whether this request becomes durable work. A
   * `queued` answer means the row is already written, so a restart before the 202
   * loses nothing; a storage failure throws and the entry answers 5xx. The token
   * resolves against the ledger's armed addresses, so a reset, a dropped trigger, a
   * deletion and an archive all answer "no such address" — while a delivery already
   * queued keeps its row, because a reset moves an address, not a queue.
   */
  async intakeWebhookDelivery(request: AgentTeamWebhookIntakeRequest): Promise<AgentTeamWebhookIntakeResult> {
    const ledger = this.requireLedger()
    const claimed = ledger.subscriptionByWebhookToken(request.token)
    if (claimed === undefined) return Object.freeze({ kind: 'not-found' })
    const table = this.subscriptionAdmissionsTable
    if (table === undefined) throw new Error('the subscription store is not open, so this delivery cannot be queued')
    return this.serializeSubscriptionWrite(claimed.subscriptionRef, async () => {
      // Read the barriers under the write lock: a delete, archive or pause that
      // landed while this request waited must win over it.
      const live = this.writableSubscription(claimed.subscriptionRef)
      if (live === undefined) return Object.freeze({ kind: 'not-found' })
      // The token is proof only while it is the one the ledger arms now: a reset that
      // committed while this request waited moved it.
      if (ledger.subscriptionByWebhookToken(request.token)?.subscriptionRef !== live.subscriptionRef) {
        return Object.freeze({ kind: 'not-found' })
      }
      if (live.state === 'paused') return Object.freeze({ kind: 'paused' })
      if (this.admissionRecordsOf(live.subscriptionRef).length >= WEBHOOK_QUEUE_LIMIT) {
        return Object.freeze({ kind: 'queue-full', retryAfterSeconds: WEBHOOK_QUEUE_RETRY_AFTER_SECONDS })
      }
      const admissionRef = admissionRefFor(randomUUID())
      const record: SubscriptionAdmissionRecord = Object.freeze({
        admissionRef,
        subscriptionRef: live.subscriptionRef,
        projectRef: live.projectRef,
        deliveryRef: admissionDeliveryRef(admissionRef, request.headers),
        receivedRevision: live.revision,
        receivedScriptHash: live.script.sha256,
        script: live.script,
        credentials: live.credentials,
        headers: Object.freeze({ ...request.headers }),
        body: request.body,
        receivedAt: new Date().toISOString(),
        attempts: 0,
        state: 'queued',
      })
      await table.put(admissionKey(live.subscriptionRef, admissionRef), record)
      return Object.freeze({ kind: 'queued', admissionRef })
    })
  }

  /**
   * Run what is due, one delivery per subscription per pass, through the scheduler's
   * admission so the four slots and the per-subscription mutex hold as they do for a
   * timer. A pass never throws out of the loop: the queue is durable, so a failed pass
   * leaves the rows for the next one.
   *
   * The queue is what owes work, not the trigger: a subscription edited into a
   * timer-only one stops serving its address, but a request already answered 202 is
   * still owed its run under the definition it arrived with.
   */
  private async pumpWebhookAdmissions(): Promise<void> {
    if (this.admissionPumpRunning || this.ledger === undefined) return
    this.admissionPumpRunning = true
    try {
      for (const subscription of this.ledger.subscriptions()) {
        // A paused subscription keeps its deliveries; none of them runs.
        if (subscription.state !== 'active') continue
        const due = dueAdmissions(this.admissionRecordsOf(subscription.subscriptionRef), Date.now())[0]
        if (due === undefined) continue
        await this.runWebhookAdmission(subscription, due)
      }
    } catch (error) {
      this.ctx.logger.warn(`agent-team: the webhook queue pass stopped: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.admissionPumpRunning = false
    }
  }

  /** One due delivery: run it, then settle its row from what the run reported. */
  private async runWebhookAdmission(subscription: AgentTeamSubscription, record: SubscriptionAdmissionRecord): Promise<void> {
    const live = this.writableSubscription(subscription.subscriptionRef)
    if (live === undefined) {
      await this.dropWebhookAdmission(record)
      return
    }
    if (live.state !== 'active') return
    // An accept the ledger already holds is this delivery's success, whatever its row
    // still says: a Host that stopped before removing it costs a read, not a second run.
    const attempt = record.attempts + 1
    const requestId = admissionAttemptRequestId(record.admissionRef, attempt)
    if (this.acceptedRequestEvents(record.subscriptionRef, requestId) !== undefined) {
      await this.dropWebhookAdmission(record)
      return
    }
    // A row that already holds a validated batch owes no script: only its accept,
    // retried until the queue has room.
    if (record.heldEvents !== undefined) {
      await this.enqueueHeldAdmission(record, requestId)
      return
    }
    // The definition the payload arrived under, not the one that stands now.
    const source = this.replaySource(live, record, 'received')
    const execute = () => this.runSubscriptionOnce(source, 'webhook', {
      stdin: webhookStdin(record.headers, record.body),
      scriptDeliveryId: record.admissionRef,
      delivery: { deliveryRef: record.deliveryRef, attempt },
      requestId,
      holdEvents: events => this.holdAdmissionEvents(record, events),
    })
    const scheduler = this.subscriptionScheduler
    const run = await (scheduler === undefined ? execute() : scheduler.runAdmitted(live, 'run', execute))
      .catch((error: unknown) => {
        // A host that is shutting down refuses the admission: nothing ran, so
        // nothing is owed and the row waits for the next boot.
        this.ctx.logger.warn(`agent-team: a webhook delivery was not admitted: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      })
    if (run === undefined) {
      // Either the subscription stopped being live mid-run, or no slot was
      // granted: a terminal barrier drops the row, a refused admission keeps it.
      if (this.writableSubscription(record.subscriptionRef) === undefined) await this.dropWebhookAdmission(record)
      return
    }
    if (run.outcome === 'accepted' || run.outcome === 'empty') {
      await this.dropWebhookAdmission(record)
      return
    }
    // `deferred` is not a failure: the row now holds the batch and waits for room.
    if (run.outcome === 'deferred') return
    // `backlog` is the run that printed more events than the Project can still
    // accept. The spec spends such a delivery's retries at once, because the
    // same script would print the same output again and fail the same way.
    const failure = run.report.ok
      ? `this run produced more events than the Project can hold (${SUBSCRIPTION_PENDING_MAX} unpublished)`
      : run.report.reason ?? 'the run failed'
    await this.retryOrFailWebhookAdmission(live, record, failure, run.outcome !== 'backlog')
  }

  /** Keep one run's batch on its delivery row: called inside the accept step's lock and barrier read. */
  private async holdAdmissionEvents(record: SubscriptionAdmissionRecord, events: readonly SubscriptionEvent[]): Promise<void> {
    const table = this.subscriptionAdmissionsTable
    const key = admissionKey(record.subscriptionRef, record.admissionRef)
    if (table === undefined || table.get(key) === undefined) return
    const { nextAttemptAt: _due, lastError: _error, ...waiting } = record
    await table.put(key, Object.freeze({ ...waiting, state: 'queued' as const, heldEvents: Object.freeze([...events]) }))
  }

  /**
   * Retry only the accept for a held batch: the payload's one run already happened.
   * A batch whose ids another run published meanwhile owes nothing and leaves too.
   */
  private enqueueHeldAdmission(record: SubscriptionAdmissionRecord,
    requestId: AgentTeamRequestId): Promise<void> {
    const ledger = this.requireLedger()
    const subscriptionRef = record.subscriptionRef
    return this.serializeSubscriptionWrite(subscriptionRef, async () => {
      const table = this.subscriptionAdmissionsTable
      const key = admissionKey(subscriptionRef, record.admissionRef)
      if (table === undefined || table.get(key) === undefined) return
      // The barrier is read here, inside the lock: a deletion that landed since the
      // pass began owns the rows, and recreating one would strand it.
      if (this.writableSubscription(subscriptionRef) === undefined) {
        await table.delete(key)
        return
      }
      const known = ledger.subscriptionKnownIds(subscriptionRef)
      const fresh = (record.heldEvents ?? []).filter(event => !known.has(event.id))
      if (fresh.length === 0) {
        await table.delete(key)
        return
      }
      const live = this.writableSubscription(subscriptionRef)
      if (live === undefined) {
        await table.delete(key)
        return
      }
      // The batch ran under the definition the payload arrived under, so the
      // accept attributes it to that revision even when an update landed since.
      const decision = await this.acceptFreshEvents(this.replaySource(live, record, 'received'), fresh, requestId)
      // Every answer but `deferred` settles the row: the batch is in the ledger, or
      // the record it would land on is gone.
      if (decision.outcome === 'accepted' || decision.outcome === 'empty' || decision.outcome === 'dropped') await table.delete(key)
    })
  }

  /**
   * Count one attempt and decide what the delivery owes next: another try on the
   * 1/5/30 ladder, or the failed-delivery record an owner replays. One delivery is one
   * failure however many attempts it took. `retryable` is false for a failure no retry
   * can change, which sends it straight to that record.
   */
  private retryOrFailWebhookAdmission(subscription: AgentTeamSubscription, record: SubscriptionAdmissionRecord,
    failure: string, retryable = true): Promise<void> {
    return this.serializeSubscriptionWrite(record.subscriptionRef, async () => {
      const table = this.subscriptionAdmissionsTable
      if (table === undefined) return
      const key = admissionKey(record.subscriptionRef, record.admissionRef)
      if (table.get(key) === undefined) return
      const attempts = record.attempts + 1
      const delay = retryable ? webhookRetryDelayMs(attempts) : undefined
      const live = this.writableSubscription(record.subscriptionRef)
      if (live === undefined) {
        await table.delete(key)
        return
      }
      if (delay !== undefined) {
        await table.put(key, Object.freeze({ ...record, attempts, state: 'retrying',
          nextAttemptAt: new Date(Date.now() + delay).toISOString(), lastError: failure }))
        return
      }
      // Retries are spent: the request itself becomes the thing an owner reads
      // and replays, keeping the body and the stdin the script would read.
      await table.delete(key)
      await this.recordFailedDeliveryLocked(live, {
        deliveryRef: record.deliveryRef,
        admissionRef: record.admissionRef,
        receivedRevision: record.receivedRevision,
        receivedAt: Date.parse(record.receivedAt),
        script: record.script,
        credentials: record.credentials,
        body: webhookStdin(record.headers, record.body),
        attempts,
        lastError: failure,
      })
      this.ctx.logger.warn(`agent-team: a webhook delivery for '${subscription.subscriptionRef}' spent its retries: ${failure}`)
    })
  }

  /** Take a delivery out of the queue: its output was accepted, so no work is owed. */
  private dropWebhookAdmission(record: SubscriptionAdmissionRecord): Promise<void> {
    return this.serializeSubscriptionWrite(record.subscriptionRef, async () => {
      await this.subscriptionAdmissionsTable?.delete(admissionKey(record.subscriptionRef, record.admissionRef))
    })
  }

  /**
   * The ingress seam: a delivery whose automatic retries are spent becomes a
   * record an owner can read and replay. `deliveryRef` is the ingress's own
   * stable id, so a repeated admission of the same delivery replaces its attempt
   * count and error instead of adding a second row — and counts nothing, because
   * the delivery already counted once when its retries ran out.
   */
  async recordFailedDelivery(subscription: AgentTeamSubscription, input: SubscriptionDeliveryInput): Promise<void> {
    await this.serializeSubscriptionWrite(subscription.subscriptionRef,
      () => this.recordFailedDeliveryLocked(subscription, input))
  }

  private async recordFailedDeliveryLocked(subscription: AgentTeamSubscription, input: SubscriptionDeliveryInput): Promise<void> {
    const table = this.subscriptionDeliveriesTable
    if (table === undefined) return
    // Nothing admits this write but its caller, so the terminal barrier is read
    // here: a delivery that arrives for a deleted subscription — or one whose
    // Project was archived — must not recreate the rows the deletion dropped.
    const live = this.writableSubscription(subscription.subscriptionRef)
    if (live === undefined) {
      this.ctx.logger.warn(`agent-team: a spent delivery for '${subscription.subscriptionRef}' arrived after the subscription stopped being live; it was dropped`)
      return
    }
    const key = deliveryKey(live.subscriptionRef, input.deliveryRef)
    const earlier = table.get(key)
    await table.put(key, deliveryRecordOf(live, input, earlier))
    await this.pruneDeliveries(live.subscriptionRef, Date.now())
    // One delivery is one failure however many times it was retried, and a
    // provider that redelivers the same request is still the same delivery.
    if (earlier === undefined && input.receivedRevision === live.revision) await this.countDeliveryFailure(live)
  }

  /**
   * Count the failure a spent delivery stands for, and pause the subscription at
   * the threshold. Its caller holds the subscription's write lock, so the count
   * it reads is the one the previous delivery committed.
   */
  private async countDeliveryFailure(subscription: AgentTeamSubscription): Promise<void> {
    const settled = await this.updateCheckpointLocked(subscription.subscriptionRef, checkpoint => Object.freeze({
      ...checkpoint, consecutiveFailures: checkpoint.consecutiveFailures + 1 }))
    if (settled === undefined) return
    if (settled.consecutiveFailures >= SUBSCRIPTION_FAILURES_BEFORE_PAUSE) await this.commitFailurePause(subscription)
  }

  /** Drop what expired, then what no longer fits: the newest ten deliveries are the ones kept. */
  private async pruneDeliveries(subscriptionRef: AgentTeamSubscriptionRef, now: number): Promise<void> {
    const table = this.subscriptionDeliveriesTable
    if (table === undefined) return
    const records = this.deliveryRecordsOf(subscriptionRef)
    const expired = records.filter(record => Date.parse(record.expiresAt) <= now)
    const evicted = evictedDeliveries(records.filter(record => !expired.includes(record)), SUBSCRIPTION_DELIVERY_LIMIT)
    for (const record of [...expired, ...evicted]) await table.delete(deliveryKey(record.subscriptionRef, record.deliveryRef))
    // A replay answer names a delivery and explains it; once the delivery is
    // gone the answer has nothing left to mean, so it goes with the row.
    const replays = this.subscriptionReplaysTable
    if (replays === undefined) return
    const alive = new Set(this.deliveryRecordsOf(subscriptionRef).map(record => record.deliveryRef))
    for (const key of replayKeysOf(replays.keys(), subscriptionRef)) {
      const record = replays.get(key)
      if (record !== undefined && alive.has(record.deliveryRef) && Date.parse(record.expiresAt) > now) continue
      await replays.delete(key)
    }
  }

  /** One delivery of one subscription, or `undefined` once its retention ran out. */
  private deliveryRecordOf(subscriptionRef: AgentTeamSubscriptionRef, deliveryRef: string): SubscriptionDeliveryRecord | undefined {
    const record = this.subscriptionDeliveriesTable?.get(deliveryKey(subscriptionRef, deliveryRef))
    return record === undefined || Date.parse(record.expiresAt) <= Date.now() ? undefined : record
  }

  /**
   * The deliveries whose replay already delivered, named by whichever record
   * survived it: the tombstone on the delivery, the answer the request wrote, or
   * — when both private writes were lost — the accept the ledger holds under
   * that request id. One reading, because the failure list and the "already
   * replayed" refusal must never disagree about the same delivery.
   *
   * An output the ledger accepted is durable whatever the private copies say, so
   * a request that is only `running` still counts once its accept exists. A run
   * that printed nothing new leaves no accept; a request whose answer and
   * tombstone both went missing is then indistinguishable from one that never
   * delivered, and it stays a failure to replay under a new id.
   */
  private replayedDeliveryRefs(subscriptionRef: AgentTeamSubscriptionRef,
    records: readonly SubscriptionDeliveryRecord[]): ReadonlySet<string> {
    const replayed = new Set(records.filter(record => record.replay?.succeeded === true).map(record => record.deliveryRef))
    const table = this.subscriptionReplaysTable
    if (table === undefined) return replayed
    const now = Date.now()
    for (const key of replayKeysOf(table.keys(), subscriptionRef)) {
      const answer = table.get(key)
      if (answer === undefined || Date.parse(answer.expiresAt) <= now) continue
      // A row written before intents existed carries no state and is an answer.
      const delivered = answer.state === 'running'
        ? this.acceptedRequestEvents(subscriptionRef, answer.requestId as AgentTeamRequestId) !== undefined
        : answer.succeeded === true
      if (delivered) replayed.add(answer.deliveryRef)
    }
    return replayed
  }

  /**
   * The events one request id already accepted into the ledger, if it did. Every
   * accept commits under a request id the caller can name again — a replay's own
   * calls, and a webhook attempt's own id — so this is where a caller recovers the
   * answer when its private copy could not be written: the output is already
   * durable, and running the script a second time would publish what the ledger
   * already holds.
   */
  private acceptedRequestEvents(subscriptionRef: AgentTeamSubscriptionRef, requestId: AgentTeamRequestId): number | undefined {
    const operation = this.ledger?.committedOperation(requestId)
    if (operation?.kind !== 'team/subscription-events-accepted') return undefined
    if (operation.data.subscriptionRef !== subscriptionRef) return undefined
    return operation.data.events.length
  }

  /** The answer one request already got, or `undefined` when it has asked for nothing yet. */
  private replayRecordOf(subscriptionRef: AgentTeamSubscriptionRef, requestId: string): SubscriptionReplayRecord | undefined {
    const record = this.subscriptionReplaysTable?.get(replayKey(subscriptionRef, requestId))
    return record === undefined || Date.parse(record.expiresAt) <= Date.now() ? undefined : record
  }

  /**
   * The definition a replay or a queued delivery runs. `current` is the definition
   * as it stands now, because replaying is how an owner confirms a fix; `received`
   * is the version the payload arrived under, because an automatic retry must run
   * the bytes it was queued against, not a script that changed under it.
   */
  private replaySource(subscription: AgentTeamSubscription,
    record: Pick<SubscriptionDeliveryRecord, 'receivedRevision' | 'script' | 'credentials'>,
    version: AgentTeamSubscriptionReplayVersion): AgentTeamSubscription {
    if (version === 'current') return subscription
    return Object.freeze({ ...subscription, revision: record.receivedRevision, script: record.script, credentials: record.credentials })
  }

  /**
   * The record a real run may start from, or the error that says why it may not.
   * Deleted and archived are terminal barriers, and a paused subscription runs
   * nothing — a replay is a run, so it needs a resume first.
   */
  private runTarget(subscriptionRef: AgentTeamSubscriptionRef, projectRef: AgentTeamProjectRef): AgentTeamSubscription {
    const ledger = this.requireLedger()
    const subscription = ledger.subscription(subscriptionRef)
    if (subscription === undefined || subscription.projectRef !== projectRef) {
      throw new Error(`subscription '${subscriptionRef}' does not belong to Project '${projectRef}'`)
    }
    if (subscription.state === 'deleted') throw new Error(`subscription '${subscriptionRef}' is deleted (subscription_deleted)`)
    if (subscription.state === 'paused') {
      throw new Error(`subscription '${subscriptionRef}' is paused, so it cannot run this delivery (subscription_paused)`)
    }
    if (ledger.getProject(projectRef)?.state !== 'active') {
      throw new Error(`the Project of subscription '${subscriptionRef}' is archived (project_archived)`)
    }
    return subscription
  }

  /** The answer a request already got, rebuilt from the private record so a retried call reads the same. */
  private replayResultOf(answered: SubscriptionReplayRecord): AgentTeamSubscriptionReplayResult {
    const delivery = this.deliveryRecordOf(answered.subscriptionRef, answered.deliveryRef)
    if (delivery === undefined) throw new Error(`delivery '${answered.deliveryRef}' is unknown or has expired`)
    return Object.freeze({ kind: answered.succeeded === true ? 'replayed' : 'replay-failed', delivery: deliveryEntryOf(delivery),
      eventCount: answered.eventCount ?? 0, ...(answered.runRef === undefined ? {} : { runRef: answered.runRef }),
      ...(answered.reason === undefined ? {} : { reason: answered.reason }) })
  }

  /**
   * Run one failed delivery again, now. A replay publishes what the script
   * prints exactly like a timer run, so the same commit decides its success: one
   * that delivers ends the streak — including one that printed nothing new —
   * while a replay whose script fails counts nothing, because the retry loop
   * already gave up on this delivery and an owner asking again is not the
   * subscription failing.
   *
   * It is a run, so it is admitted like one — the same four slots, the same
   * per-subscription exclusion, the same convergence when the Host stops — and
   * the rest happens inside that admission, where a second call for the same
   * request id cannot start beside it.
   */
  private async replaySubscriptionDelivery(actor: AgentTeamActor, request: AgentTeamSubscriptionReplayRequest): Promise<AgentTeamSubscriptionReplayResult> {
    this.requireAccepting()
    const ledger = this.requireLedger()
    // A replay runs a script against the Project's Workspace, so it is an owner
    // action like a trial, not something any reader may trigger.
    ledger.assertSubscriptionAuthority(actor, request.projectRef, request.workspaceId)
    const subscription = this.runTarget(request.subscriptionRef, request.projectRef)
    const version = request.version ?? 'current'
    const execute = (): Promise<AgentTeamSubscriptionReplayResult> => this.replayLocked(subscription, request, version)
    const scheduler = this.subscriptionScheduler
    return scheduler === undefined ? execute() : scheduler.runAdmitted(subscription, 'run', execute)
  }

  private async replayLocked(subscription: AgentTeamSubscription, request: AgentTeamSubscriptionReplayRequest,
    version: AgentTeamSubscriptionReplayVersion): Promise<AgentTeamSubscriptionReplayResult> {
    // Admission re-reads the ledger, but this reads it once more for the run
    // itself: the record to run against is the one that stands now, not the
    // snapshot the entry queued with.
    const live = this.runTarget(request.subscriptionRef, request.projectRef)
    const intent = this.replayRecordOf(live.subscriptionRef, request.requestId)
    if (intent !== undefined) {
      // One request id names one intent, and the record is written before the
      // script runs. Naming a different delivery or version under it is a
      // collision, not a second run — even when no answer survived to say so.
      if (intent.deliveryRef !== request.deliveryRef || intent.version !== version) {
        throw new Error(`request '${request.requestId}' already replayed delivery '${intent.deliveryRef}' (${intent.version}); one request id cannot name a second replay (replay_request_conflict)`)
      }
      if (intent.state === 'settled') return this.replayResultOf(intent)
      // The run may have started and never recorded its answer. An accept the
      // ledger holds under this request id is the answer that survived; without
      // one there is nothing to stand on, and running the script again would be
      // guessing at what the first attempt did.
      const accepted = this.acceptedRequestEvents(live.subscriptionRef, request.requestId)
      if (accepted === undefined) {
        const delivery = this.deliveryRecordOf(live.subscriptionRef, intent.deliveryRef)
        if (delivery === undefined) throw new Error(`delivery '${intent.deliveryRef}' is unknown or has expired`)
        return Object.freeze({ kind: 'replay-failed', delivery: deliveryEntryOf(delivery), eventCount: 0,
          reason: 'an earlier attempt for this request started and never recorded its answer, so it was not run again; replay the delivery under a new request id' })
      }
      const delivery = this.deliveryRecordOf(live.subscriptionRef, intent.deliveryRef)
      if (delivery === undefined) throw new Error(`delivery '${intent.deliveryRef}' is unknown or has expired`)
      // The output is in the ledger: settle the answer that was lost, then say
      // what the run did.
      await this.settleReplayIntent(delivery, Object.freeze({ ...intent, state: 'settled', succeeded: true,
        eventCount: accepted, ...(intent.runRef === undefined ? {} : { runRef: intent.runRef }) }))
      return Object.freeze({ kind: 'replayed', delivery: deliveryEntryOf(delivery), eventCount: accepted,
        ...(intent.runRef === undefined ? {} : { runRef: intent.runRef }) })
    }
    const record = this.deliveryRecordOf(live.subscriptionRef, request.deliveryRef)
    if (record === undefined) throw new Error(`delivery '${request.deliveryRef}' is unknown or has expired`)
    // A replay that delivered took the delivery off the failed list; a second,
    // different request must not run it again and publish the same output twice.
    // The tombstone is only one of the records that can say so: an answer or a
    // ledger accept under a request id that never got one counts the same, or a
    // lost tombstone would let the same delivery run once more.
    if (this.replayedDeliveryRefs(live.subscriptionRef, this.deliveryRecordsOf(live.subscriptionRef)).has(record.deliveryRef)) {
      throw new Error(`delivery '${request.deliveryRef}' was already replayed successfully (delivery_replayed)`)
    }
    // The intent goes down before the script does: from here a retry either
    // collides, reads the answer, or is told the attempt never finished. A call
    // that cannot record it does not run the script at all.
    await this.recordReplayIntent(live, record, request.requestId, version)
    const source = this.replaySource(live, record, version)
    const run = await this.runSubscriptionOnce(source, 'webhook',
      { stdin: record.body, delivery: { deliveryRef: record.deliveryRef, attempt: record.attempts }, requestId: request.requestId,
        ...(record.admissionRef === undefined ? {} : { scriptDeliveryId: record.admissionRef }) })
    if (run === undefined) {
      return Object.freeze({ kind: 'replay-failed', delivery: deliveryEntryOf(record), eventCount: 0,
        reason: 'the replay finished after the subscription stopped being live, so nothing was delivered' })
    }
    const succeeded = run.outcome === 'accepted' || run.outcome === 'empty'
    const reason = run.report.ok
      ? run.outcome === 'backlog'
        ? `the Project already holds ${SUBSCRIPTION_PENDING_MAX} unpublished events, so this output was refused`
        : run.outcome === 'deferred'
          ? `the Project has no room in its unpublished queue for this output yet (${SUBSCRIPTION_PENDING_MAX} at most), so it was not replayed`
          : undefined
      : run.report.reason
    const answer: SubscriptionReplayRecord = Object.freeze({
      subscriptionRef: source.subscriptionRef, projectRef: source.projectRef, requestId: request.requestId,
      deliveryRef: record.deliveryRef, version, state: 'settled', runRef: run.runRef, eventCount: run.eventCount, succeeded,
      ...(reason === undefined ? {} : { reason }), expiresAt: record.expiresAt,
    })
    const kept = await this.settleReplayIntent(record, answer)
    // The deletion owns the rows; the ledger still owns what happened. An output
    // the ledger accepted before the deletion *was* delivered, and answering
    // otherwise would contradict the ledger's own record of it. A run that
    // printed nothing new has no such record to stand on, so a deletion that
    // landed first leaves it with nothing to claim.
    if (!kept && run.outcome !== 'accepted') {
      return Object.freeze({ kind: 'replay-failed', delivery: deliveryEntryOf(record), eventCount: 0,
        reason: 'the replay finished after the subscription stopped being live, so nothing was delivered' })
    }
    return Object.freeze({ kind: succeeded ? 'replayed' : 'replay-failed', delivery: deliveryEntryOf(record), eventCount: run.eventCount,
      runRef: run.runRef, ...(reason === undefined ? {} : { reason }),
      ...(succeeded ? {} : { stdoutTail: failureTail(run.report.stdout), stderrTail: failureTail(run.report.stderr) }) })
  }

  /**
   * Record that this request is about to run — before it runs.
   *
   * It is the one write that makes a request id an intent rather than a hope:
   * once it lands, a retry cannot silently take a different delivery, cannot
   * read a competing version, and cannot mistake an unfinished attempt for a
   * fresh one. A call that cannot record it must not run the script, so this
   * rejects instead of logging, and the caller's retry starts from nothing.
   */
  private recordReplayIntent(subscription: AgentTeamSubscription, record: SubscriptionDeliveryRecord,
    requestId: AgentTeamRequestId, version: AgentTeamSubscriptionReplayVersion): Promise<void> {
    return this.serializeSubscriptionWrite(subscription.subscriptionRef, async () => {
      if (this.writableSubscription(subscription.subscriptionRef) === undefined) {
        throw new Error(`subscription '${subscription.subscriptionRef}' stopped being live, so this replay did not run (subscription_deleted)`)
      }
      const table = this.subscriptionReplaysTable
      if (table === undefined) throw new Error('the subscription store is not open, so this replay cannot be recorded and did not run')
      const intent: SubscriptionReplayRecord = Object.freeze({
        subscriptionRef: subscription.subscriptionRef, projectRef: subscription.projectRef, requestId,
        deliveryRef: record.deliveryRef, version, state: 'running', expiresAt: record.expiresAt,
      })
      await table.put(replayKey(subscription.subscriptionRef, requestId), intent)
    })
  }

  /**
   * Settle one replay's answer — the request record that holds it and the
   * delivery's own tombstone — behind one barrier read, under the
   * subscription's write lock.
   *
   * The lock is what orders this segment against a deletion. The cleanup takes
   * the same lock, so a delete either runs first — and this finds nothing
   * writable, writes nothing, and reports that it did not — or runs after, and
   * drops every row this wrote. A barrier read once and then followed by awaits
   * is a barrier a delete lands behind: that is exactly how a deleted
   * subscription got its delivery row back.
   *
   * The answer is written first, because it is the authority a retry reads; the
   * tombstone is the second guard, so losing it costs one duplicate check that
   * the deduplication waterline covers anyway. A storage fault in either is
   * logged: by now the output is in the ledger, so a private copy that fails
   * cannot turn a delivered replay into an ungraspable answer.
   */
  private settleReplayIntent(record: SubscriptionDeliveryRecord, answer: SubscriptionReplayRecord): Promise<boolean> {
    return this.serializeSubscriptionWrite(answer.subscriptionRef, async () => {
      if (this.writableSubscription(answer.subscriptionRef) === undefined) return false
      const write = async (label: string, task: () => Promise<unknown>): Promise<void> => {
        try {
          await task()
        } catch (error) {
          this.ctx.logger.warn(`agent-team: could not record the ${label} of a replay of '${answer.subscriptionRef}': ${failureDetail(error)}`)
        }
      }
      await write('request answer', () => this.subscriptionReplaysTable === undefined ? Promise.resolve()
        : this.subscriptionReplaysTable.put(replayKey(answer.subscriptionRef, answer.requestId), answer))
      const table = this.subscriptionDeliveriesTable
      // Merge into the row as it stands: the ingress may have replaced the
      // attempt count and error while this replay ran, and those are newer.
      const current = table?.get(deliveryKey(record.subscriptionRef, record.deliveryRef)) ?? record
      await write('delivery answer', () => table === undefined ? Promise.resolve() : table.put(
        deliveryKey(current.subscriptionRef, current.deliveryRef), Object.freeze({ ...current,
          replay: Object.freeze({ requestId: answer.requestId, succeeded: answer.succeeded === true,
            ...(answer.runRef === undefined ? {} : { runRef: answer.runRef }),
            ...(answer.reason === undefined ? {} : { reason: answer.reason }) }) })))
      return true
    })
  }

  /** An Agent owner replays one failed delivery; the request id makes a retried call a no-op. */
  replaySubscriptionDeliveryForAgent(agent: Agent, request: AgentTeamSubscriptionReplayRequest): Promise<AgentTeamSubscriptionReplayResult> {
    return this.replaySubscriptionDelivery(this.memberCall(agent, request.workspaceId), request)
  }

  @Remote('replaySubscriptionDelivery')
  replaySubscriptionDeliveryForClient(request: AgentTeamSubscriptionReplayRequest): Promise<AgentTeamSubscriptionReplayResult> {
    return this.replaySubscriptionDelivery(this.humanCall(request.workspaceId), request)
  }

  /**
   * Read the script a create or update names. A path is resolved against the
   * calling Agent's own working directory, the one its bash tool uses; a Human
   * page has no such directory and must paste the content.
   */
  private async snapshotSubscriptionScript(source: AgentTeamSubscriptionScriptSource, agent: Agent | undefined): Promise<SubscriptionScriptSnapshot> {
    const content = 'scriptContent' in source ? source.scriptContent : await this.readAgentScript(source.scriptPath, agent)
    const probe = await this.mountedShellProbe()
    if (probe.family === undefined) {
      // The refusal has to name why: the executor is usually mounted.
      throw new Error(`the Host's shell executor could not answer a probe, so a script cannot be snapshotted: ${probe.failure ?? 'no reason was recorded'}`)
    }
    const snapshot = snapshotScript(content, probe.family)
    if (!snapshot.ok) throw new Error(`this script cannot be stored: ${snapshot.reason}`)
    return snapshot.script
  }

  private async readAgentScript(scriptPath: string, agent: Agent | undefined): Promise<string> {
    if (agent === undefined) throw new Error('a script path needs an Agent working directory; paste the script content instead')
    const workingDirectory = agent.ctx.get('workingDirectory') as { get(session: Agent['session']): string } | undefined
    const cwd = workingDirectory?.get(agent.session)
    if (cwd === undefined) throw new Error('this Session has no working directory, so a script path cannot be resolved')
    const resolved = isAbsolute(scriptPath) ? scriptPath : join(cwd, scriptPath)
    const bytes = await readFile(resolved).catch((error: unknown) => {
      throw new Error(`cannot read '${scriptPath}': ${error instanceof Error ? error.message : String(error)}`)
    })
    if (bytes.byteLength > SUBSCRIPTION_SCRIPT_MAX_BYTES) {
      throw new Error(`'${scriptPath}' is ${bytes.byteLength} bytes; the limit is ${SUBSCRIPTION_SCRIPT_MAX_BYTES}`)
    }
    return bytes.toString('utf8')
  }

  private missingCredentialMessage(missing: readonly string[]): string {
    return `the Host has no configured credential for ${missing.map(ref => `'${ref}'`).join(', ')}`
  }

  private trialFailureOf(report: SubscriptionRunReport): AgentTeamSubscriptionTrialFailure {
    return Object.freeze({ reason: report.reason ?? 'the trial run failed', stdoutTail: failureTail(report.stdout), stderrTail: failureTail(report.stderr) })
  }

  /**
   * A trial runs under the same execution path as a live run, so validation
   * cannot pass a script production would refuse — and through the same
   * admission, so five creates in parallel still run four scripts at most.
   *
   * `record` is false for a create draft's trial: there is no stored definition
   * for that run to describe, and its throwaway ref would leave a run record
   * nobody can ever read or retire. An edit draft does name a stored
   * subscription, so its trial is recorded like any other test run.
   */
  private trialSubscriptionRun(subscription: AgentTeamSubscription, record = true): Promise<SubscriptionRunReport> {
    const execute = async (): Promise<SubscriptionRunReport> => {
      const startedAt = Date.now()
      const report = await this.executeSubscriptionRun(subscription, 'test')
      // A trial writes no checkpoint: it neither counts towards the failure
      // pause nor clears it, and passing never moves the success waterline. It
      // is recorded, because an owner asking "did my fix pass?" reads the same
      // history as the runs — and it counts no events, because it publishes none.
      if (record) {
        await this.recordSubscriptionRun(runRecordOf({ subscription, trigger: 'test', startedAt, durationMs: Date.now() - startedAt,
          category: report.ok ? 'verified' : failureCategory(report), eventCount: 0, report }))
      }
      return report
    }
    const scheduler = this.subscriptionScheduler
    return scheduler === undefined ? execute() : scheduler.runTrial(subscription, execute)
  }

  /** The subscription-shaped draft a create trial runs as: it is never stored. */
  private draftSubscription(actor: AgentTeamActor, definition: {
    readonly projectRef: AgentTeamProjectRef
    readonly name: string
    readonly triggers: SubscriptionTriggers
    readonly script: SubscriptionScriptSnapshot
    readonly credentials: readonly SubscriptionCredential[]
    readonly notify?: readonly AgentTeamMemberId[] | undefined
  }): AgentTeamSubscription {
    const createdBy = actor.kind === 'host' ? AGENT_TEAM_HUMAN_MEMBER_ID : actor.memberId
    return Object.freeze({
      subscriptionRef: `subscription:trial-${randomUUID()}` as AgentTeamSubscriptionRef,
      projectRef: definition.projectRef, name: definition.name, triggers: definition.triggers, script: definition.script,
      credentials: definition.credentials, revision: 1, state: 'active',
      createdBy, notify: Object.freeze([...(definition.notify ?? [createdBy])].sort()),
      createdAt: new Date().toISOString(),
    })
  }

  /**
   * The triggers a create or edit asks for. A timer is named by its interval; an
   * address is not, so only an explicit `false` drops one a provider already posts to.
   */
  private subscriptionTriggersOf(request: { readonly intervalMinutes?: number | undefined; readonly webhook?: boolean | undefined },
    prior?: SubscriptionTriggers): SubscriptionTriggers {
    const webhook = request.webhook ?? prior?.webhook
    return Object.freeze({
      ...(request.intervalMinutes === undefined ? {} : { interval: Object.freeze({ minutes: request.intervalMinutes }) }),
      ...(webhook === true ? { webhook: true } : {}),
    })
  }

  /**
   * The origin hook addresses hang from, or a refusal naming the setting to
   * write. Arming an address nobody can reach would answer the caller with a
   * URL that cannot work, so the write stops here instead.
   */
  private webhookOrigin(): string {
    const origin = this.config.webhook.get().publicOrigin
    const refusal = webhookOriginRefusal(origin)
    if (refusal !== undefined) throw new Error(refusal)
    return origin
  }

  /** The one answer an arming write gives: the complete address, once, or nothing when it armed none. */
  private armedAddress(origin: string, token: string | undefined): { readonly webhookAddress?: string } {
    return token === undefined ? {} : { webhookAddress: webhookAddress(origin, token) }
  }

  /** A retry's answer for a write that already committed: the subscription stands, and an address it armed once is not handed out again. */
  private replayedSubscriptionWrite(result: AgentTeamSubscriptionChangeResult, addressArmed: boolean): AgentTeamSubscriptionWriteResult {
    return Object.freeze({ kind: 'changed', subscription: result.subscription, activity: result.activity,
      ...(addressArmed && result.subscription.triggers.webhook === true ? { webhookAddressGone: true as const } : {}) })
  }

  private async createSubscriptionAs(actor: AgentTeamActor, request: AgentTeamCreateSubscriptionRequest, agent: Agent | undefined): Promise<AgentTeamSubscriptionWriteResult> {
    this.requireAccepting()
    const ledger = this.requireLedger()
    ledger.assertSubscriptionAuthority(actor, request.projectRef, request.workspaceId)
    const requestIntent: AgentTeamCreateSubscriptionRequestIntent = Object.freeze({
      ...(request.intervalMinutes === undefined ? {} : { intervalMinutes: request.intervalMinutes }),
      ...(request.webhook === undefined ? {} : { webhook: request.webhook }),
      scriptSource: 'scriptPath' in request.script
        ? Object.freeze({ kind: 'path' as const, path: request.script.scriptPath })
        : Object.freeze({ kind: 'content' as const }),
      baseline: request.baseline ?? 'current-output',
    })
    const replayed = ledger.subscriptionWriteReplay({ kind: 'create', requestId: request.requestId, workspaceId: request.workspaceId,
      projectRef: request.projectRef, actor, name: request.name, intervalMinutes: request.intervalMinutes, webhook: request.webhook,
      script: request.script, credentials: request.credentials, notify: request.notify, baseline: requestIntent.baseline })
    if (replayed !== undefined) return this.replayedSubscriptionWrite(replayed.value, replayed.addressArmed)
    const script = await this.snapshotSubscriptionScript(request.script, agent)
    const triggers = this.subscriptionTriggersOf(request)
    const credentials = Object.freeze([...(request.credentials ?? [])])
    const name = request.name.trim()
    const problem = subscriptionDefinitionProblem({ name, triggers, script, credentials })
    if (problem !== undefined) throw new Error(`this subscription cannot be created: ${problem}`)
    const notifyProblem = ledger.subscriptionNotifyProblem(request.projectRef, request.notify)
    if (notifyProblem !== undefined) throw new Error(`this subscription cannot be created: ${notifyProblem}`)
    const missing = await missingCredentials(this.credentialProvider(), credentials)
    if (missing.length > 0) throw new Error(this.missingCredentialMessage(missing))
    const origin = triggers.webhook === true ? this.webhookOrigin() : undefined
    const trial = await this.trialSubscriptionRun(this.draftSubscription(actor, { projectRef: request.projectRef, name, triggers, script, credentials, notify: request.notify }))
    if (!trial.ok) return Object.freeze({ kind: 'trial-failed', failure: this.trialFailureOf(trial) })
    const baselineIds = (request.baseline ?? 'current-output') === 'current-output' ? baselineIdsOf(trial.events) : []
    const result = await ledger.createSubscription({
      requestId: request.requestId, workspaceId: request.workspaceId, projectRef: request.projectRef, name, triggers, script,
      credentials, notify: request.notify, baselineIds, actor,
    }, requestIntent)
    if (result.committed) this.emitCommitted(result.value.receipt)
    return Object.freeze({ kind: 'changed', subscription: result.value.subscription, activity: result.value.activity,
      ...(origin === undefined ? {} : this.armedAddress(origin, result.value.webhookToken)) })
  }

  async createSubscriptionForAgent(agent: Agent, request: AgentTeamCreateSubscriptionRequest): Promise<AgentTeamSubscriptionWriteResult> {
    return this.createSubscriptionAs(this.memberCall(agent, request.workspaceId), request, agent)
  }

  /** Human creation from a page: the content is pasted, because a Human has no Session working directory. */
  @Remote('createSubscription')
  async createSubscription(request: AgentTeamCreateSubscriptionRequest): Promise<AgentTeamSubscriptionWriteResult> {
    return this.createSubscriptionAs(this.humanCall(request.workspaceId), request, undefined)
  }

  private async updateSubscriptionAs(actor: AgentTeamActor, request: AgentTeamUpdateSubscriptionRequest, agent: Agent | undefined): Promise<AgentTeamSubscriptionWriteResult> {
    this.requireAccepting()
    const ledger = this.requireLedger()
    ledger.assertSubscriptionAuthority(actor, request.projectRef, request.workspaceId)
    const requestIntent: AgentTeamSubscriptionRequestIntent = Object.freeze({
      ...(request.intervalMinutes === undefined ? {} : { intervalMinutes: request.intervalMinutes }),
      ...(request.webhook === undefined ? {} : { webhook: request.webhook }),
      scriptSource: 'scriptPath' in request.script
        ? Object.freeze({ kind: 'path' as const, path: request.script.scriptPath })
        : Object.freeze({ kind: 'content' as const }),
    })
    const replayed = ledger.subscriptionWriteReplay({ kind: 'update', requestId: request.requestId, workspaceId: request.workspaceId,
      projectRef: request.projectRef, subscriptionRef: request.subscriptionRef, expectedRevision: request.expectedRevision,
      actor, name: request.name, intervalMinutes: request.intervalMinutes, webhook: request.webhook,
      script: request.script, credentials: request.credentials, notify: request.notify })
    if (replayed !== undefined) return this.replayedSubscriptionWrite(replayed.value, replayed.addressArmed)
    const prior = ledger.subscription(request.subscriptionRef)
    if (prior === undefined || prior.projectRef !== request.projectRef) {
      throw new Error(`subscription '${request.subscriptionRef}' does not belong to Project '${request.projectRef}'`)
    }
    if (prior.state === 'deleted') throw new Error(`subscription '${request.subscriptionRef}' is deleted (subscription_deleted)`)
    const script = await this.snapshotSubscriptionScript(request.script, agent)
    const triggers = this.subscriptionTriggersOf(request, prior.triggers)
    const credentials = Object.freeze([...(request.credentials ?? [])])
    const name = request.name.trim()
    const problem = subscriptionDefinitionProblem({ name, triggers, script, credentials })
    if (problem !== undefined) throw new Error(`this subscription cannot be updated: ${problem}`)
    const notifyProblem = ledger.subscriptionNotifyProblem(request.projectRef, request.notify)
    if (notifyProblem !== undefined) throw new Error(`this subscription cannot be updated: ${notifyProblem}`)
    const missing = await missingCredentials(this.credentialProvider(), credentials)
    if (missing.length > 0) throw new Error(this.missingCredentialMessage(missing))
    // An edit that keeps the address needs no origin check here: the address it
    // already has stays valid, and only arming a new one depends on the setting.
    const origin = triggers.webhook === true && prior.webhook === undefined ? this.webhookOrigin() : undefined
    // The trial keeps the existing waterline: an id that appeared between two
    // polls must not be swallowed by an edit.
    const trial = await this.trialSubscriptionRun(Object.freeze({ ...prior, name, triggers, script, credentials }))
    if (!trial.ok) return Object.freeze({ kind: 'trial-failed', failure: this.trialFailureOf(trial) })
    const result = await ledger.updateSubscription({
      requestId: request.requestId, workspaceId: request.workspaceId, projectRef: request.projectRef, subscriptionRef: request.subscriptionRef,
      expectedRevision: request.expectedRevision, name, triggers, script, credentials, notify: request.notify, actor,
    }, requestIntent)
    if (result.committed) this.emitCommitted(result.value.receipt)
    return Object.freeze({ kind: 'changed', subscription: result.value.subscription, activity: result.value.activity,
      ...(origin === undefined ? {} : this.armedAddress(origin, result.value.webhookToken)) })
  }

  async updateSubscriptionForAgent(agent: Agent, request: AgentTeamUpdateSubscriptionRequest): Promise<AgentTeamSubscriptionWriteResult> {
    return this.updateSubscriptionAs(this.memberCall(agent, request.workspaceId), request, agent)
  }

  @Remote('updateSubscription')
  async updateSubscription(request: AgentTeamUpdateSubscriptionRequest): Promise<AgentTeamSubscriptionWriteResult> {
    return this.updateSubscriptionAs(this.humanCall(request.workspaceId), request, undefined)
  }

  private async testSubscription(request: AgentTeamTestSubscriptionRequest, actor: AgentTeamActor): Promise<AgentTeamSubscriptionTrialResult> {
    this.requireAccepting()
    const ledger = this.requireLedger()
    ledger.assertSubscriptionAuthority(actor, request.projectRef, request.workspaceId)
    const subscription = ledger.subscription(request.subscriptionRef)
    if (subscription === undefined || subscription.projectRef !== request.projectRef) {
      throw new Error(`subscription '${request.subscriptionRef}' does not belong to Project '${request.projectRef}'`)
    }
    if (subscription.state === 'deleted') throw new Error(`subscription '${request.subscriptionRef}' is deleted (subscription_deleted)`)
    const trial = await this.trialSubscriptionRun(subscription)
    return trial.ok
      ? Object.freeze({ kind: 'tested', events: trial.events, stdoutTail: failureTail(trial.stdout), stderrTail: failureTail(trial.stderr) })
      : Object.freeze({ kind: 'trial-failed', failure: this.trialFailureOf(trial) })
  }

  async testSubscriptionForAgent(agent: Agent, request: AgentTeamTestSubscriptionRequest): Promise<AgentTeamSubscriptionTrialResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    return this.testSubscription(request, actor)
  }

  /** A trial run never changes durable state, so the Human path can offer it before any edit. */
  @Remote('testSubscription')
  async testSubscriptionForClient(request: AgentTeamTestSubscriptionRequest): Promise<AgentTeamSubscriptionTrialResult> {
    return this.testSubscription(request, this.humanCall(request.workspaceId))
  }

  /**
   * A page's trial of the definition its form holds. No Team fact is written:
   * the script runs through the same validation and executor as a save, and the
   * answer names the snapshot and revision the Client may bind Save to. An edit
   * draft does leave one private test run, like any other trial of a stored
   * subscription; a create draft leaves nothing, because its throwaway ref would
   * belong to no stored definition. Save still re-runs the trial in create/
   * update, so a cached pass is never trusted.
   */
  @Remote('testSubscriptionDraft')
  async testSubscriptionDraft(request: AgentTeamSubscriptionDraftTrialRequest): Promise<AgentTeamSubscriptionDraftTrialResult> {
    this.requireAccepting()
    const actor = this.humanCall(request.workspaceId)
    const ledger = this.requireLedger()
    ledger.assertSubscriptionAuthority(actor, request.projectRef, request.workspaceId)
    const prior = request.subscriptionRef === undefined ? undefined : ledger.subscription(request.subscriptionRef)
    if (request.subscriptionRef !== undefined) {
      if (prior === undefined || prior.projectRef !== request.projectRef) {
        throw new Error(`subscription '${request.subscriptionRef}' does not belong to Project '${request.projectRef}'`)
      }
      if (prior.state === 'deleted') throw new Error(`subscription '${request.subscriptionRef}' is deleted (subscription_deleted)`)
      if (request.expectedRevision === undefined) {
        throw new Error(`a draft trial of '${prior.subscriptionRef}' needs the revision the form started from`)
      }
      if (request.expectedRevision !== prior.revision) {
        throw new Error(`subscription '${prior.subscriptionRef}' is at revision ${prior.revision}, not ${request.expectedRevision} (stale_revision)`)
      }
    } else if (request.expectedRevision !== undefined) {
      throw new Error('a draft trial without a subscription cannot name a revision')
    }
    const script = await this.snapshotSubscriptionScript({ scriptContent: request.scriptContent }, undefined)
    const triggers = this.subscriptionTriggersOf(request)
    // Arming is refused before the script runs when the Host has no address to
    // arm, so the form hears the same reason a save would give it — once.
    if (triggers.webhook === true) this.webhookOrigin()
    const credentials = Object.freeze([...(request.credentials ?? [])])
    const name = request.name.trim()
    const problem = subscriptionDefinitionProblem({ name, triggers, script, credentials })
    if (problem !== undefined) throw new Error(`this subscription cannot be saved: ${problem}`)
    const missing = await missingCredentials(this.credentialProvider(), credentials)
    if (missing.length > 0) throw new Error(this.missingCredentialMessage(missing))
    // An edit keeps the stored definition as the base, so the trial sees the
    // baseline and revision the save would keep; a create draft has neither.
    const draft = prior === undefined
      ? this.draftSubscription(actor, { projectRef: request.projectRef, name, triggers, script, credentials })
      : Object.freeze({ ...prior, name, triggers, script, credentials })
    const trial = await this.trialSubscriptionRun(draft, prior !== undefined)
    const outcome: AgentTeamSubscriptionTrialResult = trial.ok
      ? Object.freeze({ kind: 'tested', events: trial.events, stdoutTail: failureTail(trial.stdout), stderrTail: failureTail(trial.stderr) })
      : Object.freeze({ kind: 'trial-failed', failure: this.trialFailureOf(trial) })
    return Object.freeze({ ...outcome, scriptHash: script.sha256, revision: draft.revision })
  }

  async pauseSubscriptionForAgent(agent: Agent, request: AgentTeamSubscriptionStateRequest): Promise<AgentTeamSubscriptionWriteResult> {
    return this.changeSubscriptionStateAs(this.memberCall(agent, request.workspaceId), request, 'paused')
  }

  @Remote('pauseSubscription')
  async pauseSubscription(request: AgentTeamSubscriptionStateRequest): Promise<AgentTeamSubscriptionWriteResult> {
    return this.changeSubscriptionStateAs(this.humanCall(request.workspaceId), request, 'paused')
  }

  async resumeSubscriptionForAgent(agent: Agent, request: AgentTeamSubscriptionStateRequest): Promise<AgentTeamSubscriptionWriteResult> {
    return this.resumeSubscriptionAs(this.memberCall(agent, request.workspaceId), request)
  }

  @Remote('resumeSubscription')
  async resumeSubscription(request: AgentTeamSubscriptionStateRequest): Promise<AgentTeamSubscriptionWriteResult> {
    return this.resumeSubscriptionAs(this.humanCall(request.workspaceId), request)
  }

  async resetSubscriptionWebhookForAgent(agent: Agent, request: AgentTeamSubscriptionStateRequest): Promise<AgentTeamSubscriptionWriteResult> {
    return this.resetSubscriptionWebhookAs(this.memberCall(agent, request.workspaceId), request)
  }

  @Remote('resetSubscriptionWebhook')
  async resetSubscriptionWebhook(request: AgentTeamSubscriptionStateRequest): Promise<AgentTeamSubscriptionWriteResult> {
    return this.resetSubscriptionWebhookAs(this.humanCall(request.workspaceId), request)
  }

  /**
   * Replace the address an outside service posts to. The revision does not
   * move: deliveries already accepted keep the version they arrived under, and
   * only the old address stops resolving.
   *
   * It takes the write lock the entry re-reads the token under, so a request carrying
   * the old address is queued before the reset or answered 404, never after it.
   */
  private async resetSubscriptionWebhookAs(actor: AgentTeamActor, request: AgentTeamSubscriptionStateRequest): Promise<AgentTeamSubscriptionWriteResult> {
    this.requireAccepting()
    const ledger = this.requireLedger()
    ledger.assertSubscriptionAuthority(actor, request.projectRef, request.workspaceId)
    // The retry of a reset answers from the ledger: the new address armed once
    // is not re-fetched, and the result says so instead of staying silent.
    const replayed = ledger.subscriptionWriteReplay({ ...request, actor })
    if (replayed !== undefined) return this.replayedSubscriptionWrite(replayed.value, replayed.addressArmed)
    const origin = this.webhookOrigin()
    const result = await this.serializeSubscriptionWrite(request.subscriptionRef,
      () => ledger.resetSubscriptionWebhook({ ...request, actor }))
    if (result.committed) this.emitCommitted(result.value.receipt)
    return Object.freeze({ kind: 'changed', subscription: result.value.subscription, activity: result.value.activity,
      ...this.armedAddress(origin, result.value.webhookToken) })
  }

  async deleteSubscriptionForAgent(agent: Agent, request: AgentTeamSubscriptionStateRequest): Promise<AgentTeamSubscriptionWriteResult> {
    return this.changeSubscriptionStateAs(this.memberCall(agent, request.workspaceId), request, 'deleted')
  }

  @Remote('deleteSubscription')
  async deleteSubscription(request: AgentTeamSubscriptionStateRequest): Promise<AgentTeamSubscriptionWriteResult> {
    return this.changeSubscriptionStateAs(this.humanCall(request.workspaceId), request, 'deleted')
  }

  private async changeSubscriptionStateAs(actor: AgentTeamActor, request: AgentTeamSubscriptionStateRequest,
    state: 'paused' | 'deleted'): Promise<AgentTeamSubscriptionWriteResult> {
    this.requireAccepting()
    const ledger = this.requireLedger()
    ledger.assertSubscriptionAuthority(actor, request.projectRef, request.workspaceId)
    const result = state === 'paused'
      ? await ledger.pauseSubscription({ ...request, actor, reason: 'manual' })
      : await ledger.deleteSubscription({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    // Awaited: the caller that is told the subscription is deleted must not see
    // its records come back a moment later. A row that will not delete is logged
    // here and converged at the next boot.
    if (state === 'deleted') await this.forgetSubscriptionPrivateState(request.subscriptionRef)
    return Object.freeze({ kind: 'changed', subscription: result.value.subscription, activity: result.value.activity })
  }

  /** Resume is a trial run first: a subscription that cannot run must not come back to life. */
  private async resumeSubscriptionAs(actor: AgentTeamActor, request: AgentTeamSubscriptionStateRequest): Promise<AgentTeamSubscriptionWriteResult> {
    this.requireAccepting()
    const ledger = this.requireLedger()
    ledger.assertSubscriptionAuthority(actor, request.projectRef, request.workspaceId)
    const subscription = ledger.subscription(request.subscriptionRef)
    if (subscription === undefined || subscription.projectRef !== request.projectRef) {
      throw new Error(`subscription '${request.subscriptionRef}' does not belong to Project '${request.projectRef}'`)
    }
    if (subscription.state === 'deleted') throw new Error(`subscription '${request.subscriptionRef}' is deleted (subscription_deleted)`)
    // The retry of a resume answers from the ledger, so the script runs once.
    const replayed = ledger.subscriptionWriteReplay({ ...request, actor })
    if (replayed !== undefined) return this.replayedSubscriptionWrite(replayed.value, replayed.addressArmed)
    const trial = await this.trialSubscriptionRun(subscription)
    if (!trial.ok) return Object.freeze({ kind: 'trial-failed', failure: this.trialFailureOf(trial) })
    const result = await ledger.resumeSubscription({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    // Only a committed resume clears the count: a failed trial left it alone.
    await this.updateCheckpoint(request.subscriptionRef, checkpoint => Object.freeze({ ...checkpoint, consecutiveFailures: 0 }))
    return Object.freeze({ kind: 'changed', subscription: result.value.subscription, activity: result.value.activity })
  }

  async baselineSubscriptionForAgent(agent: Agent, request: AgentTeamBaselineSubscriptionRequest): Promise<AgentTeamSubscriptionBaselineResult> {
    return this.baselineSubscriptionAs(this.memberCall(agent, request.workspaceId), request)
  }

  @Remote('baselineSubscription')
  async baselineSubscription(request: AgentTeamBaselineSubscriptionRequest): Promise<AgentTeamSubscriptionBaselineResult> {
    return this.baselineSubscriptionAs(this.humanCall(request.workspaceId), request)
  }

  private async baselineSubscriptionAs(actor: AgentTeamActor, request: AgentTeamBaselineSubscriptionRequest): Promise<AgentTeamSubscriptionBaselineResult> {
    this.requireAccepting()
    const ledger = this.requireLedger()
    ledger.assertSubscriptionAuthority(actor, request.projectRef, request.workspaceId)
    const result = await ledger.baselineSubscription({ requestId: request.requestId, workspaceId: request.workspaceId,
      projectRef: request.projectRef, subscriptionRef: request.subscriptionRef, ids: request.ids, actor })
    if (result.committed) this.emitCommitted(result.value)
    const subscription = ledger.subscription(request.subscriptionRef)
    if (subscription === undefined) throw new Error(`subscription '${request.subscriptionRef}' is gone`)
    return Object.freeze({ kind: 'baselined', subscription, added: Object.freeze([...request.ids]) })
  }

  /**
   * Record that these Member reminders reached a turn, one operation per
   * reminder. The write is the Host's own, so a failure degrades to a retry
   * rather than a log line: the occurrence is still owed, and a coverage that
   * still names it would keep the same durable facts from ever being delivered
   * again.
   */
  private consumeMemberReminders(carried: { readonly memberId: AgentTeamMemberId; readonly reminders: readonly InboxMemberReminder[] }): void {
    if (!this.accepting || this.ledger === undefined || carried.reminders.length === 0) return
    void this.requireLedger().consumeMemberReminders(carried.memberId, carried.reminders).then(receipts => {
      this.memberReminderConsumeFailures.delete(carried.memberId)
      for (const receipt of receipts) this.emitCommitted(receipt)
    }).catch(error => {
      this.retryMemberReminderConsumption(carried, error)
    })
  }

  /**
   * A consumption write that failed leaves the occurrence unread, so the coverage
   * the notice earned for it falls with it — otherwise the next redelivery sees
   * the same durable facts as already answered and stays silent. The retry is
   * active: the live Session is rederived now instead of waiting for an unrelated
   * Team fact or a restart. It is bounded, because every retry spends one of the
   * Member's turns and a persistent outage must not spend them forever; standing
   * down still leaves the occurrence owed and the coverage dropped.
   */
  private retryMemberReminderConsumption(carried: { readonly memberId: AgentTeamMemberId; readonly reminders: readonly InboxMemberReminder[] }, error: unknown): void {
    const failures = (this.memberReminderConsumeFailures.get(carried.memberId) ?? 0) + 1
    this.memberReminderConsumeFailures.set(carried.memberId, failures)
    this.dropInboxCoverage(carried.memberId)
    const scope = this.memberScope(carried.memberId)
    const detail = failureDetail(error)
    if (failures > MAX_MEMBER_REMINDER_CONSUME_RETRIES) {
      this.ctx.logger.warn(`agent-team: could not record Member reminder consumption for ${scope} after ${failures} consecutive failure(s): ${detail}; the occurrence stays unread and is delivered by the next Team fact touching this Member`)
      return
    }
    this.ctx.logger.warn(`agent-team: could not record Member reminder consumption for ${scope} on attempt ${failures} of at most ${MAX_MEMBER_REMINDER_CONSUME_RETRIES}: ${detail}; the coverage is dropped and the notice is rederived`)
    // A Member without a live Session, or one mid-swap, is rederived by its own
    // activation; the dropped coverage is what keeps the occurrence owed until then.
    const handle = this.accepting ? this.handles.get(carried.memberId) : undefined
    if (handle === undefined) {
      this.ctx.logger.debug(`agent-team: Member reminder consumption retry for ${scope} has no live session to rederive: the occurrence stays unread until the next Team fact or activation`)
      return
    }
    this.notifyMember(handle.agent, { kind: 'consumption-retry' })
  }

  /**
   * Member reminders are time promises in the ledger, so the Host only decides
   * when to look: on any commit that could have changed them, on boot, and on a
   * timer armed to the next occurrence. Evaluation never waits for a turn.
   */
  private scheduleMemberReminderEvaluation(): void {
    if (!this.accepting || this.ledger === undefined) return
    this.reminderEvaluationRequested = true
    void this.evaluateMemberReminders()
  }

  private evaluateMemberReminders(): Promise<void> {
    this.reminderEvaluationTail = this.reminderEvaluationTail.then(async () => {
      if (this.ledger === undefined) return
      do {
        this.reminderEvaluationRequested = false
        const nowMs = Date.now()
        for (const candidate of this.requireLedger().planMemberReminders(nowMs)) {
          const receipt = await this.requireLedger().raiseMemberReminder(candidate)
          // A baseline that moved while the write waited raises nothing; the
          // rearmed timer brings the same occurrence back.
          if (receipt !== undefined) this.emitCommitted(receipt)
        }
        this.armMemberReminderTimer(nowMs)
      } while (this.reminderEvaluationRequested)
    }).catch(error => {
      this.ctx.logger.warn(`agent-team: Member reminder evaluation failed: ${failureDetail(error)}`)
    })
    return this.reminderEvaluationTail
  }

  /** Arm one timer for the soonest pending occurrence; nothing pending disarms it. */
  private armMemberReminderTimer(nowMs: number): void {
    if (this.memberReminderTimer !== undefined) clearTimeout(this.memberReminderTimer)
    this.memberReminderTimer = undefined
    if (!this.accepting || this.ledger === undefined) return
    const at = this.requireLedger().nextMemberReminderWakeAt(nowMs)
    if (at === undefined) return
    const delay = Math.min(Math.max(0, at - Date.now()), MEMBER_REMINDER_TIMER_MAX_DELAY_MS)
    this.memberReminderTimer = setTimeout(() => {
      this.memberReminderTimer = undefined
      this.scheduleMemberReminderEvaluation()
    }, delay)
    this.memberReminderTimer.unref?.()
  }

  private requireLedger(): AgentTeamLedger {
    if (this.ledger === undefined || this.domain === undefined) throw new Error('agent-team service is not initialized')
    return this.ledger
  }

  private requireAccepting(): void {
    if (!this.accepting) throw new Error('agent-team service is shutting down')
  }

  private emitCommitted(receipt: AgentTeamOperationReceipt): void {
    // Nothing after the ledger append may turn a committed operation into a failed Remote call; effects that run third-party code go through `afterCommit`.
    // Order: listeners, Client invalidation, participation notice, wakes.
    this.afterCommit('commit listener dispatch', () => this.ctx.emit('agent-team/committed', { receipt }))
    const operation = this.ledger?.getOperation(receipt.operationId)
    if (operation === undefined) {
      this.afterCommit('change invalidation', () => this.emitChanged())
      return
    }
    const ledger = this.requireLedger()
    this.afterCommit('change invalidation', () => this.emitChanged(ledger.changeScopesOf(operation)))
    if (operation.kind !== 'team/reminder-raised') this.scheduleTaskReminderEvaluation()
    // Member lifecycle decides which reminders still time (suspended keeps
    // timing, archived and inactive cancel), and the reminder kinds move them.
    if (operation.kind.startsWith('team/member-')) this.scheduleMemberReminderEvaluation()
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
    const affectedMembers = ledger.affectedMembersOf(operation)
    const deferNotifications = affectedMembers.length >= NOTIFICATION_QUEUE_THRESHOLD
    for (const memberId of affectedMembers) {
      const handle = this.handles.get(memberId)
      if (handle !== undefined) {
        this.afterCommit(`notification for '${this.memberLabel(memberId)}'`,
          () => this.notifyMember(handle.agent, { kind: 'commit', receipt, operationKind: operation.kind }), deferNotifications, memberId)
        continue
      }
      this.afterCommit(`transition repair for '${this.memberLabel(memberId)}'`, () => {
        void this.finishRecordedTransitionThenNotify(memberId, { kind: 'commit', receipt, operationKind: operation.kind })
      })
    }
  }

  private async finishRecordedTransitionThenNotify(memberId: AgentTeamMemberId, cause: NotificationCause): Promise<void> {
    if (!this.accepting || this.contextManagement.isTransitioning(memberId)) return
    let finished = false
    try {
      finished = await this.enqueueLifecycle(memberId, async () => {
        const member = this.requireLedger().getMember(memberId)
        if (member === undefined || member.state !== 'enabled' || this.handles.has(memberId)) return false
        // The swap that owns this Member is still running: its own activation
        // is the effect this would duplicate.
        if (this.contextManagement.isTransitioning(memberId)) return false
        if (this.requireLedger().lastTransitionForMember(memberId) === undefined) return false
        await this.finishMemberTransition(memberId)
        return true
      })
    } catch (error) {
      if (!this.accepting) return
      this.ctx.logger.warn(`agent-team: could not finish the recorded Session transition for ${this.memberScope(memberId)}: ${failureDetail(error)}`)
      return
    }
    if (!finished) return
    const live = this.handles.get(memberId)
    if (live === undefined) {
      this.ctx.logger.warn(`agent-team: ${this.memberScope(memberId)} is still without a live session after finishing its recorded Session transition: ${this.memberFailures.get(memberId)?.activation?.detail ?? 'activation did not report a reason'}; it stays unavailable until Member recovery or the next startup retries the activation`)
      return
    }
    this.notifyMember(live.agent, cause)
  }

  /**
   * Run one effect that follows the ledger append. The operation is durable by now, so a delivery or listener failure degrades to a log line;
   * a failed Inbox wake clears its own signature so the next commit retries the same durable facts without a second operation.
   * Synchronous invariant divergence is re-raised on the caller's frame; deferred notification effects report it at error level because the commit has already returned.
   */
  private afterCommit(label: string, effect: () => void, deferNotification = false, notificationMemberId?: AgentTeamMemberId): void {
    const pendingNotification = notificationMemberId === undefined ? undefined : this.notificationEffectTails.get(notificationMemberId)
    if (notificationMemberId !== undefined && (deferNotification || pendingNotification !== undefined)) {
      const previous = pendingNotification ?? Promise.resolve()
      const queued = previous.then(() => new Promise<void>(resolve => {
        setImmediate(() => {
          try {
            // Durable facts are rederived during the next activation if shutdown wins the race.
            if (this.accepting) effect()
          } catch (error) {
            // A deferred effect has no caller frame to re-raise on, so an
            // invariant divergence is reported at the level the synchronous
            // path reserves for it instead of folding into the retry warn.
            if (error instanceof AgentTeamInvariantError) this.ctx.logger.error(`agent-team: post-commit ${label} violated an invariant: ${error.message}`)
            else this.ctx.logger.warn(`agent-team: post-commit ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            resolve()
          }
        })
      }))
      this.notificationEffectTails.set(notificationMemberId, queued)
      void queued.then(() => {
        if (this.notificationEffectTails.get(notificationMemberId) !== queued) return
        this.notificationEffectTails.delete(notificationMemberId)
      })
      return
    }
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
   * The correlation group every Member-scoped diagnostic line carries: ledger Member id and owning Session, with the renameable handle as context.
   * The Session resolves from the live generation first, then the ledger binding.
   */
  private memberScope(memberId: AgentTeamMemberId, sessionId?: SessionId): string {
    const handle = this.ledger?.getMember(memberId)?.handle
    const session = sessionId ?? this.handles.get(memberId)?.agent.session.id ?? this.ledger?.getMember(memberId)?.sessionId
    return `member '${handle ?? memberId}' memberId '${memberId}'${session === undefined ? '' : ` session '${session}'`}`
  }

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
    if (cause.kind === 'consumption-retry') return 'Member reminder consumption write failed'
    return 'running transition'
  }

  /**
   * The delivery plan for one redelivery. `deliveredReminders` narrows the
   * coverage to the occurrences a notice actually rendered: the plan decides
   * that an attempt is owed, the notice earns what it covers.
   */
  private inboxDeliveryPlan(input: {
    readonly notifications: ReturnType<AgentTeamLedger['notificationFacts']>
    readonly main: ReturnType<AgentTeamLedger['mainNotificationFacts']>
    readonly memberReminders?: readonly AgentTeamUnreadMemberReminder[] | undefined
    readonly deliveredReminders?: readonly InboxMemberReminder[] | undefined
    readonly previous?: InboxNoticeDelivery | undefined
  }): InboxDeliveryPlan {
    return planInboxDelivery({
      threads: input.notifications,
      main: input.main.map(({ project, entries }) => ({ projectRef: project.projectRef, entries })),
      reminders: (input.memberReminders ?? []).map(entry => ({ reminderRef: entry.reminder.reminderRef, sequence: entry.sequence })),
      deliveredReminders: input.deliveredReminders,
      covered: input.previous?.covered, undelivered: input.previous?.undelivered })
  }

  private notificationIdentity(notifications: ReturnType<AgentTeamLedger['notificationFacts']>,
    main: ReturnType<AgentTeamLedger['mainNotificationFacts']> = [], memberReminders: readonly AgentTeamUnreadMemberReminder[] = []): string {
    let newest = 0
    for (const { item } of notifications) newest = Math.max(newest, item.newestSequence)
    for (const { entries } of main) newest = Math.max(newest, entries.at(-1)?.sequence ?? 0)
    for (const entry of memberReminders) newest = Math.max(newest, entry.sequence)
    return `${notifications.length} unread Thread(s)${main.length === 0 ? '' : `, ${main.length} Project Main stream(s)`}`
      + `${memberReminders.length === 0 ? '' : `, ${memberReminders.length} due Member reminder(s)`}, newest unread fact sequence ${newest}`
  }

  /**
   * Wake from durable unread state with bounded facts. One correlated line states what the wake did: its cause, the attempt it spent,
   * and whether the notice was queued, already carried by a recovery instruction, skipped, or failed. A queued notice is delivery intent, not evidence the model read it.
   * A delivery failure is contained here: the operation is already durable. A synchronous invariant divergence leaves on the caller's frame; a deferred one is logged by afterCommit.
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
    this.scheduleTaskReminderEvaluation()
    this.scheduleMemberReminderEvaluation()
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
    const material = this.requireLedger().notificationSnapshot(member.memberId)
    const notifications = material.threads
    const mainNotifications = material.main
    const memberReminders = material.memberReminders
    const scope = this.memberScope(member.memberId, agent.id)
    const causeText = this.notificationCauseText(cause)
    if (notifications.length === 0 && mainNotifications.length === 0 && memberReminders.length === 0) {
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
    const previous = this.inboxNoticeDeliveries.get(member.memberId)
    const plan = this.inboxDeliveryPlan({ notifications, main: mainNotifications, memberReminders, previous })
    const facts = this.notificationIdentity(notifications, mainNotifications, memberReminders)
    // An unchanged rederivation spends no attempt: the delivery already made
    // for these facts stands, which is what keeps a repeated commit's logging
    // bounded.
    if (plan.trigger === undefined) {
      this.ctx.logger.debug(`agent-team: Team Inbox notice not attempted for ${scope} cause ${causeText}: ${plan.signature === ''
        ? 'the Member has no unread Team facts'
        : `the same unread facts (${facts}) already have a delivery attempt`}`)
      return
    }
    const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
    // steerResume already combines the recovery instruction and these durable
    // facts. Its synchronous running transition must not replace that notice.
    if (pending.some(message => this.isRecoveryNotice(message))) {
      // Only the occurrences that recovery instruction actually rendered are
      // answered by it. One raised after it was queued was never in its text, so
      // it stays out of `covered` and stays owed: the claim of that instruction
      // rederives the Inbox and delivers it.
      const recovery = pending.find(message => this.isRecoveryNotice(message))!
      this.coverInboxFacts(member.memberId, this.inboxDeliveryPlan({ notifications, main: mainNotifications,
        deliveredReminders: this.memberReminderWakes.get(recovery.id)?.reminders ?? [], previous }))
      this.ctx.logger.info(`agent-team: Team Inbox notice carried by the queued recovery instruction for ${scope} cause ${causeText} (${facts}): queued with that recovery instruction, not yet read by the model`)
      return
    }
    const existingInboxHint = pending.find(message => this.isInboxNotice(message))
    if (existingInboxHint !== undefined) this.removeExpectedTeamWake(agent, existingInboxHint)
    const notice = this.notificationText(agent, notifications, member.memberId, mainNotifications, plan, '', memberReminders, material.workers)
    const hint = createUserMessage({
      content: [{ type: 'text', text: notice.text }],
      source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: TEAM_INBOX_NOTICE_SUMMARY, teamFacts: teamMessageSurface(notice.text, notice.messages, notice.activities) },
    })
    this.trackTeamWake(agent, hint)
    // A Member reminder is consumed when its notice reaches a turn, so the queued
    // message carries the occurrences it rendered for the claim that reads them.
    if (notice.deliveredReminders.length > 0) {
      this.memberReminderWakes.set(hint.id, { memberId: member.memberId, reminders: notice.deliveredReminders })
    }
    // Coverage is what the notice rendered, not what the plan offered: an
    // occurrence the detail cap or the character budget dropped never reached
    // the Member, so it is not answered and stays unread.
    const earned = notice.deliveredReminders.length === memberReminders.length ? plan
      : this.inboxDeliveryPlan({ notifications, main: mainNotifications, memberReminders, deliveredReminders: notice.deliveredReminders, previous })
    const attempt = this.beginInboxDelivery(member.memberId, earned, notice.undelivered)
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
    this.ctx.logger.info(`agent-team: Team Inbox notice queued for ${scope} cause ${causeText} attempt ${attempt} delivery ${plan.trigger} lane '${sequenced ? 'follow-up turn' : 'next step'}' (${facts}): queued for the Member's next step, not yet read by the model`)
  }

  /**
   * One line per automatic-recovery state change (classified family, counted occurrence, armed wait, fired wakeup, stand-down, end of tracking),
   * so no stop is silent and the automatic path is explainable without debug output.
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

  /** Every Team-authored notice, including the acceptance reminder: a queued one is Host context, not the Member's own unfinished input, so it must not pin the current generation. */
  private isTeamWake(message: UserMessage): boolean {
    return this.isInboxNotice(message) || this.isRecoveryNotice(message) || isAcceptanceNotice(message)
  }

  private trackTeamWake(agent: Agent, message: UserMessage): void {
    const member = this.memberForAgent(agent)
    if (member === undefined) return
    this.pendingTeamWakes.set(message.id, { memberId: member.memberId, sessionId: agent.id })
  }

  /** Remove a Team notice that Host code is replacing or disposing on purpose. */
  private removeExpectedTeamWake(agent: Agent, message: UserMessage): void {
    this.expectedInboxDiscards.add(message.id)
    // The occurrences this message carried were never read, so nothing may
    // consume them: its successor rederives them from the durable unread.
    this.memberReminderWakes.delete(message.id)
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

  private notificationText(agent: Agent, notifications: ReturnType<AgentTeamLedger['notificationFacts']>, readerId?: AgentTeamMemberId, main: ReturnType<AgentTeamLedger['mainNotificationFacts']> = [], deliveryPlan?: InboxDeliveryPlan, prefix = '', memberReminders: readonly AgentTeamUnreadMemberReminder[] = [], workers: readonly AgentTeamWorkerAnswer[] = []): RenderedInboxNotice {
    const plan = deliveryPlan ?? (readerId === undefined ? undefined : this.inboxDeliveryPlan({ notifications, main }))
    return renderInboxNotice({ notifications, main, memberReminders, workers, readerId, deliveryPlan: plan, prefix,
      surface: visibleTeamSurface(agent), lookup: {
        printableSender: memberId => this.printableSender(memberId),
        isProjectOwner: (reader, projectRef) => this.requireLedger().projectOwnerIds(projectRef).includes(reader),
        repliesToLine: (message, workspaceId) => this.repliesToLine(message, workspaceId),
        claimOwner: claimRef => this.requireLedger().getClaim(claimRef)?.owner,
      } })
  }

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
    this.memberRuntime.forgetMember(memberId)
    this.memberIdle.forget(memberId)
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

  /** Record that the queued notice now answers these facts, keeping the attempt count. */
  private coverInboxFacts(memberId: AgentTeamMemberId, plan: InboxDeliveryPlan): void {
    this.inboxNoticeDeliveries.set(memberId, { covered: plan.delivered, attempt: this.inboxNoticeDeliveries.get(memberId)?.attempt ?? 0,
      undelivered: this.inboxNoticeDeliveries.get(memberId)?.undelivered ?? [] })
  }

  /** Spend one delivery attempt and mark the facts it covers; the count rises first so a failed wake still reports the attempt it spent. */
  private beginInboxDelivery(memberId: AgentTeamMemberId, plan: InboxDeliveryPlan, undelivered: readonly AgentTeamThreadRef[]): number {
    const attempt = (this.inboxNoticeDeliveries.get(memberId)?.attempt ?? 0) + 1
    // `delivered` is what this notice actually answered, so an unchanged
    // rederivation of the same facts stands down; `signature` is only for the log.
    this.inboxNoticeDeliveries.set(memberId, { covered: plan.delivered, attempt, undelivered })
    return attempt
  }

  /**
   * Drop the fact coverage but keep the attempt count, so the next commit retries the same facts as the next attempt.
   */
  private dropInboxCoverage(memberId: AgentTeamMemberId): void {
    const delivery = this.inboxNoticeDeliveries.get(memberId)
    if (delivery !== undefined) {
      this.inboxNoticeDeliveries.set(memberId, { covered: '', attempt: delivery.attempt, undelivered: delivery.undelivered })
    }
  }

  /**
   * Wake waiters for one committed or lifecycle change. Undefined broadcasts to everyone; an empty scope list invalidates nobody;
   * otherwise global and matching scoped waiters wake. Presence-only scopes wake only matching presence waiters.
   * Each waiter receives the version of its own scope's domain; nothing here advances the projection version.
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
   * The cursor domain of one scope: presence scopes count process-local edge wakes, every other scope compares against the ledger position of the newest shared-projection commit.
   * Keeping them separate stops a presence edge from invalidating a projection subscriber.
   */
  private changeVersionOf(scope: AgentTeamChangeScope | undefined): number {
    if (scope?.kind === 'presence') return this.presenceEpoch
    return this.ledger?.projectionSequence() ?? 0
  }

  private validateChangeScope(scope: AgentTeamChangeScope | undefined): AgentTeamChangeScope | undefined {
    if (scope === undefined) return undefined
    const ref = scope.kind === 'workspace' || scope.kind === 'presence' ? scope.workspaceId : scope.kind === 'project' ? scope.projectRef : scope.threadRef
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
