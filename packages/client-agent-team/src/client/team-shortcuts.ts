/** Team mode's keyboard commands: the rail row, the two sidebar cards, the composer, the project list, and Inbox rows. */
import type { ShortcutCommand, ShortcutCommandId, Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { AgentTeamProjectRef } from '@contexera/dsh-agent-team/types'
import { TEAM_PANEL_ID, type TeamNavigation } from './navigation.ts'
import type { TeamKey } from './locales.ts'

/** What the commands act on: Team navigation, the rail's panel selection, and the Team dictionary. */
export interface TeamShortcutHost {
  readonly navigation: TeamNavigation
  /** The shipped layout's panel selection; the rail row and these commands share it. */
  selectPanel(panelId: typeof TEAM_PANEL_ID | null): void
  readonly t: (key: TeamKey, params?: Record<string, string>) => string
}

/**
 * One chord for every device. Web keeps Alt in the chord because the browser
 * owns the bare Command combinations (N, W, T) and never delivers them here.
 * @param code - physical key code.
 * @param options - `linux: false` leaves Linux Desktop unbound; it reserves arrow chords.
 * @returns defaults for the Desktop and Web profiles this Client ships on.
 */
function altPrimary(code: string, options: { readonly linux?: boolean } = {}): ShortcutCommand['defaults'] {
  const binding = { code, modifiers: ['primary', 'alt'] as const }
  return {
    'desktop:macos': binding,
    'desktop:windows': binding,
    ...(options.linux === false ? {} : { 'desktop:linux': binding }),
    'web:macos': binding,
    'web:windows': binding,
  }
}

/**
 * A digit chord with every modifier. macOS keeps Command+Shift+3, 4, and 5 for
 * screenshots and never delivers them, so the whole family carries Alt instead
 * of leaving three of its nine members dead.
 * @param code - physical key code.
 * @returns defaults for the Desktop and Web profiles this Client ships on.
 */
function altShiftPrimary(code: string): ShortcutCommand['defaults'] {
  const binding = { code, modifiers: ['primary', 'alt', 'shift'] as const }
  return {
    'desktop:macos': binding,
    'desktop:windows': binding,
    'desktop:linux': binding,
    'web:macos': binding,
    'web:windows': binding,
  }
}

/** The Team composer's editable element, or undefined on a face that carries none (Inbox, Task board). */
function composerInput(): HTMLTextAreaElement | undefined {
  if (typeof document === 'undefined') return undefined
  return document.querySelector<HTMLTextAreaElement>('[data-team-composer] textarea') ?? undefined
}

/** Project rows in the order the sidebar shows them: the visible list is the order a reader means. */
function projectRows(): readonly AgentTeamProjectRef[] {
  if (typeof document === 'undefined') return []
  return [...document.querySelectorAll<HTMLElement>('[data-team-project-row]')]
    .flatMap(row => row.dataset.teamProjectRow === undefined ? [] : [row.dataset.teamProjectRow as AgentTeamProjectRef])
}

/** Inbox rows in the order the page shows them. */
function inboxRows(): readonly HTMLElement[] {
  if (typeof document === 'undefined') return []
  return [...document.querySelectorAll<HTMLElement>('[data-team-inbox-row]')]
}

/**
 * Register Team mode's commands against the window's shortcut service.
 * @param host - Team navigation, rail selection, and dictionary.
 * @param shortcuts - the Client's command service.
 * @returns disposer removing every command.
 */
export function registerTeamShortcuts(host: TeamShortcutHost, shortcuts: Shortcuts): () => void {
  // The rail row is a destination: leaving Team mode also hands the column back to the conversation.
  const leave = (): void => {
    host.navigation.actions().leaveTeamForConversation(() => { host.selectPanel(null) })
  }
  // A face is a destination too: the mode and the rail selection are one fact,
  // so asking for the mode first keeps a Member Session view from swallowing it.
  const open = (select: () => void): void => {
    host.navigation.actions().enterTeam()
    host.selectPanel(TEAM_PANEL_ID)
    select()
  }
  // The list wraps, so one chord reaches every Project without a second gesture.
  const step = (delta: 1 | -1): void => {
    const refs = projectRows()
    if (refs.length === 0) return
    const current = host.navigation.getSnapshot().projectRef
    const index = current === undefined ? -1 : refs.indexOf(current)
    const next = index === -1
      ? (delta === 1 ? 0 : refs.length - 1)
      : (index + delta + refs.length) % refs.length
    open(() => { host.navigation.actions().selectProject(refs[next]!) })
  }
  const commands: ShortcutCommand[] = [
    {
      id: 'team.mode.toggle' as ShortcutCommandId,
      label: () => host.t('shortcutTeamMode'),
      aliases: ['team mode', 'toggle team'],
      defaults: altPrimary('KeyT'),
      regions: ['page', 'editable'],
      modals: [],
      resolve: () => ({ status: 'handled', run: () => {
        if (host.navigation.getSnapshot().mode === 'team') leave()
        else host.selectPanel(TEAM_PANEL_ID)
      } }),
    },
    {
      id: 'team.inbox' as ShortcutCommandId,
      label: () => host.t('inboxTitle'),
      aliases: ['inbox', 'unread'],
      defaults: altPrimary('Digit1'),
      regions: ['page', 'editable'],
      modals: [],
      resolve: () => ({ status: 'handled', run: () => { open(() => { host.navigation.actions().selectInbox() }) } }),
    },
    {
      id: 'team.board' as ShortcutCommandId,
      label: () => host.t('taskBoard'),
      aliases: ['task board', 'board'],
      defaults: altPrimary('Digit2'),
      regions: ['page', 'editable'],
      modals: [],
      resolve: () => ({ status: 'handled', run: () => { open(() => { host.navigation.actions().selectBoard() }) } }),
    },
    {
      id: 'team.composer.focus' as ShortcutCommandId,
      label: () => host.t('shortcutFocusComposer'),
      aliases: ['composer', 'focus input', 'reply'],
      // Not KeyI: Chrome and Safari keep Command+Alt+I for DevTools and never deliver it to the page.
      defaults: altPrimary('KeyM'),
      regions: ['page', 'editable'],
      modals: [],
      resolve: () => ({ status: 'handled', run: () => { composerInput()?.focus() } }),
    },
    {
      id: 'team.back' as ShortcutCommandId,
      label: () => host.t('shortcutBack'),
      aliases: ['back', 'go back', 'up'],
      // ArrowLeft pairs with the Project stepping chords; Linux Desktop reserves arrow chords.
      defaults: altPrimary('ArrowLeft', { linux: false }),
      regions: ['page', 'editable'],
      modals: [],
      resolve: () => ({ status: 'handled', run: () => { host.navigation.actions().back() } }),
    },
    {
      id: 'team.forward' as ShortcutCommandId,
      label: () => host.t('shortcutForward'),
      aliases: ['forward', 'go forward', 'down'],
      defaults: altPrimary('ArrowRight', { linux: false }),
      regions: ['page', 'editable'],
      modals: [],
      resolve: () => ({ status: 'handled', run: () => { host.navigation.actions().forward() } }),
    },
    {
      id: 'team.project.previous' as ShortcutCommandId,
      label: () => host.t('shortcutPreviousProject'),
      aliases: ['previous project', 'project up'],
      defaults: altPrimary('ArrowUp', { linux: false }),
      regions: ['page', 'editable'],
      modals: [],
      resolve: () => ({ status: 'handled', run: () => { step(-1) } }),
    },
    {
      id: 'team.project.next' as ShortcutCommandId,
      label: () => host.t('shortcutNextProject'),
      aliases: ['next project', 'project down'],
      defaults: altPrimary('ArrowDown', { linux: false }),
      regions: ['page', 'editable'],
      modals: [],
      resolve: () => ({ status: 'handled', run: () => { step(1) } }),
    },
    // One command per digit: the registry matches exact combinations, so a
    // family of nine is nine rows in the reference and nine rebindable actions.
    ...Array.from({ length: 9 }, (_, offset): ShortcutCommand => ({
      id: `team.inbox.item.${offset + 1}` as ShortcutCommandId,
      label: () => host.t('shortcutInboxItem', { index: String(offset + 1) }),
      aliases: [`inbox item ${offset + 1}`],
      defaults: altShiftPrimary(`Digit${offset + 1}`),
      regions: ['page', 'editable'],
      modals: [],
      // The row opens exactly as a click on it does; a face without that row does nothing.
      resolve: () => ({ status: 'handled', run: () => { inboxRows()[offset]?.click() } }),
    })),
  ]
  const disposers = commands.map(command => shortcuts.register(command))
  return () => { for (const dispose of disposers) dispose() }
}
