/** Remote contracts for read models: thread observations, views, the task board, changes and status. */
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace"
import type {
  AgentTeamActivity,
  AgentTeamClaim,
  AgentTeamMemberId,
  AgentTeamMessage,
  AgentTeamProject,
  AgentTeamProjectMembership,
  AgentTeamProjectOwner,
  AgentTeamProjectRef,
  AgentTeamTask,
  AgentTeamTaskRef,
  AgentTeamThread,
  AgentTeamThreadRef,
} from "./entities.ts"
import type { AgentTeamInboxActor } from "./collaboration-requests.ts"

/** Human-only observation of a durable personal Attention change. */
export interface AgentTeamThreadAttentionObservation {
  readonly sequence: number
  readonly threadRef: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
  readonly memberId: AgentTeamMemberId
  readonly action: 'follow' | 'unfollow'
}

export interface AgentTeamThreadObservationsRequest {
  readonly workspaceId: WorkspaceId
  readonly threadRef?: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
  readonly limit?: number
}

export interface AgentTeamThreadObservations {
  /** The newest observations up to `limit` (default 50, at most 100); `hasMore` says whether older ones exist. */
  readonly items: readonly AgentTeamThreadAttentionObservation[]
  /** Members whose Attention currently follows the Thread — the state the replayed observations lead to. */
  readonly followers: readonly AgentTeamMemberId[]
  /** Older observations than `items` exist. The follower set is always complete. */
  readonly hasMore: boolean
}

/** One bounded Workspace view item. */
export interface AgentTeamViewItem {
  readonly message: AgentTeamMessage
  /** Structured Member refs of this Message, from its originating send operation. */
  readonly mentions: readonly AgentTeamMemberId[]
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly taskNumber?: number
  /** Owners of this item's Task's live Claims, in claim order, deduped (the Inbox row's rule), resolved here because a feed entry draws handles and has no Member view. Empty on a taskless, done, or closed item. */
  readonly liveClaimOwners: readonly AgentTeamInboxActor[]
  readonly messageCount: number
  /** Instant of the latest fact on this Thread (message or activity), projected from its committing operation. */
  readonly lastActivityAt: string
}

/** How the reader stands to one Task on the board. */
export type AgentTeamTaskRelation = 'accountable' | 'executor' | 'project-owner' | 'none'

/** One Task on the board: its current state, never a fact, so it is never unread. */
export interface AgentTeamTaskBoardItem {
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly projectName: string
  readonly task: AgentTeamTask
  readonly taskNumber: number
  readonly threadRef: AgentTeamThreadRef
  /** The Thread's bounded opening line. */
  readonly subject: string
  /** Owners of the Task's live Claims, in claim order, deduped (the Inbox row's rule); empty once done or closed. */
  readonly liveClaimOwners: readonly AgentTeamInboxActor[]
  readonly lastActivitySequence: number
  readonly lastActivityAt: string
  /** The accountable owner resolved for display; the Human entry carries the configured handle. */
  readonly accountableOwner: AgentTeamInboxActor
  /** `executor` while the reader holds a live Claim, else `project-owner` for an owner of the Project. */
  readonly relation: AgentTeamTaskRelation
  /** The reader may accept this in_review Task and has not executed it. */
  readonly needsAcceptance: boolean
}

export interface AgentTeamTaskBoardRequest {
  readonly workspaceId: WorkspaceId
  readonly projectRef?: AgentTeamProjectRef
  /** Only Tasks the reader is accountable for or actively executes. */
  readonly mine?: boolean
  /** Per Project, how many finished (done or closed) Tasks to keep: 1–100, default `TASK_BOARD_FINISHED_PER_PROJECT`. */
  readonly finishedLimit?: number
}

/** The Task board of the Projects a reader can see; the Human Client and `team_task board` render this same projection. */
export interface AgentTeamTaskBoard {
  /** The reader the projection is relative to, so a card can say 「你负责」 the way the Inbox names its rows. */
  readonly humanMemberId: AgentTeamMemberId
  /** Every open Task (todo, in_progress, in_review), newest activity first. */
  readonly open: readonly AgentTeamTaskBoardItem[]
  /** Per Project, the newest finished (done or closed) Tasks, at most `finishedLimit` each (default `TASK_BOARD_FINISHED_PER_PROJECT`), newest activity first. */
  readonly finished: readonly AgentTeamTaskBoardItem[]
  /**
   * The Host cut at least one Project's finished column at `finishedLimit`, so older resolved Tasks exist beyond `finished`.
   * A page that merely happens to be full is not truncated; the reader can raise `finishedLimit` and ask again.
   */
  readonly finishedTruncated: boolean
}

