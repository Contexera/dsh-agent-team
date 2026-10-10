import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AgentTeamAddMemberRequest,
  AgentTeamArchiveChannelRequest,
  AgentTeamArchiveChannelResult,
  AgentTeamArchiveMemberRequest,
  AgentTeamArchiveMemberResult,
  AgentTeamChannelRef,
  AgentTeamClientMemberStatus,
  AgentTeamClearMemberContextRequest,
  AgentTeamClearMemberContextResult,
  AgentTeamCreateChannelRequest,
  AgentTeamCreateChannelResult,
  AgentTeamInbox,
  AgentTeamInboxRequest,
  AgentTeamJoinWorkspaceRequest,
  AgentTeamJoinWorkspaceResult,
  AgentTeamLeaveWorkspaceRequest,
  AgentTeamLeaveWorkspaceResult,
  AgentTeamJoinChannelRequest,
  AgentTeamJoinChannelResult,
  AgentTeamGetAttachmentRequest,
  AgentTeamGetAttachmentResult,
  AgentTeamPutAttachmentRequest,
  AgentTeamPutAttachmentResult,
  AgentTeamMemberResult,
  AgentTeamAddMemberResult,
  AgentTeamRecoverMemberRequest,
  AgentTeamRecoverMemberResult,
  AgentTeamMembersRequest,
  AgentTeamRemoveChannelMemberRequest,
  AgentTeamRemoveChannelMemberResult,
  AgentTeamReplyRequest,
  AgentTeamResolveTaskRefsRequest,
  AgentTeamResolveTaskRefsResult,
  AgentTeamResolveThreadRefsRequest,
  AgentTeamResolveThreadRefsResult,
  AgentTeamReplyResult,
  AgentTeamConfirmationRequired,
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
  AgentTeamSendMessageRequest,
  AgentTeamSendMessageResult,
  AgentTeamUpdateChannelRequest,
  AgentTeamUpdateChannelResult,
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

/** One adapter-owned selectable reasoning effort of one model route. */
export interface TeamModelEffortOption {
  readonly id: string
  readonly name: string
}

/** One selectable model row inside one provider group of the Host catalog. */
export interface TeamModelOption {
  readonly id: string
  readonly name: string
  /** Selectable reasoning levels when the adapter exposes them. */
  readonly reasoning?: {
    readonly efforts: readonly TeamModelEffortOption[]
  }
}

/** Provider-grouped slice of the Host model catalog the editors render. */
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
    loadChannels: (request: AgentTeamViewRequest) => Promise<RemoteResult<AgentTeamView>>
    createChannel: (request: AgentTeamCreateChannelRequest) => Promise<RemoteResult<AgentTeamCreateChannelResult>>
    updateChannel: (request: AgentTeamUpdateChannelRequest) => Promise<RemoteResult<AgentTeamUpdateChannelResult>>
    archiveChannel: (request: AgentTeamArchiveChannelRequest) => Promise<RemoteResult<AgentTeamArchiveChannelResult>>
    updateMember: (request: AgentTeamUpdateMemberRequest) => Promise<RemoteResult<AgentTeamMemberResult>>
    recoverMember: (request: AgentTeamRecoverMemberRequest) => Promise<RemoteResult<AgentTeamRecoverMemberResult>>
    /**
     * Host clear-context remote kept as a hidden migration escape hatch.
     * The visible row action is retired: Members manage their own context
     * through the context_rollover tool (see docs/architecture/README.md).
     */
    clearMemberContext: (request: AgentTeamClearMemberContextRequest) => Promise<RemoteResult<AgentTeamClearMemberContextResult>>
    archiveMember: (request: AgentTeamArchiveMemberRequest) => Promise<RemoteResult<AgentTeamArchiveMemberResult>>
    joinWorkspace: (request: AgentTeamJoinWorkspaceRequest) => Promise<RemoteResult<AgentTeamJoinWorkspaceResult>>
    leaveWorkspace: (request: AgentTeamLeaveWorkspaceRequest) => Promise<RemoteResult<AgentTeamLeaveWorkspaceResult>>
    joinChannel: (request: AgentTeamJoinChannelRequest) => Promise<RemoteResult<AgentTeamJoinChannelResult>>
    removeChannelMember: (request: AgentTeamRemoveChannelMemberRequest) => Promise<RemoteResult<AgentTeamRemoveChannelMemberResult>>
    /** Session-independent Host model catalog (`llm.models`); needs no live Member. */
    loadModels: () => Promise<RemoteResult<TeamModelCatalog>>
    /** Embed the Member's Session conversation in the Team conversation seat. */
    openMemberSession: (sessionId: AgentTeamClientMemberStatus['member']['sessionId'], reportFailure?: (message: string) => void) => void
    selectedChannelRef?: AgentTeamChannelRef
  }

