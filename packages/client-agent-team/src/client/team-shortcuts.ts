import type { ShortcutCommand, ShortcutCommandId, Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { AgentTeamProjectRef } from '@contexera/dsh-agent-team/types'
import { TEAM_PANEL_ID, type TeamNavigation } from './navigation.ts'
import type { TeamKey } from './locales.ts'

export interface TeamShortcutHost {
  readonly navigation: TeamNavigation
  /** The shipped layout's panel selection; the rail row and these commands share it. */
  selectPanel(panelId: typeof TEAM_PANEL_ID | null): void
  /** The pointer entry's complete manager navigation, including its panel handoff and ordinary return target. */
  selectManager(): void
  readonly t: (key: TeamKey, params?: Record<string, string>) => string
}

function shortcutDefaults(code: string, modifiers: readonly ('primary' | 'alt' | 'shift')[], linuxDesktop: boolean): ShortcutCommand['defaults'] {
  const binding = { code, modifiers }
  return {
    'desktop:macos': binding,
    'desktop:windows': binding,
    ...(linuxDesktop ? { 'desktop:linux': binding } : {}),
    'web:macos': binding,
    'web:windows': binding,
  }
}

function altPrimary(code: string, linuxDesktop = true): ShortcutCommand['defaults'] {
  // The browser never delivers bare Command combinations like Command+T.
  return shortcutDefaults(code, ['primary', 'alt'], linuxDesktop)
}

function focusComposer(): void {
  if (typeof document === 'undefined') return
  document.querySelector<HTMLTextAreaElement>('[data-team-composer] textarea')?.focus()
}

/** Project rows in the order the sidebar shows them: the visible list is the order a reader means. */
function projectRows(): readonly AgentTeamProjectRef[] {
  if (typeof document === 'undefined') return []
  return [...document.querySelectorAll<HTMLElement>('[data-team-project-row]')]
    .flatMap(row => row.dataset.teamProjectRow === undefined ? [] : [row.dataset.teamProjectRow as AgentTeamProjectRef])
}

function openInboxRow(offset: number): void {
  if (typeof document === 'undefined') return
  document.querySelectorAll<HTMLElement>('[data-team-inbox-row]')[offset]?.click()
}

function openTeamDestination(host: TeamShortcutHost, select: () => void): void {
  // A face is a destination too: the mode and the rail selection are one fact,
  // so asking for the mode first keeps a Member Session view from swallowing it.
  host.navigation.actions().enterTeam()
  host.selectPanel(TEAM_PANEL_ID)
  select()
}

function stepProject(host: TeamShortcutHost, delta: 1 | -1): void {
  const refs = projectRows()
  if (refs.length === 0) return
  const current = host.navigation.getSnapshot().projectRef
  const index = current === undefined ? -1 : refs.indexOf(current)
  const next = index === -1
    ? (delta === 1 ? 0 : refs.length - 1)
    : (index + delta + refs.length) % refs.length
  openTeamDestination(host, () => { host.navigation.actions().selectProject(refs[next]!) })
}

type TeamCommand = Omit<ShortcutCommand, 'id' | 'regions' | 'modals' | 'resolve'> & {
  readonly id: `team.${string}`
  readonly run: () => void
}

function teamCommand({ id, run, ...command }: TeamCommand): ShortcutCommand {
  return {
    ...command,
    id: id as ShortcutCommandId,
    regions: ['page', 'editable'],
    modals: [],
    resolve: () => ({ status: 'handled', run }),
  }
}

function teamCommands(host: TeamShortcutHost): TeamCommand[] {
  const open = (select: () => void): void => { openTeamDestination(host, select) }
  return [
    {
      id: 'team.mode.toggle',
      label: () => host.t('shortcutTeamMode'),
      aliases: ['team mode', 'toggle team'],
      defaults: altPrimary('KeyT'),
      run: () => {
        if (host.navigation.getSnapshot().mode === 'team') {
          host.navigation.actions().leaveTeamForConversation(() => { host.selectPanel(null) })
        }
        else host.selectPanel(TEAM_PANEL_ID)
      },
    },
    {
      id: 'team.inbox',
      label: () => host.t('inboxTitle'),
      aliases: ['inbox', 'unread'],
      defaults: altPrimary('Digit1'),
      run: () => { open(() => { host.navigation.actions().selectInbox() }) },
    },
    {
      id: 'team.board',
      label: () => host.t('taskBoard'),
      aliases: ['task board', 'board'],
      defaults: altPrimary('Digit2'),
      run: () => { open(() => { host.navigation.actions().selectBoard() }) },
    },
    {
      id: 'team.manager',
      label: () => host.t('teamManager'),
      aliases: ['team manager', 'manager', 'management'],
      defaults: altPrimary('Digit3'),
      run: () => { open(host.selectManager) },
    },
    {
      id: 'team.composer.focus',
      label: () => host.t('shortcutFocusComposer'),
      aliases: ['composer', 'focus input', 'reply'],
      // Not KeyI: Chrome and Safari keep Command+Alt+I for DevTools and never deliver it to the page.
      defaults: altPrimary('KeyM'),
      run: focusComposer,
    },
    {
      id: 'team.back',
      label: () => host.t('shortcutBack'),
      aliases: ['back', 'go back', 'up'],
      // Linux Desktop reserves these arrow chords.
      defaults: altPrimary('ArrowLeft', false),
      run: () => { host.navigation.actions().back() },
    },
    {
      id: 'team.forward',
      label: () => host.t('shortcutForward'),
      aliases: ['forward', 'go forward', 'down'],
      defaults: altPrimary('ArrowRight', false),
      run: () => { host.navigation.actions().forward() },
    },
    {
      id: 'team.project.previous',
      label: () => host.t('shortcutPreviousProject'),
      aliases: ['previous project', 'project up'],
      defaults: altPrimary('ArrowUp', false),
      run: () => { stepProject(host, -1) },
    },
    {
      id: 'team.project.next',
      label: () => host.t('shortcutNextProject'),
      aliases: ['next project', 'project down'],
      defaults: altPrimary('ArrowDown', false),
      run: () => { stepProject(host, 1) },
    },
    // One command per digit: the registry matches exact combinations, so a
    // family of nine is nine rows in the reference and nine rebindable actions.
    ...Array.from({ length: 9 }, (_, offset): TeamCommand => ({
      id: `team.inbox.item.${offset + 1}`,
      label: () => host.t('shortcutInboxItem', { index: String(offset + 1) }),
      aliases: [`inbox item ${offset + 1}`],
      // macOS reserves Command+Shift+3 through 5 for screenshots.
      defaults: shortcutDefaults(`Digit${offset + 1}`, ['primary', 'alt', 'shift'], true),
      run: () => { openInboxRow(offset) },
    })),
  ]
}

export function registerTeamShortcuts(host: TeamShortcutHost, shortcuts: Shortcuts): () => void {
  const disposers = teamCommands(host).map(command => shortcuts.register(teamCommand(command)))
  return () => { for (const dispose of disposers) dispose() }
}
