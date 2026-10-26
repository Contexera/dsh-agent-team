import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, TeamNavigation } from '../src/client/navigation.ts'

function storage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => { values.clear() },
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe('TeamNavigation', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage())
  })

  it('enters and leaves Team mode while preserving the selected Workspace', () => {
    const navigation = new TeamNavigation()
    const changes: string[] = []
    const off = navigation.subscribe(() => { changes.push(navigation.getSnapshot().mode) })

    navigation.actions().selectWorkspace('workspace:one' as never)
    navigation.actions().enterTeam()
    navigation.actions().leaveTeam()

    expect(navigation.getSnapshot()).toEqual({ mode: 'conversation', workspaceId: 'workspace:one' })
    expect(changes).toEqual(['conversation', 'team', 'conversation'])
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toEqual({
      mode: 'conversation', workspaceId: 'workspace:one',
    })
    off()
  })

  it('rehydrates the last Team location while ignoring unknown persisted fields', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode: 'team', workspaceId: 'workspace:old', projectRef: 'project:old',
      taskRef: 'task:old', threadRef: 'thread:old', taskNumber: 7, activeTab: 'inbox',
    }))
    const navigation = new TeamNavigation()
    expect(navigation.getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:old', projectRef: 'project:old',
      taskRef: 'task:old', threadRef: 'thread:old', taskNumber: 7,
    })

    navigation.actions().selectWorkspace('workspace:existing' as never)
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:existing' })
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toEqual({ mode: 'team', workspaceId: 'workspace:existing' })
  })

  it('reopens a Project page saved before Projects were renamed from Channels', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'team', workspaceId: 'workspace:old', channelRef: 'channel:old' }))
    expect(new TeamNavigation().getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:old', projectRef: 'project:old' })
  })

  it('persists Project and Thread location across a new navigation instance', () => {
    const navigation = new TeamNavigation()
    navigation.actions().selectWorkspace('workspace:one' as never)
    navigation.actions().enterTeam()
    navigation.actions().selectThread('thread:1' as never, 'project:1' as never, 'task:1' as never, 7)

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toEqual({
      mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1',
      taskRef: 'task:1', threadRef: 'thread:1', taskNumber: 7,
    })
    expect(new TeamNavigation().getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1',
      taskRef: 'task:1', threadRef: 'thread:1', taskNumber: 7,
    })
  })

  it('persists a taskless Thread with threadRef as the stable key', () => {
    const navigation = new TeamNavigation()
    navigation.actions().selectWorkspace('workspace:one' as never)
    navigation.actions().enterTeam()
    navigation.actions().selectThread('thread:plain' as never, 'project:1' as never)

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toEqual({
      mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1',
      threadRef: 'thread:plain',
    })
    expect(new TeamNavigation().getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1',
      threadRef: 'thread:plain',
    })
  })

  /**
   * The side panel is a navigation fact like any other, so one `selectDiscussion` has to survive a reload on its own and
   * the Project face around it must stay reachable. A Task keeps the full page, so the two never compete.
   */
  it('persists an open discussion beside its Project and reopens it with its anchor', () => {
    const navigation = new TeamNavigation()
    navigation.actions().selectWorkspace('workspace:one' as never)
    navigation.actions().enterTeam()
    navigation.actions().selectDiscussion('thread:1' as never, 'project:1' as never, { anchor: 'unread' })

    expect(navigation.getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1',
      discussionRef: 'thread:1', discussionAnchor: 'unread',
    })
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toEqual({
      mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1',
      discussionRef: 'thread:1', discussionAnchor: 'unread',
    })
    // A reload lands on the same Project with the same discussion and the same aim inside it.
    expect(new TeamNavigation().getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1',
      discussionRef: 'thread:1', discussionAnchor: 'unread',
    })

    // An Inbox row moves the seat and the destination in one step, because it reads across Workspaces.
    navigation.actions().selectDiscussion('thread:2' as never, 'project:2' as never, { workspaceId: 'workspace:two' as never, anchor: 'unread' })
    expect(navigation.getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:two', projectRef: 'project:2',
      discussionRef: 'thread:2', discussionAnchor: 'unread',
    })
    // Re-entering the same discussion from the Main stream retires a stale aim without closing the panel.
    navigation.actions().selectDiscussion('thread:2' as never, 'project:2' as never)
    expect(navigation.getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:two', projectRef: 'project:2', discussionRef: 'thread:2',
    })
    // A discussion is a Project face: a snapshot naming one without a Project cannot reopen.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'team', workspaceId: 'workspace:one', discussionRef: 'thread:1' }))
    expect(new TeamNavigation().getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one' })
  })

  it('closes the discussion panel while keeping the Project page it was seated in', () => {
    const navigation = new TeamNavigation()
    navigation.actions().selectWorkspace('workspace:one' as never)
    navigation.actions().enterTeam()
    navigation.actions().selectDiscussion('thread:1' as never, 'project:1' as never, { anchor: 'unread' })

    const changes: string[] = []
    const off = navigation.subscribe(() => { changes.push(JSON.stringify(navigation.getSnapshot())) })
    navigation.actions().closeDiscussion()
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1' })
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toEqual({ mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1' })
    // Closing an already closed panel commits nothing.
    navigation.actions().closeDiscussion()
    expect(changes).toHaveLength(1)
    expect(new TeamNavigation().getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1' })
    off()
  })

  it('leaves the discussion behind for every other Team face, and keeps a Task Thread off the panel', () => {
    const open = (): TeamNavigation => {
      const navigation = new TeamNavigation()
      navigation.actions().selectWorkspace('workspace:one' as never)
      navigation.actions().enterTeam()
      navigation.actions().selectDiscussion('thread:1' as never, 'project:1' as never, { anchor: 'unread' })
      return navigation
    }
    // A Task Thread replaces the panel: the Project page keeps one face at a time.
    const threaded = open()
    threaded.actions().selectThread('thread:9' as never, 'project:1' as never, 'task:9' as never, 9)
    expect(threaded.getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1',
      threadRef: 'thread:9', taskRef: 'task:9', taskNumber: 9,
    })
    // Opening a discussion never disturbs a Thread face either: it is not a Thread page.
    threaded.actions().selectDiscussion('thread:1' as never, 'project:1' as never)
    expect(threaded.getSnapshot().threadRef).toBeUndefined()
    expect(threaded.getSnapshot().discussionRef).toBe('thread:1')

    const faces: Array<[string, (navigation: TeamNavigation) => void, object]> = [
      ['Project', navigation => { navigation.actions().selectProject('project:2' as never) }, { projectRef: 'project:2' }],
      ['Workspace', navigation => { navigation.actions().selectWorkspace('workspace:two' as never) }, { workspaceId: 'workspace:two' }],
      ['Inbox', navigation => { navigation.actions().selectInbox() }, { inbox: true }],
      ['Board', navigation => { navigation.actions().selectBoard() }, { board: true }],
    ]
    for (const [face, step, expected] of faces) {
      const navigation = open()
      step(navigation)
      const snapshot = navigation.getSnapshot()
      expect(snapshot.discussionRef, face).toBeUndefined()
      expect(snapshot.discussionAnchor, face).toBeUndefined()
      expect(snapshot, face).toMatchObject(expected)
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).not.toHaveProperty('discussionRef', 'thread:1')
    }
  })

  it('ignores malformed and incomplete persisted state', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1',
      threadRef: 'thread:plain',
    }))
    expect(new TeamNavigation().getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1',
      threadRef: 'thread:plain',
    })

    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1',
      taskRef: 'task:orphaned', taskNumber: 7,
    }))
    expect(new TeamNavigation().getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1',
    })

    localStorage.setItem(STORAGE_KEY, '{broken')
    expect(new TeamNavigation().getSnapshot()).toEqual({ mode: 'conversation' })
  })

  it('overlays a runtime-only Member Session without losing the Team location', () => {
    const navigation = new TeamNavigation()
    navigation.actions().selectWorkspace('workspace:one' as never)
    navigation.actions().enterTeam()
    navigation.actions().selectThread('thread:1' as never, 'project:1' as never, 'task:1' as never, 7)
    navigation.actions().enterMemberSession('session:builder' as never, 'session:return' as never)

    expect(navigation.getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1',
      taskRef: 'task:1', threadRef: 'thread:1', taskNumber: 7,
      memberSessionId: 'session:builder', returnToSessionId: 'session:return',
    })
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toEqual({
      mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1',
      taskRef: 'task:1', threadRef: 'thread:1', taskNumber: 7,
    })
    expect(new TeamNavigation().getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1',
      taskRef: 'task:1', threadRef: 'thread:1', taskNumber: 7,
    })
  })

  it('keeps the original return target when another Member is selected', () => {
    const navigation = new TeamNavigation()
    navigation.actions().enterTeam()
    navigation.actions().enterMemberSession('session:builder' as never, 'session:return' as never)
    // While the Member view is open the shell current session is the Member's
    // own, so re-entering without a fresh target must not steal the return.
    navigation.actions().enterMemberSession('session:reviewer' as never)

    expect(navigation.getSnapshot()).toEqual({
      mode: 'team', memberSessionId: 'session:reviewer', returnToSessionId: 'session:return',
    })
  })

  it('closes the Member view on any explicit Team navigation or the exit action', () => {
    const reopen = (navigation: TeamNavigation): void => {
      navigation.actions().enterTeam()
      navigation.actions().enterMemberSession('session:builder' as never, 'session:return' as never)
    }
    const steps: Array<(navigation: TeamNavigation) => void> = [
      navigation => { navigation.actions().selectWorkspace('workspace:two' as never) },
      navigation => { navigation.actions().selectProject('project:2' as never) },
      navigation => { navigation.actions().selectThread('thread:9' as never) },
      // The Inbox entry is Team navigation too, and the one face an Agent
      // overlay can be opened from: asking for the page closes the overlay.
      navigation => { navigation.actions().selectInbox() },
      navigation => { navigation.actions().backToWorkspace() },
      navigation => { navigation.actions().enterTeam() },
      navigation => { navigation.actions().exitMemberSession() },
    ]
    for (const step of steps) {
      const navigation = new TeamNavigation()
      reopen(navigation)
      step(navigation)
      const snapshot = navigation.getSnapshot()
      expect(snapshot.memberSessionId).toBeUndefined()
      expect(snapshot.returnToSessionId).toBeUndefined()
      expect(snapshot.mode).toBe('team')
    }
  })

  it('opens the Inbox page as a durable location that Project and Thread faces replace', () => {
    const navigation = new TeamNavigation()
    navigation.actions().selectWorkspace('workspace:one' as never)
    navigation.actions().enterTeam()
    navigation.actions().selectInbox()
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', inbox: true })
    // The Inbox position is a navigation fact, not an unread fact: a reload reopens the page.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toEqual({ mode: 'team', workspaceId: 'workspace:one', inbox: true })
    expect(new TeamNavigation().getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', inbox: true })
    // Re-selecting the open page spams nobody.
    navigation.actions().selectInbox()
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', inbox: true })

    // Selecting a Thread from a row clears the Inbox face; Back then lands on
    // that Thread's Project — the Inbox is never pushed onto the back path.
    navigation.actions().selectThread('thread:1' as never, 'project:1' as never)
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1', threadRef: 'thread:1' })
    navigation.actions().backToWorkspace()
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', projectRef: 'project:1' })

    // A Project or Workspace selection leaves the Inbox face as well.
    navigation.actions().selectInbox()
    navigation.actions().selectProject('project:2' as never)
    expect(navigation.getSnapshot().inbox).toBeUndefined()
    navigation.actions().selectInbox()
    navigation.actions().selectWorkspace('workspace:two' as never)
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:two' })
  })

})
