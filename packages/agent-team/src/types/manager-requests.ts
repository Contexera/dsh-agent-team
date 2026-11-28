/** Remote contracts of the Manager surface: its Session, overview, evidence and Manager-mediated writes. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from "@deepseek-ai/dsh-session"
import type { SessionLocation } from "@deepseek-ai/dsh-session-persistence"
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace"
import type {
  AgentTeamAgentMemberStatus,
  AgentTeamCapabilityWarning,
  AgentTeamMemberCapabilities,
  AgentTeamMemberDiagnostic,
  AgentTeamMemberId,
  AgentTeamModelSelection,
  AgentTeamOwnedProject,
  AgentTeamProjectRef,
  AgentTeamRequestId,
} from "./entities.ts"
import type { AgentTeamMemberEffect } from "./membership-requests.ts"
import type { AgentTeamOperationReceipt } from "./operation-receipt.ts"

/** Classify listed Sessions from the Host's durable manager lineage and Member ledger before blank reuse. */
export interface AgentTeamSessionOwnershipRequest {
  readonly sessionIds: readonly SessionId[]
}

/** A listed Session retained in this Team Host's ownership history, not an ordinary reusable blank. */
export interface AgentTeamSessionOwnership {
  readonly sessionId: SessionId
  readonly kind: 'member' | 'manager'
}

/** Open or resolve the Host-managed Team manager Session. The request carries no caller-selected identity. */
export interface AgentTeamManagerSessionRequest {}

/** Replace the manager Session the caller currently sees, only if it is still current. */
export interface AgentTeamNewManagerSessionRequest {
  readonly expectedSessionId: SessionId
}

/**
 * Which action helps when the manager Session is unavailable. Refused and
 * unreadable stored Sessions stay distinct so a damaged log is never replaced
 * as though it had been deleted.
 */
export type AgentTeamManagerDiagnosticClass =
  | 'session-refused'
  | 'session-unreadable'
  | 'preset-composition'
  | 'workspace-unavailable'
  | 'session-create'
  | 'session-resume'
  | 'session-attach'
  | 'pointer-read'
  | 'pointer-persist'
  | 'runtime'

/** One structured manager failure; rendered by the Client, never persisted. */
export interface AgentTeamManagerDiagnostic {
  readonly class: AgentTeamManagerDiagnosticClass
  readonly detail: string
  /** The refused artifact's location, when a format refusal reported one. */
  readonly location?: { readonly kind: string; readonly path: string }
  /** The manager Session the failure is about, when it is about one. */
  readonly sessionId?: SessionId
  /** The bounded source that observed the failure, when one is available. */
  readonly source?: string
  /** When the Host observed the failure, as an ISO timestamp. */
  readonly occurredAt?: string
}

/** The resolved manager destination. `no-workspace` is an ordinary empty state, not a failure. */
export type AgentTeamManagerSessionResult =
  | { readonly status: 'ready'; readonly sessionId: SessionId; readonly workspaceId: WorkspaceId }
  | { readonly status: 'no-workspace' }
  | { readonly status: 'unavailable'; readonly diagnostic: AgentTeamManagerDiagnostic }

/**
 * What the Team manager asks about the Team. Every axis is optional and an
 * unnarrowed call reads the whole installation, which is what "what is my team
 * like" means. No axis names a Session, a Member identity to act as, or a
 * preset: the Host decides who is asking from the live Agent, so no request
 * field can authorize a read.
 */
export interface AgentTeamManagerOverviewRequest {
  /** Narrow the directory to one Workspace. */
  readonly workspaceId?: WorkspaceId
  /** Narrow to one Project: its own row, its owners, and the Members that belong to it. */
  readonly projectRef?: AgentTeamProjectRef
  /** Read one Member's detail row, the only place a private directory path appears. */
  readonly memberRef?: AgentTeamMemberId
  /** Bound per collection, 1–100. A collection this bound cut says so; nothing is truncated silently. */
  readonly limit?: number
}

/** One Workspace in the Host directory, carrying the checkout path a later write would target. */
export interface AgentTeamManagerWorkspaceEntry {
  readonly workspaceId: WorkspaceId
  /** Registry display title; absent when the Workspace is already gone from the registry. */
  readonly title?: string | undefined
  readonly path: string | undefined
  readonly projectCount: number
  readonly memberCount: number
}

/** One Project owner as the overview reports it: a stable ref, a handle, and what that owner answers for here. */
export interface AgentTeamManagerOwnerEntry {
  readonly memberRef: AgentTeamMemberId
  readonly handle: string
  /** Absent means unspecified, which is a fact about the grant rather than a gap to repair. */
  readonly responsibility?: string
}

