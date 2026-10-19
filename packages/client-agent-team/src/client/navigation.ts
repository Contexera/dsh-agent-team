import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { AgentTeamChannelRef, AgentTeamTaskRef, AgentTeamThreadRef } from '@contexera/dsh-agent-team/types'

export type TeamMode = 'conversation' | 'team'

/**
 * The global panel the Team is entered as, addressed by the sidebar's panel
 * rail. Team mode and this panel selection are one fact: the rail's row selects
 * it and the mode follows (see the panel-ownership effect in `index.ts`).
 */
export const TEAM_PANEL_ID = 'agent-team' as MainPanelId

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
  const { mode, workspaceId, channelRef, taskRef, threadRef, taskNumber, inbox } = snapshot
  persistLocallyBestEffort({
    mode,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(channelRef === undefined ? {} : { channelRef }),
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
   * Leave Team mode for the conversation and hand the column back in one move.
   * The panel release runs before the mode flips: the mode's own ownership
   * effect reads the flip, and a still-selected Team panel at that instant would
   * put the mode straight back.
   */
  leaveTeamForConversation: (releasePanel: () => void) => void
  selectWorkspace: (workspaceId: WorkspaceId) => void
  selectChannel: (channelRef: AgentTeamChannelRef) => void
  selectThread: (threadRef: AgentTeamThreadRef, channelRef?: AgentTeamChannelRef, taskRef?: AgentTeamTaskRef, taskNumber?: number) => void
  /** Open the Human mention-Inbox page; clears the Channel/Thread faces. */
  selectInbox: () => void
  backToWorkspace: () => void
  /**
   * Swap the conversation seat to a Member Session while Team chrome stays
   * mounted. `returnToSessionId` is captured once — switching between Member
   * Sessions keeps the original target.
   */
  enterMemberSession: (sessionId: SessionId, returnToSessionId?: SessionId) => void
  /** Close the embedded Member Session view and return to the Team views. */
  exitMemberSession: () => void
}

/**
 * Whether one `enterMemberSession` call restates the state already standing:
 * the same Member Session selected while Team mode is already entered.
 */
function isReselectingActiveMember(snapshot: TeamNavigationSnapshot, sessionId: SessionId): boolean {
  return snapshot.memberSessionId === sessionId && snapshot.mode === 'team'
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
      leaveTeamForConversation: releasePanel => {
        this.clearMemberSession()
        releasePanel()
        this.setMode('conversation')
      },
      selectWorkspace: workspaceId => { this.clearMemberSession(); this.setWorkspace(workspaceId) },
      selectChannel: channelRef => { this.clearMemberSession(); this.setChannel(channelRef) },
      selectThread: (threadRef, channelRef, taskRef, taskNumber) => { this.clearMemberSession(); this.setThread(threadRef, channelRef, taskRef, taskNumber) },
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
