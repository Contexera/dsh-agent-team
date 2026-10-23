import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { AgentTeamProjectRef, AgentTeamTaskRef, AgentTeamThreadRef } from '@contexera/dsh-agent-team/types'

export type TeamMode = 'conversation' | 'team'

/** The rail row selects this panel and Team mode follows (see the panel-ownership effect in `index.ts`). */
export const TEAM_PANEL_ID = 'agent-team' as MainPanelId

export interface TeamNavigationSnapshot {
  mode: TeamMode
  workspaceId?: WorkspaceId
  projectRef?: AgentTeamProjectRef
  taskRef?: AgentTeamTaskRef
  threadRef?: AgentTeamThreadRef
  taskNumber?: number
  /** A navigation fact, not an unread fact: selecting Inbox clears the Project/Thread faces, and a reload reopens the page. */
  inbox?: boolean
  /** Runtime-only Member Session embedded in the conversation seat; never persisted. */
  memberSessionId?: SessionId
  /** Runtime-only session to restore when the Member view closes; never persisted. */
  returnToSessionId?: SessionId
}

const STORAGE_KEY = 'dsh.agent-team.navigation'

function readSnapshot(): TeamNavigationSnapshot {
  if (typeof localStorage === 'undefined') return { mode: 'conversation' }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '') as Partial<TeamNavigationSnapshot> & { channelRef?: unknown }
    // Projects were called Channels; a snapshot saved before the rename still reopens its page.
    const projectRef = typeof parsed.channelRef === 'string' ? parsed.channelRef.replace(/^channel:/, 'project:') : parsed.projectRef
    const hasThread = typeof parsed.threadRef === 'string'
    return {
      mode: parsed.mode === 'team' ? 'team' : 'conversation',
      ...(typeof parsed.workspaceId === 'string' ? { workspaceId: parsed.workspaceId as WorkspaceId } : {}),
      ...(typeof projectRef === 'string' ? { projectRef: projectRef as AgentTeamProjectRef } : {}),
      ...(parsed.inbox === true ? { inbox: true } : {}),
      ...(hasThread ? {
        threadRef: parsed.threadRef as AgentTeamThreadRef,
        ...(typeof parsed.taskRef === 'string' ? { taskRef: parsed.taskRef as AgentTeamTaskRef } : {}),
        ...(typeof parsed.taskNumber === 'number' && Number.isInteger(parsed.taskNumber) && parsed.taskNumber > 0 ? { taskNumber: parsed.taskNumber } : {}),
      } : {}),
    }
  } catch {
    return { mode: 'conversation' }
  }
}

function persistSnapshot(snapshot: TeamNavigationSnapshot): void {
  if (typeof localStorage === 'undefined') return
  const { mode, workspaceId, projectRef, taskRef, threadRef, taskNumber, inbox } = snapshot
  persistLocallyBestEffort({
    mode,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(projectRef === undefined ? {} : { projectRef }),
    ...(inbox === true ? { inbox: true } : {}),
    ...(taskRef === undefined ? {} : { taskRef }),
    ...(threadRef === undefined ? {} : { threadRef }),
    ...(taskNumber === undefined ? {} : { taskNumber }),
  })
}

/** Remember the position for the next reload; a browser that refuses storage (private mode, quota) loses only that. */
function persistLocallyBestEffort(payload: TeamNavigationSnapshot): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
  }
}

export interface TeamNavigationActions {
  enterTeam: () => void
  /** Flip the mode only; a caller that also owns the column releases it through {@link leaveTeamForConversation}. */
  leaveTeam: () => void
  /**
   * Leave Team mode and hand the column back in one move. The panel release runs before the mode flips, or a
   * still-selected Team panel would put the mode straight back.
   */
  leaveTeamForConversation: (releasePanel: () => void) => void
  selectWorkspace: (workspaceId: WorkspaceId) => void
  selectProject: (projectRef: AgentTeamProjectRef) => void
  selectThread: (threadRef: AgentTeamThreadRef, projectRef?: AgentTeamProjectRef, taskRef?: AgentTeamTaskRef, taskNumber?: number) => void
  selectInbox: () => void
  backToWorkspace: () => void
  /** Swap the conversation seat to a Member Session. `returnToSessionId` is captured once, so switching Member Sessions keeps the original target. */
  enterMemberSession: (sessionId: SessionId, returnToSessionId?: SessionId) => void
  exitMemberSession: () => void
}

