// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { TeamDraftStore } from '../src/client/drafts.ts'
import { TeamComposer } from '../src/client/TeamComposer.tsx'
import { composerMemberStatus, memoryStorage, openMentionMenu, zhTranslator } from './bench/client-fixtures.tsx'

const t = zhTranslator<Parameters<typeof TeamComposer>[0]['t']>()
const storage = memoryStorage
const status = composerMemberStatus

// One Member per relation: a Project owner, a follower of this Thread, another
// Project member, and a Workspace peer the Project does not carry.
const owner = status('@owner', 'member:owner')
const follower = status('@follower', 'member:follower')
const projectPeer = status('@projectpeer', 'member:projectpeer')
const stranger = status('@stranger', 'member:stranger')

const openMenu = openMentionMenu

function rows(ui: ReturnType<typeof render>): readonly HTMLElement[] {
  return [...ui.container.querySelectorAll<HTMLElement>('[role="option"][data-mention-group]')]
}

function rowOf(ui: ReturnType<typeof render>, handle: string): HTMLElement {
  const row = rows(ui).find(candidate => candidate.textContent?.includes(handle))
  if (row === undefined) throw new Error(`no mention row for ${handle}`)
  return row
}

function renderComposer(draftKey: string): ReturnType<typeof render> {
  const drafts = new TeamDraftStore()
  return render(<TeamComposer members={[stranger, projectPeer, follower, owner]}
    followerMemberIds={new Set([follower.member.memberId])}
    projectMemberIds={new Set([owner.member.memberId, follower.member.memberId, projectPeer.member.memberId])}
    ownerMemberIds={new Set([owner.member.memberId])}
    drafts={drafts} draftKey={draftKey as never} pending={false} placeholder="" pendingFiles={[]} onSubmit={() => {}} t={t} />)
}

afterEach(cleanup)

describe('mention row weight', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage())
  })

  it('dims only a Member outside the conversation being written into', () => {
    const ui = renderComposer('thread:thread:one')
    openMenu(ui, '@')

    expect(rowOf(ui, 'owner').getAttribute('data-mention-inside')).toBe('true')
    expect(rowOf(ui, 'follower').getAttribute('data-mention-inside')).toBe('true')
    expect(rowOf(ui, 'projectpeer').getAttribute('data-mention-inside')).toBe('true')
    expect(rowOf(ui, 'stranger').getAttribute('data-mention-inside')).toBe('false')
  })

  it('treats every Project member as inside on a Project send', () => {
    const ui = renderComposer('project:project:one')
    openMenu(ui, '@')

    // A follower is still a Project member here, so only the Workspace peer is outside.
    expect(rowOf(ui, 'follower').getAttribute('data-mention-inside')).toBe('true')
    expect(rowOf(ui, 'projectpeer').getAttribute('data-mention-inside')).toBe('true')
    expect(rowOf(ui, 'stranger').getAttribute('data-mention-inside')).toBe('false')
  })
})
