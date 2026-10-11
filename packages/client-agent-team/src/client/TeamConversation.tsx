import { useSyncExternalStore } from 'react'
import type { TeamConversationProps } from './slots.ts'
import { useHumanIdentity } from './human-identity.ts'
import { TeamChannelPage } from './TeamChannelPage.tsx'
import { TeamInboxPage } from './TeamInboxPage.tsx'
import { TeamThreadPage } from './TeamThreadPage.tsx'
import css from './conversation.module.css'

export function TeamConversation({ t, useWorkspaces, navigation, drafts, humanIdentity, putAttachment, getAttachment, loadChannels, readThread, loadThreadHistory, threadObservations, subscribeChanges, loadMembers, loadInbox, sendMessage, joinChannel, removeChannelMember, reply, changeTask, promoteThread, selectThread, selectChannel, selectWorkspace, backToWorkspace, backToChannels, resolveTaskRefs, resolveThreadRefs, resolveMessageRefs, openMemberSession }: TeamConversationProps) {
  const navigationState = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
  // Every seat names and draws the Human from this one projection: the
  // localized fallback stands only until the first profile read lands.
  const identity = useHumanIdentity(humanIdentity)
  const humanName = identity.name ?? t('human')
  const workspaces = useWorkspaces(state => state.items)
  const current = workspaces.find(workspace => workspace.workspaceId === navigationState.workspaceId)
  if (navigationState.inbox === true) {
    // The Inbox page is global: it merges every visible Workspace and needs no
    // selected Workspace. Selecting Inbox clears the Channel/Thread faces, so
    // this face owns the seat while the flag stands. The Human identity rides
    // along for the same reason it rides on the other two faces: a row that
    // names or draws the reader must draw the one identity every seat draws.
    return <TeamInboxPage key="inbox" useWorkspaces={useWorkspaces} loadInbox={loadInbox} subscribeChanges={subscribeChanges} selectWorkspace={selectWorkspace} selectThread={selectThread} humanName={humanName} {...(identity.avatarUrl === undefined ? {} : { humanAvatarUrl: identity.avatarUrl })} t={t} />
  }
  if (current !== undefined && navigationState.threadRef !== undefined) {
    return <TeamThreadPage key={navigationState.threadRef} humanName={humanName} resolveMessageRefs={resolveMessageRefs} {...(identity.avatarUrl === undefined ? {} : { humanAvatarUrl: identity.avatarUrl })} workspaceId={current.workspaceId} putAttachment={putAttachment} threadRef={navigationState.threadRef} backToWorkspace={backToWorkspace} selectChannel={selectChannel} selectThread={selectThread} resolveTaskRefs={resolveTaskRefs} resolveThreadRefs={resolveThreadRefs} openMemberSession={openMemberSession} {...(navigationState.channelRef === undefined ? {} : { channelRef: navigationState.channelRef })} {...(navigationState.taskRef === undefined ? {} : { taskRef: navigationState.taskRef })} {...(navigationState.taskNumber === undefined ? {} : { taskNumber: navigationState.taskNumber })} drafts={drafts} getAttachment={getAttachment} readThread={readThread} loadChannels={loadChannels} loadThreadHistory={loadThreadHistory} threadObservations={threadObservations} subscribeChanges={subscribeChanges} loadMembers={loadMembers} reply={reply} changeTask={changeTask} promoteThread={promoteThread} t={t} />
  }
  if (current !== undefined && navigationState.channelRef !== undefined) {
    return <TeamChannelPage key={navigationState.channelRef} humanName={humanName} {...(identity.avatarUrl === undefined ? {} : { humanAvatarUrl: identity.avatarUrl })} workspaceId={current.workspaceId} channelRef={navigationState.channelRef} drafts={drafts} putAttachment={putAttachment} getAttachment={getAttachment} loadChannels={loadChannels} subscribeChanges={subscribeChanges} loadMembers={loadMembers} loadInbox={loadInbox} sendMessage={sendMessage} joinChannel={joinChannel} removeChannelMember={removeChannelMember} selectThread={selectThread} selectChannel={selectChannel} backToChannels={backToChannels} resolveTaskRefs={resolveTaskRefs} resolveThreadRefs={resolveThreadRefs} openMemberSession={openMemberSession} t={t} />
  }
  const welcome = current === undefined
    ? { eyebrow: t('teamMode'), title: t('team'), body: t('empty') }
    : { eyebrow: current.title, title: t('channels'), body: t('selectChannelHint') }
  return <main className={css.welcomeSurface} data-team-conversation>
    <div className={css.welcome}>
      <span className={css.welcomeEyebrow}>{welcome.eyebrow}</span>
      <h1>{welcome.title}</h1>
      <p>{welcome.body}</p>
    </div>
  </main>
}
