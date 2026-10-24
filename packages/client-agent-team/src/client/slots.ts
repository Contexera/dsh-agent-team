import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AgentTeamAddMemberRequest,
  AgentTeamArchiveProjectRequest,
  AgentTeamArchiveProjectResult,
  AgentTeamArchiveMemberRequest,
  AgentTeamArchiveMemberResult,
  AgentTeamProjectOwnerRequest,
  AgentTeamProjectOwnerResult,
  AgentTeamProjectRef,
  AgentTeamClientMemberStatus,
  AgentTeamCreateProjectRequest,
  AgentTeamCreateProjectResult,
  AgentTeamInbox,
  AgentTeamInboxRequest,
  AgentTeamJoinWorkspaceRequest,
  AgentTeamJoinWorkspaceResult,
  AgentTeamLeaveWorkspaceRequest,
  AgentTeamLeaveWorkspaceResult,
  AgentTeamGetAttachmentRequest,
  AgentTeamGetAttachmentResult,
  AgentTeamPutAttachmentRequest,
  AgentTeamPutAttachmentResult,
  AgentTeamMemberResult,
  AgentTeamAddMemberResult,
  AgentTeamRecoverMemberRequest,
  AgentTeamRecoverMemberResult,
  AgentTeamMembersRequest,
  AgentTeamReplyRequest,
  AgentTeamResolveTaskRefsRequest,
  AgentTeamResolveTaskRefsResult,
  AgentTeamResolveMessageRefsRequest,
  AgentTeamResolveMessageRefsResult,
  AgentTeamResolveThreadRefsRequest,
  AgentTeamResolveThreadRefsResult,
  AgentTeamReplyResult,
  AgentTeamThreadHistory,
  AgentTeamThreadHistoryRequest,
  AgentTeamThreadObservations,
  AgentTeamThreadObservationsRequest,
  AgentTeamThreadReadRequest,
  AgentTeamThreadReadResult,
  AgentTeamPromoteThreadRequest,
  AgentTeamPromoteThreadResult,
  AgentTeamTaskRequest,
  AgentTeamTaskResult,
  AgentTeamStartThreadRequest,
  AgentTeamStartThreadResult,
  AgentTeamPostMainMessageRequest,
  AgentTeamPostMainMessageResult,
  AgentTeamMainStreamReadRequest,
  AgentTeamMainStreamReadResult,
  AgentTeamMainStreamHistoryRequest,
  AgentTeamMainStreamHistory,
  AgentTeamUpdateProjectRequest,
  AgentTeamUpdateProjectResult,
  AgentTeamUpdateMemberRequest,
  AgentTeamView,
  AgentTeamViewRequest,
} from '@contexera/dsh-agent-team/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { TeamNavigationActions, TeamNavigationSnapshot } from './navigation.ts'
import type { TeamChangeListener, TeamChangeScope } from './team-changes.ts'
import type { TeamDraftStore } from './drafts.ts'
import type { TeamHumanIdentitySource } from './human-identity.ts'

export interface TeamNavigationSource {
  getSnapshot: () => TeamNavigationSnapshot
  subscribe: (listener: () => void) => () => void
}

/** Subscribe to one projection scope's invalidation stream; disposal aborts the shared poll. */
export type SubscribeTeamChanges = (scope: TeamChangeScope, listener: TeamChangeListener) => () => void

export interface TeamModelEffortOption {
  readonly id: string
  readonly name: string
}

export interface TeamModelOption {
  readonly id: string
  readonly name: string
  /** Selectable reasoning levels when the adapter exposes them. */
  readonly reasoning?: {
    readonly efforts: readonly TeamModelEffortOption[]
  }
}

export interface TeamModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly TeamModelOption[]
}

/** Host-scoped catalog load result; per-provider listing failures ride `failures`. */
export interface TeamModelCatalog {
  readonly groups: readonly TeamModelProviderGroup[]
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
}

