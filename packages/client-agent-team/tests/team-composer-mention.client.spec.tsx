// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { AgentTeamClientMemberStatus, AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import { TeamDraftStore } from '../src/client/drafts.ts'
import { zh } from '../src/client/locales.ts'
import { TeamComposer } from '../src/client/TeamComposer.tsx'

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as Parameters<typeof TeamComposer>[0]['t']

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

function status(handle: string, memberId: string): AgentTeamClientMemberStatus {
  return {
    member: {
      memberId: memberId as AgentTeamMemberId,
      sessionId: 'session:one' as never,
      workspaceId: 'workspace:alpha' as never,
      handle,
      description: '',
      presetId: 'team-member',
      state: 'enabled',
    },
    availability: 'active',
    presence: 'available',
    capabilityState: 'applied',
    workspaceIds: ['workspace:alpha' as never],
  }
}

const inside = status('@insider', 'member:insider')
const outsider = status('@outsider', 'member:outsider')
const follower = status('@follower', 'member:follower')

function openMenu(ui: ReturnType<typeof render>, text: string): void {
  const textarea = ui.container.querySelector('textarea') as HTMLTextAreaElement
  // The menu matches against the draft up to the caret, so the caret has to
  // land after the token — a plain change leaves jsdom's selection at 0.
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, text)
  textarea.selectionStart = text.length
  textarea.selectionEnd = text.length
  fireEvent.change(textarea, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } })
}

function optionTexts(ui: ReturnType<typeof render>): readonly string[] {
  return [...ui.container.querySelectorAll('[role="option"]')].map(row => row.textContent ?? '')
}

afterEach(cleanup)

describe('TeamComposer mention menu', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage())
  })

  it('offers every Workspace participant, not only the Project roster', () => {
    const drafts = new TeamDraftStore()
    const ui = render(<TeamComposer members={[inside, outsider]} projectPeerMemberIds={new Set([inside.member.memberId])} drafts={drafts}
      draftKey={'project:project:one' as never} pending={false} placeholder="" pendingFiles={[]} onSubmit={() => {}} t={t} />)

    openMenu(ui, '@')
    const texts = optionTexts(ui)
    expect(texts.some(text => text.includes('insider'))).toBe(true)
    expect(texts.some(text => text.includes('outsider'))).toBe(true)
  })

  it('ranks this Thread\'s followers above other Project participants and the rest', () => {
    const drafts = new TeamDraftStore()
    const ui = render(<TeamComposer members={[outsider, inside, follower]}
      followerMemberIds={new Set([follower.member.memberId])}
      projectPeerMemberIds={new Set([inside.member.memberId])}
      drafts={drafts} draftKey={'project:project:one' as never} pending={false} placeholder="" pendingFiles={[]} onSubmit={() => {}} t={t} />)

    openMenu(ui, '@')
    const memberRows = optionTexts(ui).filter(text => /insider|outsider|follower/u.test(text))
    expect(memberRows[0]).toContain('follower')
    expect(memberRows[1]).toContain('insider')
    expect(memberRows[2]).toContain('outsider')
    // One source of truth for the row's visual weight: the tier is a row
    // attribute — the tier's rank, the numeric form the browser journey reads —
    // so styling cannot disagree with the sort order.
    const tiers = [...ui.container.querySelectorAll('[role="option"][data-mention-tier]')].map(row => row.getAttribute('data-mention-tier'))
    expect(tiers).toEqual(['0', '1', '2'])
  })

  it('keeps @all scoped to the Project even when the picker offers the wider roster', () => {
    const drafts = new TeamDraftStore()
    const ui = render(<TeamComposer members={[inside, outsider]} projectPeerMemberIds={new Set([inside.member.memberId])} drafts={drafts}
      draftKey={'project:project:one' as never} pending={false} placeholder="" pendingFiles={[]} onSubmit={() => {}} t={t} />)

    openMenu(ui, '@al')

    const allRow = [...ui.container.querySelectorAll('[role="option"]')].find(row => row.textContent?.includes('通知所有成员'))
    expect(allRow).toBeDefined()
    // The count next to `@all` is the Project's own participants; the Host
    // expands it the same way, so a Workspace-wide count would over-promise.
    expect(allRow?.textContent).toContain('1')
  })

  it('offers no @all and keeps a typed @all as plain text when the surface turns it off', () => {
    const drafts = new TeamDraftStore()
    const ui = render(<TeamComposer members={[inside]} projectPeerMemberIds={new Set([inside.member.memberId])} drafts={drafts}
      draftKey={'project:project:one' as never} pending={false} placeholder="" pendingFiles={[]} allMention={false} onSubmit={() => {}} t={t} />)

    openMenu(ui, '@')
    expect(optionTexts(ui).some(text => text.includes('通知所有成员'))).toBe(false)
    expect(optionTexts(ui).some(text => text.includes('@insider'))).toBe(true)

    // A recipient whose handle left the text is pruned even though `@all` is in it.
    drafts.writeRecipients('project:project:one' as never, new Set([inside.member.memberId]))
    openMenu(ui, '@all hello')
    expect(drafts.getSnapshot('project:project:one' as never).recipients.size).toBe(0)
  })
})