export type TeamConversationProps = PropsRuntime<'main'> & PropsLocale<'team'> & TeamNavigationActions & {
  navigation: TeamNavigationSource
  /** Keyed composer draft cache; one store per Client context. */
  drafts: TeamDraftStore
  /** The Human's own identity: the display name and avatar every seat that names or draws them reads. */
  humanIdentity: TeamHumanIdentitySource
  loadChannels: (request: AgentTeamViewRequest) => Promise<RemoteResult<AgentTeamView>>
  readThread: (request: AgentTeamThreadReadRequest) => Promise<RemoteResult<AgentTeamThreadReadResult>>
  loadThreadHistory: (request: AgentTeamThreadHistoryRequest) => Promise<RemoteResult<AgentTeamThreadHistory>>
  subscribeChanges: SubscribeTeamChanges
  putAttachment: (request: AgentTeamPutAttachmentRequest) => Promise<RemoteResult<AgentTeamPutAttachmentResult>>
  getAttachment: (request: AgentTeamGetAttachmentRequest) => Promise<RemoteResult<AgentTeamGetAttachmentResult>>
  sendMessage: (request: AgentTeamSendMessageRequest) => Promise<RemoteResult<AgentTeamSendMessageResult>>
  joinChannel: (request: AgentTeamJoinChannelRequest) => Promise<RemoteResult<AgentTeamJoinChannelResult>>
  removeChannelMember: (request: AgentTeamRemoveChannelMemberRequest) => Promise<RemoteResult<AgentTeamRemoveChannelMemberResult>>
  reply: (request: AgentTeamReplyRequest) => Promise<RemoteResult<AgentTeamReplyResult | AgentTeamConfirmationRequired>>
  changeTask: (request: AgentTeamTaskRequest) => Promise<RemoteResult<AgentTeamTaskResult>>
  promoteThread: (request: AgentTeamPromoteThreadRequest) => Promise<RemoteResult<AgentTeamPromoteThreadResult>>
  resolveTaskRefs: (request: AgentTeamResolveTaskRefsRequest) => Promise<RemoteResult<AgentTeamResolveTaskRefsResult>>
  resolveThreadRefs: (request: AgentTeamResolveThreadRefsRequest) => Promise<RemoteResult<AgentTeamResolveThreadRefsResult>>
  loadMembers: (request: AgentTeamMembersRequest) => Promise<RemoteResult<readonly AgentTeamClientMemberStatus[]>>
  /** Human direct-only Inbox slice; the Inbox page merges one call per visible Workspace. */
  loadInbox: (request: AgentTeamInboxRequest) => Promise<RemoteResult<AgentTeamInbox>>
  /** Human-only Thread Attention observations; the Thread composer ranks the returned followers first. */
  threadObservations: (request: AgentTeamThreadObservationsRequest) => Promise<RemoteResult<AgentTeamThreadObservations>>
  /** Agent-card session jump, shared by every slot; message member chips reuse it. */
  openMemberSession: (sessionId: AgentTeamClientMemberStatus['member']['sessionId'], reportFailure?: (message: string) => void) => void
}

export type TeamSettingsProps = PropsRuntime<'sidebar.settings'> & PropsLocale<'team'> & TeamNavigationActions & {
  loadMemberGroups: () => Promise<readonly TeamMemberGroup[]>
}

export interface TeamMemberGroup {
  readonly workspaceId: string
  readonly workspaceTitle: string
  readonly members: readonly AgentTeamClientMemberStatus[]
}