export type TeamSidebarProps = PropsRuntime<'sidebar.workspaces'>
  & PropsLocale<'team'>
  & TeamNavigationActions
  & {
    navigation: TeamNavigationSource
    loadMembers: (request: AgentTeamMembersRequest) => Promise<RemoteResult<readonly AgentTeamClientMemberStatus[]>>
    /** Human direct-only Inbox slice; the badge sums each visible Workspace's total. */
    loadInbox: (request: AgentTeamInboxRequest) => Promise<RemoteResult<AgentTeamInbox>>
    /** Fired after every committed durable Thread read; the badge refreshes without waiting for a changes wake. */
    subscribeReads: (listener: () => void) => () => void
    subscribeChanges: SubscribeTeamChanges
    addMember: (request: AgentTeamAddMemberRequest) => Promise<RemoteResult<AgentTeamAddMemberResult>>
    loadProjects: (request: AgentTeamViewRequest) => Promise<RemoteResult<AgentTeamView>>
    createProject: (request: AgentTeamCreateProjectRequest) => Promise<RemoteResult<AgentTeamCreateProjectResult>>
    updateProject: (request: AgentTeamUpdateProjectRequest) => Promise<RemoteResult<AgentTeamUpdateProjectResult>>
    archiveProject: (request: AgentTeamArchiveProjectRequest) => Promise<RemoteResult<AgentTeamArchiveProjectResult>>
    addProjectOwner: (request: AgentTeamProjectOwnerRequest) => Promise<RemoteResult<AgentTeamProjectOwnerResult>>
    removeProjectOwner: (request: AgentTeamProjectOwnerRequest) => Promise<RemoteResult<AgentTeamProjectOwnerResult>>
    humanIdentity: TeamHumanIdentitySource
    updateMember: (request: AgentTeamUpdateMemberRequest) => Promise<RemoteResult<AgentTeamMemberResult>>
    recoverMember: (request: AgentTeamRecoverMemberRequest) => Promise<RemoteResult<AgentTeamRecoverMemberResult>>
    archiveMember: (request: AgentTeamArchiveMemberRequest) => Promise<RemoteResult<AgentTeamArchiveMemberResult>>
    joinWorkspace: (request: AgentTeamJoinWorkspaceRequest) => Promise<RemoteResult<AgentTeamJoinWorkspaceResult>>
    leaveWorkspace: (request: AgentTeamLeaveWorkspaceRequest) => Promise<RemoteResult<AgentTeamLeaveWorkspaceResult>>
    /** Session-independent Host model catalog (`llm.models`); needs no live Member. */
    loadModels: () => Promise<RemoteResult<TeamModelCatalog>>
    openMemberSession: (sessionId: AgentTeamClientMemberStatus['member']['sessionId'], reportFailure?: (message: string) => void) => void
    selectedProjectRef?: AgentTeamProjectRef
  }

export type TeamConversationProps = PropsRuntime<'main'> & PropsLocale<'team'> & TeamNavigationActions & {
  navigation: TeamNavigationSource
  drafts: TeamDraftStore
  /** The Human's own identity: the display name and avatar every seat that names or draws them reads. */
  humanIdentity: TeamHumanIdentitySource
  loadProjects: (request: AgentTeamViewRequest) => Promise<RemoteResult<AgentTeamView>>
  readThread: (request: AgentTeamThreadReadRequest) => Promise<RemoteResult<AgentTeamThreadReadResult>>
  loadThreadHistory: (request: AgentTeamThreadHistoryRequest) => Promise<RemoteResult<AgentTeamThreadHistory>>
  subscribeChanges: SubscribeTeamChanges
  putAttachment: (request: AgentTeamPutAttachmentRequest) => Promise<RemoteResult<AgentTeamPutAttachmentResult>>
  getAttachment: (request: AgentTeamGetAttachmentRequest) => Promise<RemoteResult<AgentTeamGetAttachmentResult>>
  /** Main stream: post, read, page, and start Threads (owners only). */
  postMainMessage: (request: AgentTeamPostMainMessageRequest) => Promise<RemoteResult<AgentTeamPostMainMessageResult>>
  startThread: (request: AgentTeamStartThreadRequest) => Promise<RemoteResult<AgentTeamStartThreadResult>>
  readMainStream: (request: AgentTeamMainStreamReadRequest) => Promise<RemoteResult<AgentTeamMainStreamReadResult>>
  mainStreamHistory: (request: AgentTeamMainStreamHistoryRequest) => Promise<RemoteResult<AgentTeamMainStreamHistory>>
  reply: (request: AgentTeamReplyRequest) => Promise<RemoteResult<AgentTeamReplyResult>>
  changeTask: (request: AgentTeamTaskRequest) => Promise<RemoteResult<AgentTeamTaskResult>>
  promoteThread: (request: AgentTeamPromoteThreadRequest) => Promise<RemoteResult<AgentTeamPromoteThreadResult>>
  resolveTaskRefs: (request: AgentTeamResolveTaskRefsRequest) => Promise<RemoteResult<AgentTeamResolveTaskRefsResult>>
  resolveThreadRefs: (request: AgentTeamResolveThreadRefsRequest) => Promise<RemoteResult<AgentTeamResolveThreadRefsResult>>
  /** Read-only reply-parent lookup; the Thread face fills its quote blocks from it. */
  resolveMessageRefs: (request: AgentTeamResolveMessageRefsRequest) => Promise<RemoteResult<AgentTeamResolveMessageRefsResult>>
  loadMembers: (request: AgentTeamMembersRequest) => Promise<RemoteResult<readonly AgentTeamClientMemberStatus[]>>
  /** Human direct-only Inbox slice; the Inbox page merges one call per visible Workspace. */
  loadInbox: (request: AgentTeamInboxRequest) => Promise<RemoteResult<AgentTeamInbox>>
  /** Human-only Thread Attention observations; the Thread composer ranks the returned followers first. */
  threadObservations: (request: AgentTeamThreadObservationsRequest) => Promise<RemoteResult<AgentTeamThreadObservations>>
  /** Agent-card session jump, shared by every slot; message member chips reuse it. */
  openMemberSession: (sessionId: AgentTeamClientMemberStatus['member']['sessionId'], reportFailure?: (message: string) => void) => void
}
