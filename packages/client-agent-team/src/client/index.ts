import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  AgentTeamAddMemberRequest,
  AgentTeamArchiveChannelRequest,
  AgentTeamArchiveMemberRequest,
  AgentTeamClientMemberStatus,
  AgentTeamInboxRequest,
  AgentTeamSendMessageRequest,
  AgentTeamThreadHistoryRequest,
  AgentTeamThreadObservationsRequest,
  AgentTeamThreadReadRequest,
  AgentTeamCreateChannelRequest,
  AgentTeamGetAttachmentRequest,
  AgentTeamJoinWorkspaceRequest,
  AgentTeamLeaveWorkspaceRequest,
  AgentTeamMembersRequest,
  AgentTeamPromoteThreadRequest,
  AgentTeamPutAttachmentRequest,
  AgentTeamRecoverMemberRequest,
  AgentTeamReplyRequest,
  AgentTeamResolveMessageRefsRequest,
  AgentTeamResolveTaskRefsRequest,
  AgentTeamResolveThreadRefsRequest,
  AgentTeamTaskRequest,
  AgentTeamUpdateChannelRequest,
  AgentTeamUpdateMemberRequest,
  AgentTeamViewRequest,
} from '@contexera/dsh-agent-team/types'
import agentTeamRemote from '@contexera/dsh-agent-team/remote'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { TeamSettingsSection } from './TeamSettingsSection.tsx'
import { TeamHumanIdentity } from './human-identity.ts'
import { TeamEnvironmentCheck } from './environment-check.ts'
import { bytesToBase64 } from './attachment-preview.ts'
import { TEAM_PANEL_ID, TeamNavigation } from './navigation.ts'
import { TeamChangeStream, TeamReadStream, type TeamChangeListener, type TeamChangeScope } from './team-changes.ts'
import { TeamQueries, coversWorkspaceScope, type TeamQueryIdentity, type WorkspaceScopeKind } from './team-queries.ts'
import { TeamDraftStore } from './drafts.ts'
import { TeamPanelIcon } from './TeamPanelIcon.tsx'
import { TeamConversation } from './TeamConversation.tsx'
import { TeamWorkspaceBrowser } from './TeamWorkspaceBrowser.tsx'
import { en, zh, type TeamKey } from './locales.ts'

export type { TeamMode, TeamNavigationActions, TeamNavigationSnapshot } from './navigation.ts'
export type { TeamKey } from './locales.ts'
export { TeamNavigation } from './navigation.ts'

const NS = 'team'

export const inject = [
  'slots', 'workspaces', 'layout', 'locale', 'remote', 'remote.session', 'sessions', 'connection', 'conversation', 'uiWorkspace',
]

/** The rendered session is the one holding its `mainView` reference, so the selection is read through retention. */
function currentMainSessionId(ctx: ClientContext): AgentTeamClientMemberStatus['member']['sessionId'] | undefined {
  const sessions = ctx.sessions as unknown as ISessions
  return Object.values(sessions.list.getSnapshot().byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

/**
 * Member session ids this client opened. The workspace service exposes no clear, so excluding them from the
 * next capture keeps a stale Member selection from becoming a false return target.
 */
const openedMemberSessions = new WeakMap<ClientContext, Set<string>>()

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    team: TeamKey
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    teamNavigation: TeamNavigation
    teamDrafts: TeamDraftStore
    teamQueries: TeamQueries
  }
}

/**
 * The main seat lives for the life of the client: a rail row can only select a panel whose main entry is live.
 * The mode follows the selection (see the ownership effect in `applyUi`).
 */
function registerTeamPanel(
  ctx: ClientContext,
  navigation: TeamNavigation,
  queries: TeamQueries,
  reads: TeamReadStream,
  drafts: TeamDraftStore,
  humanIdentity: TeamHumanIdentity,
): void {
  const sharedRemotes = teamSharedRemotes(ctx, navigation, queries, reads, drafts, humanIdentity)
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: TEAM_PANEL_ID,
    order: 20,
    label: () => ctx.locale.bind(NS)('team'),
    locale: NS,
  }, TeamPanelIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: TEAM_PANEL_ID,
    priority: -100,
    locale: NS,
    inject: () => teamSeatInject(ctx, navigation, reads, sharedRemotes, 'main'),
  }, TeamConversation as never))
}

