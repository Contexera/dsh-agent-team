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
  AgentTeamJoinChannelRequest,
  AgentTeamMembersRequest,
  AgentTeamPromoteThreadRequest,
  AgentTeamPutAttachmentRequest,
  AgentTeamRecoverMemberRequest,
  AgentTeamClearMemberContextRequest,
  AgentTeamRemoveChannelMemberRequest,
  AgentTeamReplyRequest,
  AgentTeamResolveTaskRefsRequest,
  AgentTeamResolveThreadRefsRequest,
  AgentTeamTaskRequest,
  AgentTeamUpdateChannelRequest,
  AgentTeamUpdateMemberRequest,
  AgentTeamViewRequest,
} from '@wowyuarm/dsh-agent-team/types'
import agentTeamRemote from '@wowyuarm/dsh-agent-team/remote'
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
import { HumanSettingsSection } from './HumanSettingsSection.tsx'
import { ContextJudgeSettingsSection } from './ContextJudgeSettingsSection.tsx'
import { TeamContextJudgeCheck } from './context-judge.ts'
import { TeamContextGateForm, type TeamGateSection } from './context-gate-form.ts'
import { TeamHumanIdentity } from './human-identity.ts'
import { TeamEnvironmentCheck } from './environment-check.ts'
import { bytesToBase64 } from './attachment-preview.ts'
import { TeamNavigation } from './navigation.ts'
import { TeamChangeStream, TeamReadStream, type TeamChangeListener, type TeamChangeScope } from './team-changes.ts'
import { TeamDraftStore } from './drafts.ts'
import { TeamFooterAction } from './TeamFooterAction.tsx'
import { TeamMembersAction } from './TeamMembersAction.tsx'
import { TeamConversation } from './TeamConversation.tsx'
import { TeamWorkspaceBrowser } from './TeamWorkspaceBrowser.tsx'
import { en, zh, type TeamKey } from './locales.ts'

export type { TeamMode, TeamNavigationActions, TeamNavigationSnapshot } from './navigation.ts'
export type { TeamKey } from './locales.ts'
export { TeamNavigation } from './navigation.ts'

const NS = 'team'

/**
 * The Team Host row's settings namespace. Spelled here rather than imported,
 * because a client package must not depend on a Host package — the profile, the
 * judge's endpoint, and the gate's thresholds all live in this one row section,
 * and each settings page renders only the group it owns.
 */
const TEAM_SETTINGS_NS = 'wowyuarm-agent-team-host'

export const inject = [
  'slots', 'workspaces', 'layout', 'locale', 'remote', 'remote.session', 'sessions', 'connection', 'conversation', 'uiWorkspace',
]

/**
 * 0.1.7 moved the conversation selection into the workspace service: the
 * rendered session is the one holding its `mainView` reference (the shipped
 * consumers read the same projection), so the Team client reads the selection
 * through retention instead of a service-owned `current`.
 */