function isReselectingActiveMember(snapshot: TeamNavigationSnapshot, sessionId: SessionId): boolean {
  return snapshot.memberSessionId === sessionId && snapshot.mode === 'team'
}

export class TeamNavigation {
  private snapshot = readSnapshot()
  private readonly listeners = new Set<() => void>()

  readonly getSnapshot = (): TeamNavigationSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  actions(): TeamNavigationActions {
    return {
      enterTeam: () => { this.clearMemberSession(); this.setMode('team') },
      leaveTeam: () => { this.setMode('conversation') },
      leaveTeamForConversation: releasePanel => {
        this.clearMemberSession()
        releasePanel()
        this.setMode('conversation')
      },
      selectWorkspace: workspaceId => { this.clearMemberSession(); this.setWorkspace(workspaceId) },
      selectProject: projectRef => { this.clearMemberSession(); this.setProject(projectRef) },
      selectThread: (threadRef, projectRef, taskRef, taskNumber) => { this.clearMemberSession(); this.setThread(threadRef, projectRef, taskRef, taskNumber) },
      selectInbox: () => { this.clearMemberSession(); this.setInbox() },
      backToWorkspace: () => { this.clearMemberSession(); this.setThread(undefined) },
      enterMemberSession: (sessionId, returnToSessionId) => { this.setMemberSession(sessionId, returnToSessionId) },
      exitMemberSession: () => { this.clearMemberSession() },
    }
  }

  dispose(): void {
    this.listeners.clear()
  }

  private setMode(mode: TeamMode): void {
    if (this.snapshot.mode === mode) return
    this.snapshot = { ...this.snapshot, mode }
    this.commit()
  }

  private setMemberSession(sessionId: SessionId, returnToSessionId?: SessionId): void {
    if (isReselectingActiveMember(this.snapshot, sessionId)) return
    const { memberSessionId: _memberSessionId, ...base } = this.snapshot
    this.snapshot = {
      ...base,
      mode: 'team',
      memberSessionId: sessionId,
      ...(returnToSessionId === undefined ? {} : { returnToSessionId }),
    }
    this.commit()
  }

  /** Any explicit Team navigation or the footer leave closes a Member view. */
  private clearMemberSession(): void {
    if (this.snapshot.memberSessionId === undefined && this.snapshot.returnToSessionId === undefined) return
    const { memberSessionId: _memberSessionId, returnToSessionId: _returnToSessionId, ...base } = this.snapshot
    this.snapshot = base
    this.commit()
  }

  private setWorkspace(workspaceId: WorkspaceId): void {
    if (this.snapshot.workspaceId === workspaceId && this.snapshot.inbox !== true) return
    const { projectRef: _projectRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, inbox: _inbox, ...base } = this.snapshot
    this.snapshot = { ...base, workspaceId }
    this.commit()
  }

  private setProject(projectRef: AgentTeamProjectRef): void {
    if (this.snapshot.projectRef === projectRef && this.snapshot.threadRef === undefined && this.snapshot.inbox !== true) return
    const { taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, inbox: _inbox, ...base } = this.snapshot
    this.snapshot = { ...base, projectRef }
    this.commit()
  }

  /** The Inbox is a face, not workspace content: selecting a Workspace leaves it. */
  private setInbox(): void {
    if (this.snapshot.inbox === true && this.snapshot.projectRef === undefined && this.snapshot.threadRef === undefined) return
    const { projectRef: _projectRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, ...base } = this.snapshot
    this.snapshot = { ...base, inbox: true }
    this.commit()
  }

  private setThread(threadRef: AgentTeamThreadRef | undefined, projectRef?: AgentTeamProjectRef, taskRef?: AgentTeamTaskRef, taskNumber?: number): void {
    if (this.snapshot.threadRef === threadRef && this.snapshot.taskRef === taskRef && this.snapshot.projectRef === projectRef && this.snapshot.taskNumber === taskNumber && this.snapshot.inbox !== true) return
    if (threadRef === undefined) {
      const { taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, ...base } = this.snapshot
      this.snapshot = base
    } else {
      const { projectRef: _projectRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, inbox: _inbox, ...base } = this.snapshot
      this.snapshot = {
        ...base,
        threadRef,
        ...(projectRef === undefined ? {} : { projectRef }),
        ...(taskRef === undefined ? {} : { taskRef }),
        ...(taskNumber === undefined ? {} : { taskNumber }),
      }
    }
    this.commit()
  }

  private commit(): void {
    persistSnapshot(this.snapshot)
    for (const listener of this.listeners) listener()
  }

}

export { STORAGE_KEY }
