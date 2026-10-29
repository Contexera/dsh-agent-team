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

function groups(ui: ReturnType<typeof render>): readonly (string | null)[] {
  return [...ui.container.querySelectorAll('[role="option"][data-mention-group]')].map(row => row.getAttribute('data-mention-group'))
}

afterEach(cleanup)

describe('TeamComposer mention menu', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage())
  })

  it('offers every Workspace participant, not only the Project roster', () => {
    const drafts = new TeamDraftStore()
    const ui = render(<TeamComposer members={[inside, outsider]} projectMemberIds={new Set([inside.member.memberId])} drafts={drafts}
      draftKey={'project:project:one' as never} pending={false} placeholder="" pendingFiles={[]} onSubmit={() => {}} t={t} />)

    openMenu(ui, '@')
    const texts = optionTexts(ui)
    expect(texts.some(text => text.includes('insider'))).toBe(true)
    expect(texts.some(text => text.includes('outsider'))).toBe(true)
    // The Project member sorts before the Workspace peer a pick would enroll.
    expect(groups(ui)).toEqual(['project', 'other'])
  })

  it('lists a Thread\'s follower above another Project member and a Workspace peer', () => {
    const drafts = new TeamDraftStore()
    const ui = render(<TeamComposer members={[outsider, inside, follower]}
      followerMemberIds={new Set([follower.member.memberId])}
      projectMemberIds={new Set([inside.member.memberId, follower.member.memberId])}
      drafts={drafts} draftKey={'thread:thread:one' as never} pending={false} placeholder="" pendingFiles={[]} onSubmit={() => {}} t={t} />)

    openMenu(ui, '@')
    const memberRows = optionTexts(ui).filter(text => /insider|outsider|follower/u.test(text))
    expect(memberRows[0]).toContain('follower')
    expect(memberRows[1]).toContain('insider')
    expect(memberRows[2]).toContain('outsider')
    expect(groups(ui)).toEqual(['thread', 'project', 'other'])
  })

  it('offers no @all and keeps a typed @all as plain text', () => {
    const drafts = new TeamDraftStore()
    const ui = render(<TeamComposer members={[inside]} projectMemberIds={new Set([inside.member.memberId])} drafts={drafts}
      draftKey={'project:project:one' as never} pending={false} placeholder="" pendingFiles={[]} onSubmit={() => {}} t={t} />)

    openMenu(ui, '@')
    expect(optionTexts(ui).some(text => text.includes('通知所有成员'))).toBe(false)
    expect(optionTexts(ui).some(text => text.includes('@insider'))).toBe(true)
  })

  it('shows an empty-state line when a query matches nobody, rather than closing', () => {
    const drafts = new TeamDraftStore()
    const ui = render(<TeamComposer members={[inside]} projectMemberIds={new Set([inside.member.memberId])} drafts={drafts}
      draftKey={'project:project:one' as never} pending={false} placeholder="" pendingFiles={[]} onSubmit={() => {}} t={t} />)

    openMenu(ui, '@zzz')
    expect(optionTexts(ui)).toEqual([])
    expect(ui.container.textContent).toContain(zh.mentionNoMatch)
  })
})