/**
 * Embed a Member's Session in the conversation seat while staying in Team mode. The Team panel yields the column
 * first, or it would render the Team page over the Member conversation.
 */
function openMemberSessionImpl(
  ctx: ClientContext,
  navigation: TeamNavigation,
  sessionId: AgentTeamClientMemberStatus['member']['sessionId'],
  reportFailure?: (message: string) => void,
): void {
  const snapshot = navigation.getSnapshot()
  const current = currentMainSessionId(ctx)
  // Captured on first entry only, so switching between Member Sessions keeps the original return target.
  const memberSessions = openedMemberSessions.get(ctx) ?? new Set<string>()
  openedMemberSessions.set(ctx, memberSessions)
  memberSessions.add(sessionId)
  const returnTo = snapshot.memberSessionId === undefined && current !== undefined && current !== sessionId && !memberSessions.has(current) ? current : undefined
  navigation.actions().enterMemberSession(sessionId, returnTo)
  ctx.layout.selectPanel(null)
  // `openSession` is a synchronous void; a Session the catalog does not carry yet would fail silently,
  // so undo the navigation and let the caller report it.
  try {
    ctx.uiWorkspace.openSession(sessionId)
  } catch (cause) {
    if (snapshot.memberSessionId !== undefined) navigation.actions().enterMemberSession(snapshot.memberSessionId, undefined)
    else navigation.actions().exitMemberSession()
    reportFailure?.(cause instanceof Error ? cause.message : String(cause))
  }
}

const ROSTER_SCOPE_KINDS = ['presence', 'workspace'] as const satisfies readonly WorkspaceScopeKind[]

function membersQuery(request: AgentTeamMembersRequest): TeamQueryIdentity {
  return {
    key: `members:${request.workspaceId}`,
    covers: scope => ROSTER_SCOPE_KINDS.some(kind => coversWorkspaceScope(scope, request.workspaceId, kind)),
  }
}

/** Inbox data moves with any shared-projection commit (a mention can land in any Thread), so the scope-less stream is its home; presence wakes never reach it. */
function inboxQuery(request: AgentTeamInboxRequest): TeamQueryIdentity {
  return {
    key: `inbox:${request.workspaceId}:${request.limit ?? 'all'}`,
    covers: scope => scope === undefined
      || (scope.kind === 'workspace' && scope.workspaceId === request.workspaceId)
      || scope.kind === 'channel'
      || scope.kind === 'thread',
  }
}

function teamSharedRemotes(
  ctx: ClientContext,
  navigation: TeamNavigation,
  queries: TeamQueries,
  reads: TeamReadStream,
  drafts: TeamDraftStore,
  humanIdentity: TeamHumanIdentity,
): Record<string, unknown> {
  return {
    loadChannels: (request: AgentTeamViewRequest) => ctx.remote.agentTeam.view(request),
    loadInbox: (request: AgentTeamInboxRequest) => queries.read(inboxQuery(request), () => ctx.remote.agentTeam.inbox(request)),
    subscribeReads: (listener: () => void) => reads.subscribe(listener),
    subscribeChanges: (scope: TeamChangeScope, listener: TeamChangeListener) => queries.subscribeChanges(scope, listener),
    drafts,
    humanIdentity,
    loadMembers: (request: AgentTeamMembersRequest) => queries.read(membersQuery(request), () => ctx.remote.agentTeam.members(request)),
    updateChannel: (request: AgentTeamUpdateChannelRequest) => ctx.remote.agentTeam.updateChannel(request),
    archiveChannel: (request: AgentTeamArchiveChannelRequest) => ctx.remote.agentTeam.archiveChannel(request),
    updateMember: (request: AgentTeamUpdateMemberRequest) => ctx.remote.agentTeam.updateMember(request),
    recoverMember: (request: AgentTeamRecoverMemberRequest) => ctx.remote.agentTeam.recoverMember(request),
    archiveMember: (request: AgentTeamArchiveMemberRequest) => ctx.remote.agentTeam.archiveMember(request),
    joinWorkspace: (request: AgentTeamJoinWorkspaceRequest) => ctx.remote.agentTeam.joinWorkspace(request),
    leaveWorkspace: (request: AgentTeamLeaveWorkspaceRequest) => ctx.remote.agentTeam.leaveWorkspace(request),
    // The Host-scoped catalog needs no live Member, so suspended ones stay editable too.
    loadModels: () => ctx.remote.session.modelCatalog(),
    openMemberSession: (sessionId: AgentTeamClientMemberStatus['member']['sessionId'], reportFailure?: (message: string) => void) => {
      openMemberSessionImpl(ctx, navigation, sessionId, reportFailure)
    },
  }
}

