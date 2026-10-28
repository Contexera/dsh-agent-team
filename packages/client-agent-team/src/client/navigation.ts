import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { AgentTeamProjectRef, AgentTeamTaskRef, AgentTeamThreadRef } from '@contexera/dsh-agent-team/types'

export type TeamMode = 'conversation' | 'team'

/** The rail row selects this panel and Team mode follows (see the panel-ownership effect in `index.ts`). */
export const TEAM_PANEL_ID = 'agent-team' as MainPanelId

/** What an opening of a taskless discussion should land on. Persisted with the destination so a reload lands the same way. */
export type TeamDiscussionAnchor = 'unread'

export interface TeamNavigationSnapshot {
  mode: TeamMode
  workspaceId?: WorkspaceId
  projectRef?: AgentTeamProjectRef
  taskRef?: AgentTeamTaskRef
  threadRef?: AgentTeamThreadRef
  taskNumber?: number
  /**
   * A taskless discussion open in the Project page's side panel. A Task Thread covers the whole page, but the panel
   * stays part of the Project face underneath: returning from a Task opened inside that Project restores it.
   */
  discussionRef?: AgentTeamThreadRef
  /**
   * Why the reader arrived at that discussion. `unread` asks the panel to open on the first unread Message naming the
   * Human, the rule a Thread page already follows; every other entry keeps the panel's newest-first opening.
   */
  discussionAnchor?: TeamDiscussionAnchor
  /** A navigation fact, not an unread fact: selecting Inbox clears the Project/Thread faces, and a reload reopens the page. */
  inbox?: boolean
  board?: boolean
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
    // A discussion panel is a Project face: a snapshot naming one without its Project cannot reopen.
    const hasDiscussion = typeof parsed.discussionRef === 'string' && typeof projectRef === 'string'
    return {
      mode: parsed.mode === 'team' ? 'team' : 'conversation',
      ...(typeof parsed.workspaceId === 'string' ? { workspaceId: parsed.workspaceId as WorkspaceId } : {}),
      ...(typeof projectRef === 'string' ? { projectRef: projectRef as AgentTeamProjectRef } : {}),
      ...(parsed.inbox === true ? { inbox: true } : {}),
      ...(parsed.board === true ? { board: true } : {}),
      ...(hasDiscussion ? {
        discussionRef: parsed.discussionRef as AgentTeamThreadRef,
        ...(parsed.discussionAnchor === 'unread' ? { discussionAnchor: 'unread' as const } : {}),
      } : {}),
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
  const { mode, workspaceId, projectRef, taskRef, threadRef, taskNumber, discussionRef, discussionAnchor, inbox, board } = snapshot
  persistLocallyBestEffort({
    mode,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(projectRef === undefined ? {} : { projectRef }),
    ...(inbox === true ? { inbox: true } : {}),
    ...(board === true ? { board: true } : {}),
    ...(taskRef === undefined ? {} : { taskRef }),
    ...(threadRef === undefined ? {} : { threadRef }),
    ...(taskNumber === undefined ? {} : { taskNumber }),
    ...(discussionRef === undefined ? {} : { discussionRef }),
    ...(discussionAnchor === undefined ? {} : { discussionAnchor }),
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
  selectThread: (threadRef: AgentTeamThreadRef, projectRef?: AgentTeamProjectRef, taskRef?: AgentTeamTaskRef, taskNumber?: number, options?: SelectThreadOptions) => void
  /**
   * Open a taskless discussion beside its Project's Main stream. `workspaceId` moves the seat and the destination in one
   * step — the Inbox reads across Workspaces — and `anchor` chooses where inside the discussion the panel lands.
   */
  selectDiscussion: (threadRef: AgentTeamThreadRef, projectRef: AgentTeamProjectRef, options?: SelectDiscussionOptions) => void
  /** Close the side panel and keep the Project page it was seated in. */
  closeDiscussion: () => void
  selectInbox: () => void
  selectBoard: () => void
  backToWorkspace: () => void
  /** Swap the conversation seat to a Member Session. `returnToSessionId` is captured once, so switching Member Sessions keeps the original target. */
  enterMemberSession: (sessionId: SessionId, returnToSessionId?: SessionId) => void
  exitMemberSession: () => void
}

export interface SelectDiscussionOptions {
  readonly workspaceId?: WorkspaceId
  readonly anchor?: TeamDiscussionAnchor
}

export interface SelectThreadOptions {
  /**
   * False drops any open discussion panel even when the Task is in the same Project. Promotion is the one caller that
   * needs this: the discussion became the Task, so there is no separate panel to restore.
   */
  readonly preserveDiscussion?: boolean
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
      selectThread: (threadRef, projectRef, taskRef, taskNumber, options) => { this.clearMemberSession(); this.setThread(threadRef, projectRef, taskRef, taskNumber, options) },
      selectDiscussion: (threadRef, projectRef, options) => { this.clearMemberSession(); this.setDiscussion(threadRef, projectRef, options) },
      closeDiscussion: () => { this.clearMemberSession(); this.setDiscussion(undefined) },
      selectInbox: () => { this.clearMemberSession(); this.setInbox() },
      selectBoard: () => { this.clearMemberSession(); this.setBoard() },
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
    if (this.snapshot.workspaceId === workspaceId && this.snapshot.inbox !== true && this.snapshot.board !== true && this.snapshot.discussionRef === undefined) return
    const { projectRef: _projectRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, discussionRef: _discussionRef, discussionAnchor: _discussionAnchor, inbox: _inbox, board: _board, ...base } = this.snapshot
    this.snapshot = { ...base, workspaceId }
    this.commit()
  }

  private setProject(projectRef: AgentTeamProjectRef): void {
    if (this.snapshot.projectRef === projectRef && this.snapshot.threadRef === undefined && this.snapshot.inbox !== true && this.snapshot.board !== true && this.snapshot.discussionRef === undefined) return
    const { taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, discussionRef: _discussionRef, discussionAnchor: _discussionAnchor, inbox: _inbox, board: _board, ...base } = this.snapshot
    this.snapshot = { ...base, projectRef }
    this.commit()
  }

  /** The Inbox is a face, not workspace content: selecting a Workspace leaves it. */
  private setInbox(): void {
    if (this.snapshot.inbox === true && this.snapshot.projectRef === undefined && this.snapshot.threadRef === undefined && this.snapshot.board !== true) return
    const { projectRef: _projectRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, discussionRef: _discussionRef, discussionAnchor: _discussionAnchor, board: _board, ...base } = this.snapshot
    this.snapshot = { ...base, inbox: true }
    this.commit()
  }

  private setBoard(): void {
    if (this.snapshot.board === true && this.snapshot.projectRef === undefined && this.snapshot.threadRef === undefined && this.snapshot.discussionRef === undefined) return
    const { projectRef: _projectRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, discussionRef: _discussionRef, discussionAnchor: _discussionAnchor, inbox: _inbox, ...base } = this.snapshot
    this.snapshot = { ...base, board: true }
    this.commit()
  }

  private setThread(threadRef: AgentTeamThreadRef | undefined, projectRef?: AgentTeamProjectRef, taskRef?: AgentTeamTaskRef, taskNumber?: number, options?: SelectThreadOptions): void {
    if (this.snapshot.threadRef === threadRef && this.snapshot.taskRef === taskRef && this.snapshot.projectRef === projectRef && this.snapshot.taskNumber === taskNumber && this.snapshot.inbox !== true && this.snapshot.board !== true) return
    // A Task opened from its own Project covers that Project face; keep the panel state underneath so Back restores it.
    // Entry from anywhere else (Inbox, Board, another Task page, a sibling Project) and promotion clear it instead.
    const keepsDiscussion = threadRef === undefined
      ? this.snapshot.discussionRef !== undefined
      : options?.preserveDiscussion !== false
        && this.snapshot.threadRef === undefined
        && this.snapshot.inbox !== true
        && this.snapshot.board !== true
        && this.snapshot.projectRef !== undefined
        && this.snapshot.projectRef === projectRef
        && this.snapshot.discussionRef !== undefined
    const baseSnapshot: TeamNavigationSnapshot = (() => {
      if (keepsDiscussion) return this.snapshot
      const { discussionRef: _discussionRef, discussionAnchor: _discussionAnchor, ...withoutDiscussion } = this.snapshot
      return withoutDiscussion
    })()
    if (threadRef === undefined) {
      const { taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, ...base } = baseSnapshot
      this.snapshot = base
    } else {
      const { projectRef: _projectRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, inbox: _inbox, board: _board, ...base } = baseSnapshot
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

  /**
   * The panel is a face of its Project page, so opening one is a location like any other: it replaces the Inbox, Board
   * and full Thread faces, and the Project and Workspace it names move with it. Task Threads keep the full page, so
   * {@link setDiscussion} never touches `threadRef`.
   *
   * `anchor` is deliberately part of the comparison: entering the same discussion from an Inbox row must re-aim a panel
   * that is already open, and leaving through a plain card must retire a stale aim.
   */
  private setDiscussion(threadRef: AgentTeamThreadRef | undefined, projectRef?: AgentTeamProjectRef, options?: SelectDiscussionOptions): void {
    const anchor = options?.anchor
    if (threadRef === undefined) {
      if (this.snapshot.discussionRef === undefined && this.snapshot.discussionAnchor === undefined) return
      const { discussionRef: _discussionRef, discussionAnchor: _discussionAnchor, ...base } = this.snapshot
      this.snapshot = base
      this.commit()
      return
    }
    const workspaceId = options?.workspaceId ?? this.snapshot.workspaceId
    if (this.snapshot.discussionRef === threadRef && this.snapshot.projectRef === projectRef && this.snapshot.discussionAnchor === anchor
      && this.snapshot.workspaceId === workspaceId && this.snapshot.threadRef === undefined
      && this.snapshot.inbox !== true && this.snapshot.board !== true) return
    const { taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, discussionRef: _discussionRef, discussionAnchor: _discussionAnchor, inbox: _inbox, board: _board, ...base } = this.snapshot
    this.snapshot = {
      ...base,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(projectRef === undefined ? {} : { projectRef }),
      discussionRef: threadRef,
      ...(anchor === undefined ? {} : { discussionAnchor: anchor }),
    }
    this.commit()
  }

  private commit(): void {
    persistSnapshot(this.snapshot)
    for (const listener of this.listeners) listener()
  }

}

export { STORAGE_KEY }
