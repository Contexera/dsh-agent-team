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
      'team.mode.toggle', 'team.inbox', 'team.board', 'team.composer.focus', 'team.project.previous', 'team.project.next',
      ...Array.from({ length: 9 }, (_, offset) => `team.inbox.item.${offset + 1}`),
    ])
    expect(commands.map(command => command.label())).toEqual([
      '进入或退出团队模式', '收件箱', '任务看板', '聚焦输入框', '上一个项目', '下一个项目',
      ...Array.from({ length: 9 }, (_, offset) => `收件箱第 ${offset + 1} 项`),
    ])
    // Web keeps Alt in the chord: the browser owns the bare Command combinations.
    expect(commands.map(command => command.defaults['web:macos'])).toEqual([
      { code: 'KeyT', modifiers: ['primary', 'alt'] },
      { code: 'Digit1', modifiers: ['primary', 'alt'] },
      { code: 'Digit2', modifiers: ['primary', 'alt'] },
      { code: 'KeyM', modifiers: ['primary', 'alt'] },
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

  it('steps through the project list in the order the sidebar shows it', () => {
    const { navigation, commands, selectPanel } = register()
    const previous = commands[4]
    const next = commands[5]

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
    run(commands[6 + 2])
    expect(opened).toEqual(['c'])

    // A digit past the list opens nothing rather than reaching outside it.
    run(commands[6 + 8])
    expect(opened).toEqual(['c'])
  })
})