/** `main` writes the conversation; the sidebar's browser seat writes the roster and Channels. */
function teamSeatInject(
  ctx: ClientContext,
  navigation: TeamNavigation,
  reads: TeamReadStream,
  sharedRemotes: Record<string, unknown>,
  name: 'sidebar.workspaces' | 'main',
): Record<string, unknown> {
  return {
    navigation,
    ...navigation.actions(),
    // The rail row is a destination: leaving Team mode also hands the column back to the conversation.
    leaveTeam: () => { navigation.actions().leaveTeamForConversation(() => { ctx.layout.selectPanel(null) }) },
    ...sharedRemotes,
    ...(name === 'main' ? {
      // A committed durable read consumes mention markers; the Host's changes stream never wakes on reads,
      // so refresh the badge from the read itself.
      readThread: async (request: AgentTeamThreadReadRequest) => {
        const result = await ctx.remote.agentTeam.readThread(request)
        if (result.ok) reads.bump()
        return result
      },
      loadThreadHistory: (request: AgentTeamThreadHistoryRequest) => ctx.remote.agentTeam.threadHistory(request),
      threadObservations: (request: AgentTeamThreadObservationsRequest) => ctx.remote.agentTeam.threadObservations(request),
      sendMessage: (request: AgentTeamSendMessageRequest) => ctx.remote.agentTeam.sendMessage(request),
      putAttachment: (request: AgentTeamPutAttachmentRequest) => ctx.remote.agentTeam.putAttachment(request),
      getAttachment: (request: AgentTeamGetAttachmentRequest) => ctx.remote.agentTeam.getAttachment(request),
      reply: (request: AgentTeamReplyRequest) => ctx.remote.agentTeam.reply(request),
      changeTask: (request: AgentTeamTaskRequest) => ctx.remote.agentTeam.changeTask(request),
      promoteThread: (request: AgentTeamPromoteThreadRequest) => ctx.remote.agentTeam.promoteThread(request),
      resolveTaskRefs: (request: AgentTeamResolveTaskRefsRequest) => ctx.remote.agentTeam.resolveTaskRefs(request),
      resolveThreadRefs: (request: AgentTeamResolveThreadRefsRequest) => ctx.remote.agentTeam.resolveThreadRefs(request),
      resolveMessageRefs: (request: AgentTeamResolveMessageRefsRequest) => ctx.remote.agentTeam.resolveMessageRefs(request),
    } : {}),
    ...(name === 'sidebar.workspaces' ? {
      addMember: (request: AgentTeamAddMemberRequest) => ctx.remote.agentTeam.addMember(request),
      createChannel: (request: AgentTeamCreateChannelRequest) => ctx.remote.agentTeam.createChannel(request),
    } : {}),
  }
}