/** One Project's standing: its shared goal, its owners, and the two counts a manager acts on. */
export interface AgentTeamManagerProjectEntry {
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly name: string
  /** The Project's shared goal; may be empty and filled in later. */
  readonly description: string
  /** Every entry the Host emits is active; an archived Project never reaches any projection. */
  readonly state: 'active' | 'archived'
  readonly owners: readonly AgentTeamManagerOwnerEntry[]
  /** Live subscription scheduling state, so a paused Project is visible without reading its subscriptions. */
  readonly subscriptions: { readonly active: number; readonly paused: number }
  /** Board summary; the full board stays a `team_task` read. */
  readonly board: { readonly open: number; readonly inReview: number }
}

/** One Member's standing across the Team: where it participates, how it runs, and what it owns. */
export interface AgentTeamManagerMemberEntry {
  readonly memberRef: AgentTeamMemberId
  readonly handle: string
  readonly description: string
  /** Every Workspace this Member participates in; the same handle in two Workspaces is two Members. */
  readonly workspaceIds: readonly WorkspaceId[]
  readonly availability: AgentTeamAgentMemberStatus['availability']
  readonly presence: AgentTeamAgentMemberStatus['presence']
  readonly diagnostic?: AgentTeamMemberDiagnostic
  /** The route this Member is configured to run — the stored selection, which a failed live apply can leave ahead of the running one; absent means it inherits the deployment default at every activation. */
  readonly model?: AgentTeamModelSelection | undefined
  readonly capabilityState: AgentTeamAgentMemberStatus['capabilityState']
  readonly capabilityWarnings?: readonly AgentTeamCapabilityWarning[] | undefined
  /** Projects this Member owns, with what it answers for there; empty is a fact, not a fault. */
  readonly owns: readonly AgentTeamOwnedProject[]
}

/** One Member read by ref: the detail a later write needs, and nothing beyond it. */
export interface AgentTeamManagerMemberDetail {
  readonly memberRef: AgentTeamMemberId
  readonly handle: string
  /** The Member's global standing, as the manager wrote it: the one fact that makes a single-Member read complete. */
  readonly description: string
  /** The Member's actual private directory. Never its contents, credentials, or Session bodies. */
  readonly privateMemoryPath: string
  readonly owns: readonly AgentTeamOwnedProject[]
}

/**
 * One Workspace's directory as the manager reads it. `team_view` builds the same
 * Projects and Members for a Member; this shape exists because the manager is
 * not a Member, so neither the participation filter nor the Member-relative
 * `participating` flag means anything here.
 */
export interface AgentTeamManagerDirectory {
  readonly projects: readonly AgentTeamManagerProjectEntry[]
  readonly memberIds: readonly AgentTeamMemberId[]
}

/**
 * The whole Team as the manager reads it: no message bodies, no Thread facts, no
 * credentials. An empty collection is a real answer; a directory that could not
 * be read is a refusal, which is why this result has no error variant of its
 * own — the Host throws and the tool reports the failure as a failure.
 */
export interface AgentTeamManagerOverview {
  readonly workspaces: readonly AgentTeamManagerWorkspaceEntry[]
  readonly projects: readonly AgentTeamManagerProjectEntry[]
  readonly members: readonly AgentTeamManagerMemberEntry[]
  /** Team-level switches a manager must know before proposing a change. */
  readonly switches: { readonly worker: boolean }
  /** Which collections the request's bound cut. A collection that merely happens to be full is not truncated. */
  readonly truncated: { readonly workspaces: boolean; readonly projects: boolean; readonly members: boolean }
  /** Present only when the request named a `memberRef`. */
  readonly member?: AgentTeamManagerMemberDetail
}

/**
 * The model routes a Member may run, in the Session controller's own catalog
 * shape. Reusing that type rather than mirroring it is what keeps this list
 * identical to the Web member editor by construction: one provider grouping,
 * one reasoning-effort list, one isolated-failure channel.
 */
export interface AgentTeamManagerModels {
  readonly catalog: ModelCatalog
  /** The presets a Member may compose. The manager's own preset is deliberately absent. */
  readonly memberPresets: readonly string[]
}

/** Why a Session locator could not answer with a stored log. */
export type AgentTeamManagerSessionEvidenceFailureKind = 'missing' | 'refused' | 'corrupt' | 'io' | 'unknown'

/** The backend's own classification of an unreadable stored Session, with its location when reported. */
export interface AgentTeamManagerSessionEvidenceFailure {
  readonly kind: AgentTeamManagerSessionEvidenceFailureKind
  readonly detail: string
  readonly location?: SessionLocation
}