export interface AgentTeamViewRequest {
  readonly workspaceId: WorkspaceId
  readonly projectRef?: AgentTeamProjectRef
  readonly threadRef?: AgentTeamThreadRef
  readonly limit?: number
  readonly cursor?: number
  /** Read facts after the cursor (Agent default) or the latest facts before it (Client history). */
  readonly direction?: 'after' | 'before'
  readonly topLevelOnly?: boolean
  /** Include public Claim and Task activities in the bounded stream (default true). */
  readonly includeActivities?: boolean
  readonly includeCatalog?: boolean
  /** Agent address-book reads also include Workspace-wide directory metadata without widening Project content. */
  readonly includeWorkspaceDirectory?: boolean
}

export interface AgentTeamProjectDirectoryEntry {
  readonly project: AgentTeamProject
  readonly ownerIds: readonly AgentTeamMemberId[]
  /** Whether the viewing Member may read this Project under its rules version. */
  readonly participating: boolean
  /** Whether the viewing Member follows this Project's Main stream; present on a rules-version-9 ledger. */
  readonly followingMain?: boolean
  readonly subscriptions: { readonly active: number; readonly paused: number }
}

export interface AgentTeamWorkspaceDirectory {
  readonly projects: readonly AgentTeamProjectDirectoryEntry[]
  /** Every current Member participating in the Workspace, including Members with no Project membership. */
  readonly memberIds: readonly AgentTeamMemberId[]
}

/** Bounded public collaboration facts plus a continuation sequence. */
export interface AgentTeamView {
  readonly humanMemberId: AgentTeamMemberId
  /** Every Workspace the viewing Member participates in — the address book for the optional `workspace` selector; `default` marks the Workspace its Session roots in. */
  readonly workspaces: readonly AgentTeamWorkspaceParticipation[]
  readonly projects: readonly AgentTeamProject[]
  /** Present for the Agent address book; never used to authorize the content catalog above. */
  readonly directory?: AgentTeamWorkspaceDirectory
  readonly members: readonly AgentTeamProjectMembership[]
  /** Agent owners of the listed Projects with the responsibility each answers for; the Human owns every Project and is not listed. */
  readonly owners: readonly AgentTeamProjectOwner[]
  /** Validation rules version the ledger has adopted; Project owners exist from version 2. */
  readonly rulesVersion: number
  /** Catalog of the response's scope: visible Tasks, their Threads, ordinals, and Claims. With `includeCatalog` this is the whole request scope; otherwise only the Tasks and Threads the fact page and named Thread carry. */
  readonly tasks: readonly AgentTeamTask[]
  readonly threads: readonly AgentTeamThread[]
  readonly taskNumbers: readonly { readonly taskRef: AgentTeamTaskRef; readonly taskNumber: number }[]
  readonly items: readonly AgentTeamViewItem[]
  readonly claims: readonly AgentTeamClaim[]
  readonly activities: readonly AgentTeamActivity[]
  readonly cursor: number
  readonly hasMore: boolean
}

/** One Workspace a Member participates in, as exposed to the Member-facing view. */
export interface AgentTeamWorkspaceParticipation {
  readonly workspaceId: WorkspaceId
  /** Registry display title; absent when the Workspace is already gone from the registry (a dangling participation pending cleanup). */
  readonly title?: string | undefined
  readonly default: boolean
}

/** One projection slice a Client can wait on; events wake only matching waiters. */
export type AgentTeamChangeScope =
  | { readonly kind: 'workspace'; readonly workspaceId: WorkspaceId }
  | { readonly kind: 'project'; readonly projectRef: AgentTeamProjectRef }
  | { readonly kind: 'thread'; readonly threadRef: AgentTeamThreadRef }
  /** Presence-only lifecycle wake (Agent running/idle/failure) with no ledger commit: members/presence subscribers refresh, while workspace catalog and scope-less Inbox subscribers stay parked. */
  | { readonly kind: 'presence'; readonly workspaceId: WorkspaceId }

/** Subscribe to lightweight invalidations; each connection starts with a current baseline. */
export interface AgentTeamChangesRequest {
  /** Omit to observe every shared projection change. */
  readonly scope?: AgentTeamChangeScope
}

/** Invalidation, not a history record: intermediate versions may be coalesced. */
export interface AgentTeamChangesResult {
  /** Presence uses a process-local epoch; other scopes use the shared projection's ledger position. */
  readonly version: number
}

/** Human-facing summary of the current Team projection. */
export interface AgentTeamStatus {
  readonly initialized: true
  readonly sequence: number
  readonly operationCount: number
  readonly projectCount: number
  readonly agentMemberCount: number
  readonly humanMemberId: AgentTeamMemberId
  /** Validation rules version the ledger has adopted; Project owners exist from version 2. */
  readonly rulesVersion: number
}