function registerModeShadow<T extends object>(
  ctx: ClientContext,
  navigation: TeamNavigation,
  queries: TeamQueries,
  reads: TeamReadStream,
  drafts: TeamDraftStore,
  humanIdentity: TeamHumanIdentity,
  name: 'sidebar.workspaces' | 'main',
  component: T,
  // The reserved 'conversation' key is where the shipped Conversation registers, so the Team seat shadows that panel rather than adding one.
  entryKey?: string,
): void {
  const sharedRemotes = teamSharedRemotes(ctx, navigation, queries, reads, drafts, humanIdentity)
  ctx.slots.inject(name, () => {
    let dispose: (() => void) | undefined
    const reconcile = (): void => {
      const snapshot = navigation.getSnapshot()
      // The main seat yields to the shipped conversation root while a Member Session is embedded;
      // the browser seat stays shadowed so Team chrome keeps working.
      const active = snapshot.mode === 'team' && !(name === 'main' && snapshot.memberSessionId !== undefined)
      if (active && dispose === undefined) {
        dispose = ctx.slots.register({
          name,
          ...(entryKey === undefined ? {} : { key: entryKey }),
          priority: -100,
          locale: NS,
          inject: () => teamSeatInject(ctx, navigation, reads, sharedRemotes, name),
        } as never, component as never)
      } else if (!active && dispose !== undefined) {
        dispose()
        dispose = undefined
      }
    }
    const unsubscribe = navigation.subscribe(reconcile)
    reconcile()
    return () => {
      unsubscribe()
      dispose?.()
      dispose = undefined
    }
  })
}

function applyUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-team: dictionaries')

  const navigation = new TeamNavigation()
  const disposeNavigation = ctx.reflect.provide('teamNavigation', navigation)
  const drafts = new TeamDraftStore()
  const disposeDrafts = ctx.reflect.provide('teamDrafts', drafts)
  // One identity projection for every seat, re-read after a profile write. Reads are demand-driven: the first subscriber starts the read.
  const humanIdentity = new TeamHumanIdentity({
    loadProfile: () => ctx.remote.agentTeam.humanProfile({}),
    loadAvatarUrl: async (avatarRef: string) => {
      // Avatar bytes ride the avatar Remote, not the TTL-bound attachment cache; a data URL lets an `<img>` show them directly.
      const result = await ctx.remote.agentTeam.getHumanAvatar({ avatarRef })
      if (!result.ok || !result.value.mediaType.startsWith('image/')) return null
      return `data:${result.value.mediaType};base64,${result.value.bytesBase64}`
    },
  })
  // An installation fact, not part of the Human's identity. Read once on the first subscriber; never written back.
  const environment = new TeamEnvironmentCheck({
    loadEnvironment: () => ctx.remote.agentTeam.environment({}),
  })
  ctx.effect(() => () => {
    navigation.dispose()
    drafts.dispose()
    humanIdentity.dispose()
    environment.dispose()
    void disposeNavigation()
    void disposeDrafts()
  }, 'agent-team: navigation service')

  // Leaving an embedded Member Session view must rebind the selection, or the departed session stays retained as `mainView`.
  // Takeover is conditional so a selection made in the meantime survives; a dead return target keeps the departed
  // selection, as no public clear exists.
  ctx.effect(() => {
    let previous = navigation.getSnapshot()
    const restore = (): void => {
      const snapshot = navigation.getSnapshot()
      const departed = previous.memberSessionId
      const returnTo = previous.returnToSessionId
      previous = snapshot
      if (departed === undefined || snapshot.memberSessionId !== undefined) return
      if (currentMainSessionId(ctx) !== departed) return
      if (returnTo !== undefined && (ctx.sessions as unknown as ISessions).list.getSnapshot().byId[returnTo] !== undefined) ctx.uiWorkspace.openSession(returnTo)
      // The Member view cleared the panel to own the column; re-enter the panel the mode names.
      if (snapshot.mode === 'team' && ctx.layout.panelInfo.getSnapshot().activePanelId === null) ctx.layout.selectPanel(TEAM_PANEL_ID)
    }
    const unsubscribe = navigation.subscribe(restore)
    return () => {
      unsubscribe()
      restore()
    }
  }, 'agent-team: member session restore')

  const changes = new TeamChangeStream(ctx.remote)
  ctx.effect(() => () => changes.dispose(), 'agent-team: change subscriptions')
  // One owner for data reads: shares in-flight reads per query, folds changes into invalidations before consumers
  // re-read, and drops superseded responses.
  const queries = new TeamQueries(changes)
  const disposeQueries = ctx.reflect.provide('teamQueries', queries)
  ctx.effect(() => () => { void disposeQueries(); queries.dispose() }, 'agent-team: shared reads')
  // A stream that ended for good must be rebuilt here; a new Host generation also restarts the presence epoch,
  // so watermarks reset and in-flight reads stop being joinable.
  ctx.on('connection/reset', () => { changes.recover(); queries.newGeneration() })
  const reads = new TeamReadStream()

  registerTeamPanel(ctx, navigation, queries, reads, drafts, humanIdentity)

  registerModeShadow(ctx, navigation, queries, reads, drafts, humanIdentity, 'sidebar.workspaces', TeamWorkspaceBrowser as never)
  registerModeShadow(ctx, navigation, queries, reads, drafts, humanIdentity, 'main', TeamConversation as never, 'conversation')

  // Rail selection and Team mode are one fact: selecting the Team panel enters the mode, another panel leaves it.
  // A null selection is left alone, since a Member Session view clears the panel to own the column.
  ctx.effect(() => {
    const sync = (): void => {
      const active = ctx.layout.panelInfo.getSnapshot().activePanelId
      const snapshot = navigation.getSnapshot()
      if (active === TEAM_PANEL_ID) {
        if (snapshot.memberSessionId !== undefined) navigation.actions().exitMemberSession()
        if (snapshot.mode !== 'team') navigation.actions().enterTeam()
        return
      }
      if (active !== null && snapshot.mode === 'team') navigation.actions().leaveTeam()
    }
    const unsubscribe = ctx.layout.panelInfo.subscribe(sync)
    // A reload re-selects the panel the mode was left in, unless a restored Member Session view owns the column.
    const restored = navigation.getSnapshot()
    if (restored.mode === 'team' && restored.memberSessionId === undefined
      && ctx.layout.panelInfo.getSnapshot().activePanelId === null) ctx.layout.selectPanel(TEAM_PANEL_ID)
    sync()
    return unsubscribe
  }, 'agent-team: panel ownership')

  // The Team sidebar's CSS keys off this marker (the shell's New Session button stands down).
  ctx.effect(() => {
    const apply = (): void => {
      if (typeof document === 'undefined') return
      if (navigation.getSnapshot().mode === 'team') document.documentElement.dataset.agentTeamMode = 'team'
      else delete document.documentElement.dataset.agentTeamMode
    }
    const unsubscribe = navigation.subscribe(apply)
    apply()
    return () => {
      unsubscribe()
      if (typeof document !== 'undefined') delete document.documentElement.dataset.agentTeamMode
    }
  }, 'agent-team: mode marker')

  // Ordered between General (0) and Models (10). The Team Remote returns the Host's own rejection reason;
  // the shared identity re-reads afterwards.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'team-settings',
    order: 5,
    label: () => ctx.locale.bind(NS)('teamSettingsNav'),
    locale: NS,
    inject: () => ({
      identity: humanIdentity,
      environment,
      saveName: async (name: string) => {
        const saved = await ctx.remote.agentTeam.setHumanProfile({ name })
        if (!saved.ok) return saved.error.message
        await humanIdentity.refresh()
        return undefined
      },
      uploadAvatar: async (file: File) => {
        const put = await ctx.remote.agentTeam.putHumanAvatar({
          name: file.name,
          ...(file.type === '' ? {} : { mediaType: file.type }),
          bytesBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
        })
        if (!put.ok) return put.error.message
        const saved = await ctx.remote.agentTeam.setHumanProfile({ avatarRef: put.value.avatarRef })
        if (!saved.ok) return saved.error.message
        await humanIdentity.refresh()
        return undefined
      },
      removeAvatar: async () => {
        const { avatarRef } = humanIdentity.getSnapshot()
        if (avatarRef === undefined) return undefined
        // Bytes first: a failed clear leaves a readable avatar rather than a reference to unloadable bytes.
        await ctx.remote.agentTeam.removeHumanAvatar({ avatarRef })
        const cleared = await ctx.remote.agentTeam.setHumanProfile({ avatarRef: null })
        if (!cleared.ok) return cleared.error.message
        await humanIdentity.refresh()
        return undefined
      },
    }),
  }, TeamSettingsSection as never))
}

export async function apply(ctx: ClientContext): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(agentTeamRemote)
  ctx.effect(() => () => { void disposeRemote() }, 'agent-team: remote')
  ctx.inject(['remote.agentTeam'], ready => { applyUi(ready as ClientContext) })
}
