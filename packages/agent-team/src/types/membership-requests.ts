/** Remote contracts that create and change Projects, members and their Workspace and Project membership. */
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace"
import type {
  AgentTeamAgentMember,
  AgentTeamAgentMemberStatus,
  AgentTeamClaim,
  AgentTeamMemberCapabilities,
  AgentTeamMemberId,
  AgentTeamModelSelection,
  AgentTeamProject,
  AgentTeamProjectRef,
  AgentTeamRequestId,
  AgentTeamThreadAttentionKey,
} from "./entities.ts"
import type { AgentTeamOperationReceipt } from "./operation-receipt.ts"

/** Human intent to create a Workspace Project; ownership is granted afterwards through `project_owner`. */
export interface AgentTeamCreateProjectRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly name: string
  /** Display purpose text; may be empty and filled in later through an edit. */
  readonly description: string
}

/** Result of creating or idempotently resolving a Project and its initial Members. */
export interface AgentTeamCreateProjectResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly project: AgentTeamProject
  readonly memberIds: readonly AgentTeamMemberId[]
}

/** Human intent to provision one team-managed Agent Member with initial Projects. */
export interface AgentTeamAddMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly handle: string
  /** Display purpose text; may be empty and filled in later through an edit. */
  readonly description: string
  readonly presetId: string
  /** Required in practice: creation always names a route. The field stays optional because ledgers written before per-Member model selection omit it, and those records still replay. */
  readonly model?: AgentTeamModelSelection
  /** Durable capability intent; see AgentTeamMemberCapabilities. */
  readonly capabilities?: AgentTeamMemberCapabilities
  /** Existing Projects in this Workspace; may be empty — the Member joins Projects later and stays reachable through its DM view. */
  readonly projectRefs: readonly AgentTeamProjectRef[]
}

/** Human intent to rename one Project's display facts. */
export interface AgentTeamUpdateProjectRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  /** Absent keeps the stored name; an explicit blank is refused. */
  readonly name?: string
  /** Display purpose text; may be empty, matching creation. Absent keeps the stored goal. */
  readonly description?: string
}

/** Result of updating or idempotently resolving one Project's display facts. */
export interface AgentTeamUpdateProjectResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly project: AgentTeamProject
}

/** Human intent to grant or withdraw one Agent Member's ownership of a Project. The Human owns every Project and is never named. */
export interface AgentTeamProjectOwnerRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly memberId: AgentTeamMemberId
  /** What the new owner answers for, trimmed; blank or absent leaves it unspecified. Ignored on a withdrawal. */
  readonly responsibility?: string
}

/** Human intent to replace one Agent owner's responsibility without touching the ownership itself. */
export interface AgentTeamProjectOwnerUpdateRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly memberId: AgentTeamMemberId
  /** The whole replacement text, trimmed; an empty one means unspecified. */
  readonly responsibility: string
}

/** Result of changing or idempotently resolving one Project owner, with the Project's Agent owners after it. */
export interface AgentTeamProjectOwnerResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly projectRef: AgentTeamProjectRef
  readonly ownerIds: readonly AgentTeamMemberId[]
}

/** Human intent to archive one Project: hidden everywhere, facts kept. */
export interface AgentTeamArchiveProjectRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
}

/** Result of Project archival: hidden with every fact recoverable; active Claims on its Threads were released. */
export interface AgentTeamArchiveProjectResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly project: AgentTeamProject
  readonly releasedClaims: readonly AgentTeamClaim[]
}

/**
 * Human intent to edit one Member's mutable facts, as a partial update: an
 * absent field keeps the value stored at the moment the ledger's own serialized
 * section runs, so an edit never writes back a snapshot it read earlier, and an
 * explicit `null` clears the capability override. The model cannot be cleared:
 * a Member always runs an explicit route. A replay under the same requestId
 * compares only the fields the request states, so a later edit to a field this
 * request left alone cannot turn its retry into a collision.
 */
