// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShortcutCommand, Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'
import { bindingIssue, isWebBindingAllowed, normalizeBinding } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { TEAM_PANEL_ID, TeamNavigation } from '../src/client/navigation.ts'
import { zh } from '../src/client/locales.ts'
import { registerTeamShortcuts } from '../src/client/team-shortcuts.ts'

/** The registry surface these commands use: registration, and a disposer that forgets the row. */
function fakeShortcuts(): { shortcuts: Shortcuts; commands: ShortcutCommand[] } {
  const commands: ShortcutCommand[] = []
  const shortcuts = {
    register: (command: ShortcutCommand) => {
      commands.push(command)
      return () => {
        const index = commands.indexOf(command)
        if (index >= 0) commands.splice(index, 1)
      }
    },
  } as unknown as Shortcuts
  return { shortcuts, commands }
}

function run(command: ShortcutCommand | undefined): void {
  if (command === undefined) throw new Error('command missing')
  const resolution = command.resolve({ region: 'page', modal: null, target: null })
  if (resolution.status !== 'handled') throw new Error(`expected a handled command, got ${resolution.status}`)
  resolution.run()
}

/** The sidebar's project rows, in the order they are rendered. */
function projectRows(...refs: string[]): void {
  document.body.innerHTML = refs.map(ref => `<article data-team-project-row="${ref}"></article>`).join('')
}

function register(): { navigation: TeamNavigation; commands: ShortcutCommand[]; selectPanel: ReturnType<typeof vi.fn> } {
  const navigation = new TeamNavigation()
  const selectPanel = vi.fn()
  const { shortcuts, commands } = fakeShortcuts()
  registerTeamShortcuts({ navigation, selectPanel, t: (key, params) => zh[key].replace('{index}', params?.index ?? '') }, shortcuts)
  return { navigation, commands, selectPanel }
}