/** Whether a Member's current Session has a durable log yet. */
export type AgentTeamManagerSessionEvidenceState =
  | 'stored' // a materialized log exists and the reader can open it
  | 'pending' // the Session exists but has no materialized artifact yet
  | 'missing' // no durable log at all; the Session may be live and unflushed, so this is not "no work"
  | 'unreadable' // the backend refused or could not read the log; `failure` names why

/**
 * Where one Member's current Session lives, and the shipped read-only reader
 * that can inspect it. The Host resolves the Session from the ledger, so the
 * manager never guesses by handle and never enumerates the machine's Sessions.
 * `reader.script` is the installed reader's absolute path and `reader.anchor`
 * is the running DSH installation the script resolves the Harness reader from;
 * neither is a file to open by hand.
 */
export interface AgentTeamManagerSessionEvidenceLocator {
  readonly memberRef: AgentTeamMemberId
  readonly handle: string
  readonly sessionId: SessionId
  readonly state: AgentTeamManagerSessionEvidenceState
  /** The backend-resolved artifact location; absent unless `state` is `stored`. */
  readonly location?: SessionLocation
  readonly reader: {
    readonly script: string
    readonly anchor?: string
  }
  /** Present when `state` is `unreadable`. */
  readonly failure?: AgentTeamManagerSessionEvidenceFailure
}

/**
 * One management write's durable answer. `committed` is the only successful
 * outcome: the ledger either recorded this intent now or resolved it as the
 * idempotent replay of an earlier call under the same requestId, and the
 * receipt names that record either way. A refusal throws before any append, so
 * an error whose text names a reason means nothing was written; a call whose
 * answer was lost is retried under the same requestId, which the ledger
 * answers with the original receipt instead of writing twice.
 */
export interface AgentTeamManagerWriteResult {
  readonly requestId: AgentTeamRequestId
  readonly outcome: 'committed'
  readonly receipt: AgentTeamOperationReceipt
}

/**
 * What the manager asks when it creates a Member. No field can authorize the
 * write: the Host resolves the caller from the live Agent, and the Member
 * preset is the Host's own answer rather than a choice.
 */
export interface AgentTeamManagerMemberCreateRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly handle: string
  /** The Member's global standing; the manager layer refuses an empty one. */
  readonly description: string
  /** Creation always names a route, validated against the Session controller's model catalog. */
  readonly model: AgentTeamModelSelection
  readonly capabilities?: AgentTeamMemberCapabilities
}

/** A created Member with the participation set the Host seeded and its live standing after the write. */
export interface AgentTeamManagerMemberCreateResult extends AgentTeamManagerWriteResult {
  readonly memberRef: AgentTeamMemberId
  readonly workspaceIds: readonly WorkspaceId[]
  /** A committed Member whose activation failed reads unavailable with its diagnostic, never as an uncommitted write. */
  readonly status: AgentTeamAgentMemberStatus
}

/** What the manager asks when it records a Project's shared goal. */
export interface AgentTeamManagerProjectCreateRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly name: string
  /** The shared goal; the manager layer refuses an empty one. */
  readonly description: string
}

/** A created Project with the Members it brought in. */
export interface AgentTeamManagerProjectCreateResult extends AgentTeamManagerWriteResult {
  readonly projectRef: AgentTeamProjectRef
  readonly memberIds: readonly AgentTeamMemberId[]
}

/** The ownership changes the manager surface holds: grant, replace the responsibility, or withdraw. */
export type AgentTeamManagerProjectOwnerAction = 'add' | 'update' | 'remove'

/** What the manager asks of one Agent Member's ownership of one Project. */
export interface AgentTeamManagerProjectOwnerRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly memberRef: AgentTeamMemberId
  readonly action: AgentTeamManagerProjectOwnerAction
  /**
   * `add` requires a non-empty standing; `update` replaces it, and an explicit
   * empty one records "unspecified" exactly as the Web entry does; `remove`
   * takes none, because a withdrawn grant describes nothing.
   */
  readonly responsibility?: string
}

/** The ownership after the change; a withdrawal records no responsibility. */
export interface AgentTeamManagerProjectOwnerResult extends AgentTeamManagerWriteResult {
  readonly action: AgentTeamManagerProjectOwnerAction
  readonly projectRef: AgentTeamProjectRef
  readonly memberRef: AgentTeamMemberId
  readonly responsibility?: string
}

/** The Project changes the manager surface holds: a display-fact patch, or archival. */
export type AgentTeamManagerProjectUpdateAction = 'update' | 'archive'