function currentMainSessionId(ctx: ClientContext): AgentTeamClientMemberStatus['member']['sessionId'] | undefined {
  const sessions = ctx.sessions as unknown as ISessions
  return Object.values(sessions.list.getSnapshot().byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

/**
 * Session ids this client opened as Member views, per client instance. The
 * 0.1.7 workspace service exposes no clear, so a dead return target leaves
 * the departed Member selection in place; excluding Member sessions from the
 * next capture keeps that stale selection from becoming a false return
 * target.
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
  }
}

function registerModeShadow<T extends object>(
  ctx: ClientContext,
  navigation: TeamNavigation,
  changes: TeamChangeStream,
  reads: TeamReadStream,
  drafts: TeamDraftStore,
  humanIdentity: TeamHumanIdentity,
  name: 'sidebar.workspaces' | 'main' | 'sidebar.settings',
  component: T,
  extraInject?: () => Record<string, unknown>,
  // Keyed seats (`main`) address one panel by key; the reserved 'conversation'
  // key is where the shipped Conversation registers, so the Team seat shadows
  // that same panel instead of adding a second one.
  entryKey?: string,
): void {
  // Stay in Team mode: the conversation shadow stands down for Member Session
  // views (see registerModeShadow), so the shipped conversation root renders
  // the selected Member Session inside the Team shell.
  const openMemberSessionImpl = (sessionId: AgentTeamClientMemberStatus['member']['sessionId']): void => {
    const snapshot = navigation.getSnapshot()
    const current = currentMainSessionId(ctx)
    // The return target is captured on first entry only — switching between
    // Member Sessions must keep pointing at the Human's original session.
    const memberSessions = openedMemberSessions.get(ctx) ?? new Set<string>()
    openedMemberSessions.set(ctx, memberSessions)
    memberSessions.add(sessionId)
    const returnTo = snapshot.memberSessionId === undefined && current !== undefined && current !== sessionId && !memberSessions.has(current) ? current : undefined
    navigation.actions().enterMemberSession(sessionId, returnTo)
    ctx.uiWorkspace.openSession(sessionId)
  }
  // Remote bindings shared by every Team slot; surface-specific entries extend it below.
  const sharedRemotes = {
    loadChannels: (request: AgentTeamViewRequest) => ctx.remote.agentTeam.view(request),
    loadInbox: (request: AgentTeamInboxRequest) => ctx.remote.agentTeam.inbox(request),
    subscribeReads: (listener: () => void) => reads.subscribe(listener),
    subscribeChanges: (scope: TeamChangeScope, listener: TeamChangeListener) => changes.subscribe(scope, listener),
    drafts,
    humanIdentity,
    loadMembers: (request: AgentTeamMembersRequest) => ctx.remote.agentTeam.members(request),
    joinChannel: (request: AgentTeamJoinChannelRequest) => ctx.remote.agentTeam.joinChannel(request),
    removeChannelMember: (request: AgentTeamRemoveChannelMemberRequest) => ctx.remote.agentTeam.removeChannelMember(request),
    updateChannel: (request: AgentTeamUpdateChannelRequest) => ctx.remote.agentTeam.updateChannel(request),
    archiveChannel: (request: AgentTeamArchiveChannelRequest) => ctx.remote.agentTeam.archiveChannel(request),
    updateMember: (request: AgentTeamUpdateMemberRequest) => ctx.remote.agentTeam.updateMember(request),
    recoverMember: (request: AgentTeamRecoverMemberRequest) => ctx.remote.agentTeam.recoverMember(request),
    clearMemberContext: (request: AgentTeamClearMemberContextRequest) => ctx.remote.agentTeam.clearMemberContext(request),
    archiveMember: (request: AgentTeamArchiveMemberRequest) => ctx.remote.agentTeam.archiveMember(request),
    joinWorkspace: (request: AgentTeamJoinWorkspaceRequest) => ctx.remote.agentTeam.joinWorkspace(request),
    leaveWorkspace: (request: AgentTeamLeaveWorkspaceRequest) => ctx.remote.agentTeam.leaveWorkspace(request),
    // The Host-scoped catalog needs no live Member, so suspended ones stay editable too.
    loadModels: () => ctx.remote.session.modelCatalog(),
    openMemberSession: openMemberSessionImpl,
  }
  ctx.slots.inject(name, () => {
    let dispose: (() => void) | undefined
    const reconcile = (): void => {
      const snapshot = navigation.getSnapshot()
      // The main panel seat yields to the shipped conversation root while a
      // Member Session view is embedded; both sidebar seats stay shadowed so
      // the Team chrome keeps working around the Member conversation.
      const active = snapshot.mode === 'team' && !(name === 'main' && snapshot.memberSessionId !== undefined)
      if (active && dispose === undefined) {
        dispose = ctx.slots.register({
          name,
          ...(entryKey === undefined ? {} : { key: entryKey }),
          priority: -100,
          locale: NS,
          inject: () => ({
            navigation,
            ...extraInject?.(),
            ...navigation.actions(),
            ...sharedRemotes,
            ...(name === 'main' ? {
              // A committed durable read consumes this reader's mention
              // markers; the Host's changes stream never wakes on reads, so
              // the Human's badge refreshes from the completed read itself.
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
            } : {}),
            ...(name === 'sidebar.workspaces' ? {
              addMember: (request: AgentTeamAddMemberRequest) => ctx.remote.agentTeam.addMember(request),
              createChannel: (request: AgentTeamCreateChannelRequest) => ctx.remote.agentTeam.createChannel(request),
            } : {}),
          }),
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
  // The Human's own identity: one projection every seat reads, refreshed once
  // after a profile write so a rename reaches the timeline and the member refs
  // without a reload. Reads are demand-driven — the first seat that subscribes
  // starts the read. The profile page writes back through the Team Remote, so
  // the Client never names the Host's own profile entry.
  const humanIdentity = new TeamHumanIdentity({
    loadProfile: () => ctx.remote.agentTeam.humanProfile({}),
    loadAvatarUrl: async (avatarRef: string) => {
      // Avatar bytes ride the dedicated avatar Remote (never the TTL-bound
      // attachment cache); a data URL is what an `<img>` seat can show directly.
      const result = await ctx.remote.agentTeam.getHumanAvatar({ avatarRef })
      if (!result.ok || !result.value.mediaType.startsWith('image/')) return null
      return `data:${result.value.mediaType};base64,${result.value.bytesBase64}`
    },
  })
  // The local environment check: a fact about this installation rather than
  // about the Human, so it is its own projection and never a field of the
  // identity above. Read once, on the first subscriber, and never written back.
  const environment = new TeamEnvironmentCheck({
    loadEnvironment: () => ctx.remote.agentTeam.environment({}),
  })
  // The long-gap gate's judge: what the Host answers about reachability, and
  // the thresholds in force. Its own projection rather than a field of the
  // environment check, because it re-reads after every write that can mount or
  // unmount the judge while the environment verdict is settled once.
  const contextJudge = new TeamContextJudgeCheck({
    loadContextJudge: () => ctx.remote.agentTeam.contextJudge({}),
  })
  ctx.effect(() => () => {
    navigation.dispose()
    drafts.dispose()
    humanIdentity.dispose()
    environment.dispose()
    contextJudge.dispose()
    void disposeNavigation()
    void disposeDrafts()
  }, 'agent-team: navigation service')

  // The one restore owner: leaving an embedded Member Session view must
  // rebind the underlying selection, or the departed Member session stays the
  // workspace service's `mainView` retention into the next Member entry's
  // return-target capture. Takeover is conditional — only when the selection
  // still IS the departed Member session — so a selection someone else made
  // in the meantime survives. A dead return target keeps the departed
  // selection: 0.1.7 exposes no public clear, and the retention is inert
  // behind the Team seat until the next open.
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
    }
    const unsubscribe = navigation.subscribe(restore)
    return () => {
      unsubscribe()
      restore()
    }
  }, 'agent-team: member session restore')

  // The shell renders one keyed main panel at a time — `activePanelId ?? 'conversation'`
  // — so a shipped global panel (the plugin manager) stays on screen after Team mode is
  // entered, and every Team destination then opens behind it: the sidebar moves while the
  // column keeps rendering the foreign page. Team mode owns the conversation seat, so
  // entering it, or navigating inside it, hands the column back to that seat. A null
  // selection — and every mode but Team, where panel choice belongs to the shipped
  // sidebar — is left untouched, so this never fights the shell's own selection.
  ctx.effect(() => {
    const releaseMainPanel = (): void => {
      if (navigation.getSnapshot().mode !== 'team') return
      if (ctx.layout.panelInfo.getSnapshot().activePanelId === null) return
      ctx.layout.selectPanel(null)
    }
    const unsubscribe = navigation.subscribe(releaseMainPanel)
    releaseMainPanel()
    return unsubscribe
  }, 'agent-team: main panel ownership')

  const changes = new TeamChangeStream(ctx.remote)
  ctx.effect(() => () => changes.dispose(), 'agent-team: change subscriptions')
  // The Harness resumes a live generation across reconnects, but a stream that
  // already ended for good is this layer's to rebuild — and a new Host generation
  // is the one moment the scope it was waiting for can be there again.
  ctx.on('connection/reset', () => { changes.recover() })
  const reads = new TeamReadStream()

  const loadMemberGroups = async () => {
    const workspaces = ctx.workspaces.list.getSnapshot().items
    const groups = await Promise.all(workspaces.map(async workspace => {
      const result = await ctx.remote.agentTeam.members({ workspaceId: workspace.workspaceId })
      if (!result.ok) throw new Error(result.error.message)
      // The members modal is a listing surface: archived Members are hidden
      // everywhere, and removed (inactive) ones never belong in a roster.
      const members = result.value.filter(status => status.member.state !== 'inactive' && status.member.state !== 'archived')
      return { workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, members }
    }))
    return groups.filter(group => group.members.length > 0)
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'agent-team',
    order: 100,
    locale: NS,
    inject: () => ({
      navigation,
      ...navigation.actions(),
      // The footer is the only surface that leaves Team mode; closing the
      // embedded Member Session view rebinds the underlying selection through
      // the same root-scope restore owner, so there is exactly one restore
      // path and no double open.
      leaveTeam: () => {
        navigation.actions().exitMemberSession()
        navigation.actions().leaveTeam()
      },
    }),
  }, TeamFooterAction as never))

  registerModeShadow(ctx, navigation, changes, reads, drafts, humanIdentity, 'sidebar.workspaces', TeamWorkspaceBrowser as never)
  registerModeShadow(ctx, navigation, changes, reads, drafts, humanIdentity, 'main', TeamConversation as never, undefined, 'conversation')
  registerModeShadow(ctx, navigation, changes, reads, drafts, humanIdentity, 'sidebar.settings', TeamMembersAction as never, () => ({ loadMemberGroups }))

  // The Human profile page: one settings section, ordered between General (0)
  // and Models (10) so identity sits near the top. Writes go through the Team
  // Remote, which answers with the Host's own rejection reason (a name
  // collides, an empty one), and the shared identity re-reads afterwards, so a
  // rename lands in the timeline and the member refs at the same moment the
  // page shows it.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'team-human',
    order: 5,
    label: () => ctx.locale.bind(NS)('humanSettingsNav'),
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
        // Bytes first, then the reference: a failed clear leaves a readable
        // avatar instead of a reference to bytes nobody can load.
        await ctx.remote.agentTeam.removeHumanAvatar({ avatarRef })
        const cleared = await ctx.remote.agentTeam.setHumanProfile({ avatarRef: null })
        if (!cleared.ok) return cleared.error.message
        await humanIdentity.refresh()
        return undefined
      },
    }),
  }, HumanSettingsSection as never))

  // The context gate's page, ordered right after the profile and before Models.
  // It follows the settings namespace rather than this plugin: the profile page
  // above owns that namespace's identity fields, this one owns the judge's
  // endpoint and the gate's thresholds, and neither renders the other's
  // controls — so a deployment that never composed the Team row shows no trace
  // of this page instead of an empty one. The form is built with the page and
  // released with it, because a registration that outlives its namespace would
  // hold drafts nothing could accept.
  ctx.inject(['configForms'], (scope: ClientContext) => {
    scope.effect(() => scope.configForms.whileServed([TEAM_SETTINGS_NS], () => {
      const form = new TeamContextGateForm(scope.configForms.get<TeamGateSection>(TEAM_SETTINGS_NS), contextJudge)
      const off = scope.slots.inject('settings.section', () => scope.slots.register({
        name: 'settings.section',
        id: 'team-context-gate',
        order: 6,
        label: () => ctx.locale.bind(NS)('contextGateNav'),
        locale: NS,
        inject: () => ({
          judge: contextJudge,
          form,
          // The key's literal never rides a response; the describe mirror is
          // what says whether one is stored.
          keyConfigured: (): boolean => scope.configForms.describe().getSnapshot().view?.namespaces
            .find(row => row.ns === TEAM_SETTINGS_NS)?.secrets
            .some(secret => secret.path.join('.') === 'jev.apiKey' && secret.set) ?? false,
        }),
      }, ContextJudgeSettingsSection as never))
      return () => {
        off()
        form.dispose()
      }
    }), 'agent-team: context gate settings')
  })
}

export async function apply(ctx: ClientContext): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(agentTeamRemote)
  ctx.effect(() => () => { void disposeRemote() }, 'agent-team: remote')
  ctx.inject(['remote.agentTeam'], ready => { applyUi(ready as ClientContext) })
}
