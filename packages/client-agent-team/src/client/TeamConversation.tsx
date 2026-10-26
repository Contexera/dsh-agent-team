import { useSyncExternalStore } from 'react'
import type { TeamConversationProps } from './slots.ts'
import { useHumanIdentity } from './human-identity.ts'
import { TeamProjectPage } from './TeamProjectPage.tsx'
import { TeamInboxPage } from './TeamInboxPage.tsx'
import { TeamTaskBoardPage } from './TeamTaskBoardPage.tsx'
import { TeamThreadPage } from './TeamThreadPage.tsx'
import css from './conversation.module.css'

export function TeamConversation({ t, useWorkspaces, navigation, drafts, humanIdentity, putAttachment, getAttachment, loadProjects, loadTaskBoard, readThread, loadThreadHistory, threadObservations, subscribeChanges, loadMembers, loadInbox, postMainMessage, startThread, readMainStream, mainStreamHistory, reply, changeAttention, transferTask, changeTask, promoteThread, selectThread, selectProject, selectWorkspace, backToWorkspace, resolveTaskRefs, resolveThreadRefs, resolveMessageRefs, openMemberSession }: TeamConversationProps) {
  const navigationState = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
  const identity = useHumanIdentity(humanIdentity)
  const humanName = identity.name ?? t('human')
  const workspaces = useWorkspaces(state => state.items)
  const current = workspaces.find(workspace => workspace.workspaceId === navigationState.workspaceId)
  if (navigationState.inbox === true) {
    // The Inbox page is global; selecting it clears the Project/Thread faces, so this face owns the seat while the flag stands.
    return <TeamInboxPage key="inbox" useWorkspaces={useWorkspaces} loadInbox={loadInbox} subscribeChanges={subscribeChanges} selectWorkspace={selectWorkspace} selectThread={selectThread} selectProject={selectProject} humanName={humanName} {...(identity.avatarUrl === undefined ? {} : { humanAvatarUrl: identity.avatarUrl })} t={t} />
  }
  if (navigationState.board === true) return <TeamTaskBoardPage useWorkspaces={useWorkspaces} loadTaskBoard={loadTaskBoard} subscribeChanges={subscribeChanges} selectWorkspace={selectWorkspace} selectThread={selectThread} t={t} />
  if (current !== undefined && navigationState.threadRef !== undefined) {
    return <TeamThreadPage key={navigationState.threadRef} humanName={humanName} resolveMessageRefs={resolveMessageRefs} {...(identity.avatarUrl === undefined ? {} : { humanAvatarUrl: identity.avatarUrl })} workspaceId={current.workspaceId} putAttachment={putAttachment} threadRef={navigationState.threadRef} backToWorkspace={backToWorkspace} selectProject={selectProject} selectThread={selectThread} resolveTaskRefs={resolveTaskRefs} resolveThreadRefs={resolveThreadRefs} openMemberSession={openMemberSession} {...(navigationState.projectRef === undefined ? {} : { projectRef: navigationState.projectRef })} {...(navigationState.taskRef === undefined ? {} : { taskRef: navigationState.taskRef })} {...(navigationState.taskNumber === undefined ? {} : { taskNumber: navigationState.taskNumber })} drafts={drafts} getAttachment={getAttachment} readThread={readThread} loadProjects={loadProjects} loadThreadHistory={loadThreadHistory} threadObservations={threadObservations} subscribeChanges={subscribeChanges} loadMembers={loadMembers} reply={reply} changeAttention={changeAttention} transferTask={transferTask} changeTask={changeTask} promoteThread={promoteThread} t={t} />
  }
  if (current !== undefined && navigationState.projectRef !== undefined) {
    return <TeamProjectPage key={navigationState.projectRef} humanName={humanName} resolveMessageRefs={resolveMessageRefs} {...(identity.avatarUrl === undefined ? {} : { humanAvatarUrl: identity.avatarUrl })} workspaceId={current.workspaceId} projectRef={navigationState.projectRef} drafts={drafts} putAttachment={putAttachment} getAttachment={getAttachment} loadProjects={loadProjects} loadTaskBoard={loadTaskBoard} subscribeChanges={subscribeChanges} loadMembers={loadMembers} loadInbox={loadInbox} postMainMessage={postMainMessage} startThread={startThread} readMainStream={readMainStream} mainStreamHistory={mainStreamHistory} readThread={readThread} loadThreadHistory={loadThreadHistory} threadObservations={threadObservations} reply={reply} changeAttention={changeAttention} promoteThread={promoteThread} selectThread={selectThread} selectProject={selectProject} resolveTaskRefs={resolveTaskRefs} resolveThreadRefs={resolveThreadRefs} openMemberSession={openMemberSession} t={t} />
  }
  const welcome = current === undefined
    ? { eyebrow: t('teamMode'), title: t('team'), body: t('empty') }
    : { eyebrow: current.title, title: t('projects'), body: t('selectProjectHint') }
  return <main className={css.welcomeSurface} data-team-conversation>
    <div className={css.welcome}>
      <span className={css.welcomeEyebrow}>{welcome.eyebrow}</span>
      <h1>{welcome.title}</h1>
      <p>{welcome.body}</p>
    </div>
  </main>
}