export interface AgentTeamUpdateMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly memberId: AgentTeamMemberId
  /** Absent keeps the current handle; the manager surface never edits it. */
  readonly handle?: string
  /** Display purpose text; may be empty, matching creation. Absent keeps the current one. */
  readonly description?: string
  /** Absent keeps the current selection; `null` is refused — replace the route instead of clearing it. */
  readonly model?: AgentTeamModelSelection | null
  /** Absent keeps the current override; `null` clears it back to the full surface. */
  readonly capabilities?: AgentTeamMemberCapabilities | null
}

/** Human intent to suspend or resume one Agent Member. */
export interface AgentTeamSetMemberStateRequest {
  readonly requestId: AgentTeamRequestId
  readonly memberId: AgentTeamMemberId
}

/** Human intent to archive one Agent Member: hidden everywhere, data kept. */
export interface AgentTeamArchiveMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly memberId: AgentTeamMemberId
}

/** Result of archival: the Member is hidden with data recoverable; its active Claims were released so no Task stays in progress behind it. */
export interface AgentTeamArchiveMemberResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly member: AgentTeamAgentMember
  readonly releasedClaims: readonly AgentTeamClaim[]
  readonly removedAttention: readonly AgentTeamThreadAttentionKey[]
}

/** Result of a Member lifecycle operation. */
export interface AgentTeamMemberResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly status: AgentTeamAgentMemberStatus
}

/** How a configuration edit's runtime effects landed: installed now, already in force, or saved but deferred to the next activation (with the reason). A failed apply is a rejection, never listed here. */
export type AgentTeamMemberEffect =
  | 'applied'
  | 'already-applied'
  | 'deferred:no-live-handle'
  | 'deferred:generation-changed'

/** Result of a configuration edit: lifecycle status plus its effect outcome. */
export interface AgentTeamUpdateMemberResult extends AgentTeamMemberResult {
  readonly effect: AgentTeamMemberEffect
}

/** Result of creating a Member: lifecycle status plus the participation set the Host seeded at creation. */
export interface AgentTeamAddMemberResult extends AgentTeamMemberResult {
  readonly workspaceIds: readonly WorkspaceId[]
}

/** Operator intent to nudge one error-stopped Member into continuing its work. */
export interface AgentTeamRecoverMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
}

/** Result of a recovery nudge; runtime-only steering, so there is no ledger receipt. */
export interface AgentTeamRecoverMemberResult {
  readonly status: AgentTeamAgentMemberStatus
}

/** Human intent to remove one Agent Member from one Project. */
export interface AgentTeamRemoveProjectMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly memberId: AgentTeamMemberId
}

/** Result of Project-scoped member cleanup. */
export interface AgentTeamRemoveProjectMemberResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly projectRef: AgentTeamProjectRef
  readonly memberId: AgentTeamMemberId
  readonly releasedClaims: readonly AgentTeamClaim[]
  readonly removedAttention: readonly AgentTeamThreadAttentionKey[]
}

/** Human intent to join one Agent Member to one additional Workspace. */
export interface AgentTeamJoinWorkspaceRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
}

export interface AgentTeamJoinWorkspaceResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly memberId: AgentTeamMemberId
  readonly workspaceId: WorkspaceId
}

/** Human intent to withdraw one Agent Member from a non-default Workspace: participation ends, Workspace-scoped Claims release, and Attention/markers on its Threads clear. */
export interface AgentTeamLeaveWorkspaceRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
}

export interface AgentTeamLeaveWorkspaceResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly memberId: AgentTeamMemberId
  readonly workspaceId: WorkspaceId
  readonly releasedClaims: readonly AgentTeamClaim[]
  readonly removedAttention: readonly AgentTeamThreadAttentionKey[]
}

/** Human intent to add one Agent Member to one Project. */
export interface AgentTeamJoinProjectRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly memberId: AgentTeamMemberId
}

export interface AgentTeamJoinProjectResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly projectRef: AgentTeamProjectRef
  readonly memberId: AgentTeamMemberId
}
