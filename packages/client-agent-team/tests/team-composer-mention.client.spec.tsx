// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { TeamDraftStore } from '../src/client/drafts.ts'
import { zh } from '../src/client/locales.ts'
import { TeamComposer } from '../src/client/TeamComposer.tsx'
import { mentionedMemberIds } from '../src/client/team-formatters.ts'
import { composerMemberStatus, memoryStorage, openMentionMenu, zhTranslator } from './bench/client-fixtures.tsx'

const t = zhTranslator<Parameters<typeof TeamComposer>[0]['t']>()
const storage = memoryStorage
const status = composerMemberStatus

const inside = status('@insider', 'member:insider')
const outsider = status('@outsider', 'member:outsider')
const follower = status('@follower', 'member:follower')
const owner = status('@owner', 'member:owner')

const openMenu = openMentionMenu

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

  it('lists the owner first, then a Thread\'s follower, a Project member, and a Workspace peer', () => {
    const drafts = new TeamDraftStore()
    const ui = render(<TeamComposer members={[outsider, inside, follower, owner]}
      followerMemberIds={new Set([follower.member.memberId])}
      projectMemberIds={new Set([owner.member.memberId, inside.member.memberId, follower.member.memberId])}
      ownerMemberIds={new Set([owner.member.memberId])}
      drafts={drafts} draftKey={'thread:thread:one' as never} pending={false} placeholder="" pendingFiles={[]} onSubmit={() => {}} t={t} />)

    openMenu(ui, '@')
    const memberRows = optionTexts(ui).filter(text => /owner|insider|outsider|follower/u.test(text))
    expect(memberRows[0]).toContain('owner')
    expect(memberRows[1]).toContain('follower')
    expect(memberRows[2]).toContain('insider')
    expect(memberRows[3]).toContain('outsider')
    expect(groups(ui)).toEqual(['owner', 'thread', 'project', 'other'])
    for (const label of [zh.mentionGroupOwner, zh.mentionGroupThread, zh.mentionGroupProject, zh.mentionGroupOther]) {
      expect(ui.container.textContent).toContain(label)
    }
  })

  it('offers no @all and keeps a typed @all as plain text', () => {
    const drafts = new TeamDraftStore()
    const ui = render(<TeamComposer members={[inside]} projectMemberIds={new Set([inside.member.memberId])} drafts={drafts}
      draftKey={'project:project:one' as never} pending={false} placeholder="" pendingFiles={[]} onSubmit={() => {}} t={t} />)

    openMenu(ui, '@')
    expect(optionTexts(ui).some(text => text.includes('通知所有成员'))).toBe(false)
    expect(optionTexts(ui).some(text => text.includes('@insider'))).toBe(true)
  })

  it('opens on an @ typed straight after CJK prose, and stays shut inside an ASCII word', () => {
    const drafts = new TeamDraftStore()
    const ui = render(<TeamComposer members={[inside]} projectMemberIds={new Set([inside.member.memberId])} drafts={drafts}
      draftKey={'project:project:one' as never} pending={false} placeholder="" pendingFiles={[]} onSubmit={() => {}} t={t} />)

    openMenu(ui, '把这个给@')
    expect(optionTexts(ui).some(text => text.includes('@insider'))).toBe(true)
    // The pick lands as the text the delivery scan reads as a call, so the
    // notice the composer shows and the send agree.
    fireEvent.click(ui.getByRole('option', { name: /@insider/ }))
    const textarea = ui.container.querySelector('textarea') as HTMLTextAreaElement
    // A pick inserts one `@` plus the canonical handle, which this fixture
    // spells with its own leading `@`.
    expect(textarea.value).toBe(`把这个给@${inside.member.handle} `)
    expect(ui.queryByRole('listbox')).toBeNull()
    expect(mentionedMemberIds(textarea.value, [inside])).toEqual([inside.member.memberId])
    // Delivery keeps an address prose, so the picker must not offer a pick that
    // would land as text the Host reads as an address.
    openMenu(ui, 'mail@')
    expect(ui.queryByRole('listbox')).toBeNull()
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