describe('Team mode shortcuts', () => {
  beforeEach(() => { localStorage.clear(); document.body.innerHTML = '' })

  it('registers every Team destination and one command per Inbox digit', () => {
    const { commands } = register()

    expect(commands.map(command => command.id)).toEqual([
      'team.mode.toggle', 'team.inbox', 'team.board', 'team.composer.focus', 'team.back', 'team.forward', 'team.project.previous', 'team.project.next',
      ...Array.from({ length: 9 }, (_, offset) => `team.inbox.item.${offset + 1}`),
    ])
    expect(commands.map(command => command.label())).toEqual([
      '进入或退出团队模式', '收件箱', '任务看板', '聚焦输入框', '返回', '前进', '上一个项目', '下一个项目',
      ...Array.from({ length: 9 }, (_, offset) => `收件箱第 ${offset + 1} 项`),
    ])
    // Web keeps Alt in the chord: the browser owns the bare Command combinations.
    expect(commands.map(command => command.defaults['web:macos'])).toEqual([
      { code: 'KeyT', modifiers: ['primary', 'alt'] },
      { code: 'Digit1', modifiers: ['primary', 'alt'] },
      { code: 'Digit2', modifiers: ['primary', 'alt'] },
      { code: 'KeyM', modifiers: ['primary', 'alt'] },
      { code: 'ArrowLeft', modifiers: ['primary', 'alt'] },
      { code: 'ArrowRight', modifiers: ['primary', 'alt'] },
      { code: 'ArrowUp', modifiers: ['primary', 'alt'] },
      { code: 'ArrowDown', modifiers: ['primary', 'alt'] },
      // macOS keeps Command+Shift+3, 4, and 5 for screenshots, so the family carries Alt.
      ...Array.from({ length: 9 }, (_, offset) => ({ code: `Digit${offset + 1}`, modifiers: ['primary', 'alt', 'shift'] })),
    ])
    expect(commands.map(command => command.defaults['desktop:macos'])).toEqual(commands.map(command => command.defaults['web:macos']))
    // Linux Web admits only three combinations, so these stay unbound there rather than throwing at registration.
    expect(commands.map(command => command.defaults['web:linux'])).toEqual(commands.map(() => undefined))
    // Linux Desktop reserves arrow chords, so the two stepping commands leave it unbound.
    expect(commands.map(command => command.defaults['desktop:linux'])).toEqual([
      { code: 'KeyT', modifiers: ['primary', 'alt'] },
      { code: 'Digit1', modifiers: ['primary', 'alt'] },
      { code: 'Digit2', modifiers: ['primary', 'alt'] },
      { code: 'KeyM', modifiers: ['primary', 'alt'] },
      undefined,
      undefined,
      undefined,
      undefined,
      ...Array.from({ length: 9 }, (_, offset) => ({ code: `Digit${offset + 1}`, modifiers: ['primary', 'alt', 'shift'] })),
    ])
  })

  it('declares only combinations the registry accepts for each profile', () => {
    const { commands } = register()
    for (const command of commands) {
      for (const [profile, binding] of Object.entries(command.defaults)) {
        const [runtime, platform] = profile.split(':') as ['desktop' | 'web', 'macos' | 'windows' | 'linux']
        const normalized = normalizeBinding(binding, platform)
        // The registry throws on a reserved or unsupported default, so this is the
        // registration gate stated as an assertion rather than discovered at boot.
        expect({ profile, issue: bindingIssue(normalized, runtime, platform) }).toEqual({ profile, issue: null })
        if (runtime === 'web') expect({ profile, allowed: isWebBindingAllowed(normalized, platform) }).toEqual({ profile, allowed: true })
      }
    }
  })

  it('toggles the mode through the rail selection the shipped layout owns', () => {
    const { navigation, commands, selectPanel } = register()
    const toggle = commands[0]

    run(toggle)
    expect(selectPanel).toHaveBeenLastCalledWith(TEAM_PANEL_ID)

    // The rail row's own ownership effect enters the mode; the command states the
    // selection and leaves the mode to that one owner.
    navigation.actions().enterTeam()
    run(toggle)
    expect(selectPanel).toHaveBeenLastCalledWith(null)
    expect(navigation.getSnapshot().mode).toBe('conversation')
  })

  it('opens a face in Team mode even from the conversation', () => {
    const { navigation, commands, selectPanel } = register()

    run(commands[1])
    expect(navigation.getSnapshot()).toMatchObject({ mode: 'team', inbox: true })
    expect(selectPanel).toHaveBeenLastCalledWith(TEAM_PANEL_ID)

    run(commands[2])
    expect(navigation.getSnapshot()).toMatchObject({ mode: 'team', board: true })
    expect(navigation.getSnapshot().inbox).toBeUndefined()
    expect(selectPanel).toHaveBeenLastCalledWith(TEAM_PANEL_ID)
  })

  it('focuses the composer the open face carries, and does nothing without one', () => {
    const { commands } = register()
    const focus = commands[3]

    run(focus)
    expect(document.activeElement).toBe(document.body)

    document.body.innerHTML = '<div data-team-composer><textarea></textarea></div>'
    run(focus)
    expect(document.activeElement?.tagName).toBe('TEXTAREA')
  })

  it('climbs one face at a time and stops at the workspace', () => {
    const { navigation, commands } = register()
    const back = commands[4]
    const state = (): ReturnType<TeamNavigation['getSnapshot']> => navigation.getSnapshot()

    // Nothing open: the chord is consumed and nothing moves.
    run(back)
    expect(state()).toEqual({ mode: 'conversation' })

    // A Member Session view returns to the session it was opened from.
    navigation.actions().enterMemberSession('session:member' as never, 'session:home' as never)
    run(back)
    expect(state().memberSessionId).toBeUndefined()
    expect(state().returnToSessionId).toBeUndefined()

    navigation.actions().selectWorkspace('workspace:w' as never)
    // A Thread page returns to its Project, and the discussion panel underneath
    // survives, so the next Back closes that instead.
    navigation.actions().selectProject('project:p' as never)
    navigation.actions().selectDiscussion('thread:d' as never, 'project:p' as never)
    navigation.actions().selectThread('thread:t' as never, 'project:p' as never)
    run(back)
    expect(state()).toMatchObject({ workspaceId: 'workspace:w', projectRef: 'project:p', discussionRef: 'thread:d' })
    expect(state().threadRef).toBeUndefined()
    run(back)
    expect(state().discussionRef).toBeUndefined()
    expect(state().projectRef).toBe('project:p')

    // The Inbox is a face of the workspace, not of a Project, so it leaves for it.
    navigation.actions().selectInbox()
    run(back)
    expect(state().inbox).toBeUndefined()
    expect(state().workspaceId).toBe('workspace:w')

    // A Project page is the last rung: Back leaves it for the welcome surface.
    navigation.actions().selectProject('project:p' as never)
    run(back)
    expect(state().projectRef).toBeUndefined()
    expect(state().workspaceId).toBe('workspace:w')

    // The welcome surface has nowhere further up.
    const welcome = state()
    run(back)
    expect(state()).toEqual(welcome)
  })

  it('re-enters the face the last Back left, and forgets it after another destination', () => {
    const { navigation, commands } = register()
    const back = commands[4]
    const forward = commands[5]
    const state = (): ReturnType<TeamNavigation['getSnapshot']> => navigation.getSnapshot()

    // Nothing to replay: Forward is consumed and nothing moves.
    run(forward)
    expect(state()).toEqual({ mode: 'conversation' })

    navigation.actions().selectWorkspace('workspace:w' as never)
    navigation.actions().selectProject('project:p' as never)
    navigation.actions().selectThread('thread:t' as never, 'project:p' as never)
    run(back)
    expect(state().threadRef).toBeUndefined()
    run(forward)
    expect(state().threadRef).toBe('thread:t')
    expect(state().projectRef).toBe('project:p')

    // Two steps back, two steps forward: the stack replays them in order.
    run(back)
    run(back)
    expect(state().projectRef).toBeUndefined()
    run(forward)
    expect(state().projectRef).toBe('project:p')
    run(forward)
    expect(state().threadRef).toBe('thread:t')

    // Any other destination makes the faces Back left stale, so Forward does nothing.
    run(back)
    navigation.actions().selectInbox()
    run(forward)
    expect(state().inbox).toBe(true)
    expect(state().threadRef).toBeUndefined()
  })

  it('steps through the project list in the order the sidebar shows it', () => {
    const { navigation, commands, selectPanel } = register()
    const previous = commands[6]
    const next = commands[7]

    // No list on screen: the chord is consumed and nothing moves.
    run(next)
    expect(navigation.getSnapshot().projectRef).toBeUndefined()

    projectRows('project:a', 'project:b', 'project:c')
    run(next)
    expect(navigation.getSnapshot()).toMatchObject({ mode: 'team', projectRef: 'project:a' })
    expect(selectPanel).toHaveBeenLastCalledWith(TEAM_PANEL_ID)

    navigation.actions().selectProject('project:b' as never)
    run(next)
    expect(navigation.getSnapshot().projectRef).toBe('project:c')

    // The list wraps, so one chord reaches every Project.
    run(next)
    expect(navigation.getSnapshot().projectRef).toBe('project:a')
    run(previous)
    expect(navigation.getSnapshot().projectRef).toBe('project:c')
  })

  it('opens the Inbox row a digit names, and nothing on a face without rows', () => {
    const { commands } = register()
    const opened: string[] = []
    document.body.innerHTML = ['a', 'b', 'c'].map(name => `<button type="button" data-team-inbox-row data-row="${name}"></button>`).join('')
    for (const row of document.querySelectorAll<HTMLElement>('[data-team-inbox-row]')) {
      row.addEventListener('click', () => { opened.push(row.dataset.row ?? '') })
    }

    // The third digit opens the third row, exactly as a click on it does.
    run(commands[8 + 2])
    expect(opened).toEqual(['c'])

    // A digit past the list opens nothing rather than reaching outside it.
    run(commands[8 + 8])
    expect(opened).toEqual(['c'])
  })
})