/** What the manager asks of one Project's display facts or lifecycle. */
export interface AgentTeamManagerProjectUpdateRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly action: AgentTeamManagerProjectUpdateAction
  /** Absent keeps the stored name; the manager layer refuses an explicit blank. */
  readonly name?: string
  /** Absent keeps the stored goal; an explicit blank clears it, matching the Web editor. */
  readonly description?: string
}

/** The Project after the change, plus what archival released and cleaned up. */
export interface AgentTeamManagerProjectUpdateResult extends AgentTeamManagerWriteResult {
  readonly action: AgentTeamManagerProjectUpdateAction
  readonly projectRef: AgentTeamProjectRef
  readonly name: string
  readonly description: string
  readonly state: 'active' | 'archived'
  /** Archival only: the active Claims it released and the subscriptions whose private state it cleared. */
  readonly releasedClaims?: number
  readonly subscriptionsCleared?: number
  /** Archival only: a cleanup that failed after the commit, named instead of turning the write into a rejection. */
  readonly cleanupWarning?: string
}

/** One configuration edit's runtime outcome as the manager reports it: the shared effect states, plus the live apply that failed after the write committed. */
export type AgentTeamManagerMemberEffect = AgentTeamMemberEffect | 'failed:model-apply' | 'failed:capability-apply'

/**
 * What the manager asks when it edits one Member's mutable facts. The handle
 * and the preset are not editable here; every field left absent keeps the value
 * stored when the write runs, so an edit cannot write back an older snapshot.
 */
export interface AgentTeamManagerMemberUpdateRequest {
  readonly requestId: AgentTeamRequestId
  readonly memberRef: AgentTeamMemberId
  /** The new global standing; absent keeps it, and an explicit blank is refused. */
  readonly description?: string
  /** A replacement route, validated against the Session controller's catalog while the request is new; absent keeps the stored one. */
  readonly model?: AgentTeamModelSelection
  /** A replacement capability intent; absent keeps the stored override, and `null` clears it back to the full surface. */
  readonly capabilities?: AgentTeamMemberCapabilities | null
}

/** An edited Member with its standing after the write and how far the stored configuration reached the live runtime. */
export interface AgentTeamManagerMemberUpdateResult extends AgentTeamManagerWriteResult {
  readonly memberRef: AgentTeamMemberId
  /** A failed live apply reads `failed:model-apply` or `failed:capability-apply` here and as the Member's own diagnostic in `status`, never as an uncommitted write. */
  readonly status: AgentTeamAgentMemberStatus
  readonly effect: AgentTeamManagerMemberEffect
}

/** The lifecycle actions the manager surface holds; `recover` is a runtime operation with no ledger record. */
export type AgentTeamManagerMemberStateAction = 'suspend' | 'resume' | 'archive' | 'recover'

/** What the manager asks of one Member's lifecycle. `recover` names the Workspace whose participation the Host verifies. */
export interface AgentTeamManagerMemberStateRequest {
  readonly requestId: AgentTeamRequestId
  readonly memberRef: AgentTeamMemberId
  readonly action: AgentTeamManagerMemberStateAction
  /** `recover` only: the Workspace the Member must participate in. */
  readonly workspaceId?: WorkspaceId
}

/** The standing after a lifecycle action; `recover` wrote no ledger record, so it carries no receipt. */
export interface AgentTeamManagerMemberStateResult {
  readonly requestId: AgentTeamRequestId
  readonly action: AgentTeamManagerMemberStateAction
  readonly outcome: 'committed' | 'runtime-only'
  readonly receipt?: AgentTeamOperationReceipt
  readonly memberRef: AgentTeamMemberId
  readonly status: AgentTeamAgentMemberStatus
  /** Archival only: how many active Claims it released and how many Attention rows it cleared. */
  readonly releasedClaims?: number
  readonly removedAttention?: number
}

/** What the manager asks when it changes one Member's Workspace participation. */
export interface AgentTeamManagerMemberWorkspaceRequest {
  readonly requestId: AgentTeamRequestId
  readonly action: 'join' | 'leave'
  readonly memberRef: AgentTeamMemberId
  readonly workspaceId: WorkspaceId
}

/** The participation set after the write; a join or a leave never moves the Member's Session. */
export interface AgentTeamManagerMemberWorkspaceResult extends AgentTeamManagerWriteResult {
  readonly memberRef: AgentTeamMemberId
  readonly workspaceId: WorkspaceId
  readonly workspaceIds: readonly WorkspaceId[]
  /** Withdrawal only: how many active Claims it released and how many Attention rows it cleared. */
  readonly releasedClaims?: number
  readonly removedAttention?: number
}
