import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AgentTeamChannelRef, AgentTeamTaskRef, AgentTeamThreadRef } from '@contexera/dsh-agent-team/types'

export type TeamMode = 'conversation' | 'team'

export interface TeamNavigationSnapshot {
  mode: TeamMode
  workspaceId?: WorkspaceId
  channelRef?: AgentTeamChannelRef
  taskRef?: AgentTeamTaskRef
  threadRef?: AgentTeamThreadRef
  taskNumber?: number
  /**
   * Durable position of the Human mention-Inbox page (a navigation fact, not
   * an unread fact): selecting Inbox clears the Channel/Thread faces, and a
   * reload reopens the page. Read markers only move through Thread reads.
   */
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
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '') as Partial<TeamNavigationSnapshot>
    const hasThread = typeof parsed.threadRef === 'string'
    return {
      mode: parsed.mode === 'team' ? 'team' : 'conversation',
      ...(typeof parsed.workspaceId === 'string' ? { workspaceId: parsed.workspaceId as WorkspaceId } : {}),
      ...(typeof parsed.channelRef === 'string' ? { channelRef: parsed.channelRef as AgentTeamChannelRef } : {}),
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
  try {
    const { mode, workspaceId, channelRef, taskRef, threadRef, taskNumber, inbox } = snapshot
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(channelRef === undefined ? {} : { channelRef }),
      ...(inbox === true ? { inbox: true } : {}),
      ...(taskRef === undefined ? {} : { taskRef }),
      ...(threadRef === undefined ? {} : { threadRef }),
      ...(taskNumber === undefined ? {} : { taskNumber }),
    }))
  } catch {
    // Local persistence is a convenience; private mode and quota failures do not block navigation.
  }
}

export interface TeamNavigationActions {
  enterTeam: () => void
  leaveTeam: () => void
  selectWorkspace: (workspaceId: WorkspaceId) => void
  selectChannel: (channelRef: AgentTeamChannelRef) => void
  selectThread: (threadRef: AgentTeamThreadRef, channelRef?: AgentTeamChannelRef, taskRef?: AgentTeamTaskRef, taskNumber?: number) => void
  /** Open the Human mention-Inbox page; clears the Channel/Thread faces. */
  selectInbox: () => void
  backToWorkspace: () => void
  /** Leave the selected Channel for the workspace Channel list; keeps mode and Workspace. */
  backToChannels: () => void
  /**
   * Swap the conversation seat to a Member Session while Team chrome stays
   * mounted. `returnToSessionId` is captured once — switching between Member
   * Sessions keeps the original target.
   */
  enterMemberSession: (sessionId: SessionId, returnToSessionId?: SessionId) => void
  /** Close the embedded Member Session view and return to the Team views. */
  exitMemberSession: () => void
}

/** Root-scoped Team mode state. Slot lifetimes subscribe to this source. */
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
      selectWorkspace: workspaceId => { this.clearMemberSession(); this.setWorkspace(workspaceId) },
      selectChannel: channelRef => { this.clearMemberSession(); this.setChannel(channelRef) },
      selectThread: (threadRef, channelRef, taskRef, taskNumber) => { this.clearMemberSession(); this.setThread(threadRef, channelRef, taskRef, taskNumber) },
      selectInbox: () => { this.clearMemberSession(); this.setInbox() },
      backToWorkspace: () => { this.clearMemberSession(); this.setThread(undefined) },
      backToChannels: () => { this.clearMemberSession(); this.clearChannel() },
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
    // Re-selecting the active Member keeps the original return target.
    if (this.snapshot.memberSessionId === sessionId && this.snapshot.mode === 'team') return
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
    const { channelRef: _channelRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, inbox: _inbox, ...base } = this.snapshot
    this.snapshot = { ...base, workspaceId }
    this.commit()
  }

  private setChannel(channelRef: AgentTeamChannelRef): void {
    if (this.snapshot.channelRef === channelRef && this.snapshot.threadRef === undefined && this.snapshot.inbox !== true) return
    const { taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, inbox: _inbox, ...base } = this.snapshot
    this.snapshot = { ...base, channelRef }
    this.commit()
  }

  /** The Inbox is a face, not workspace content: selecting a Workspace leaves it. */
  private setInbox(): void {
    if (this.snapshot.inbox === true && this.snapshot.channelRef === undefined && this.snapshot.threadRef === undefined) return
    const { channelRef: _channelRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, ...base } = this.snapshot
    this.snapshot = { ...base, inbox: true }
    this.commit()
  }

  private clearChannel(): void {
    const { channelRef: _channelRef, ...base } = this.snapshot
    if (this.snapshot.channelRef === undefined) return
    this.snapshot = base
    this.commit()
  }

  private setThread(threadRef: AgentTeamThreadRef | undefined, channelRef?: AgentTeamChannelRef, taskRef?: AgentTeamTaskRef, taskNumber?: number): void {
    if (this.snapshot.threadRef === threadRef && this.snapshot.taskRef === taskRef && this.snapshot.channelRef === channelRef && this.snapshot.taskNumber === taskNumber && this.snapshot.inbox !== true) return
    if (threadRef === undefined) {
      const { taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, ...base } = this.snapshot
      this.snapshot = base
    } else {
      const { channelRef: _channelRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, inbox: _inbox, ...base } = this.snapshot
      this.snapshot = {
        ...base,
        threadRef,
        ...(channelRef === undefined ? {} : { channelRef }),
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
