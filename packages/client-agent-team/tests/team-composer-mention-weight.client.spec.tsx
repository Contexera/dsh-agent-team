// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { AgentTeamClientMemberStatus, AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import { TeamDraftStore } from '../src/client/drafts.ts'
import { zh } from '../src/client/locales.ts'
import { TeamComposer } from '../src/client/TeamComposer.tsx'

function translator(dict: Record<keyof typeof zh, string>): Parameters<typeof TeamComposer>[0]['t'] {
  return ((key: keyof typeof zh, params?: Record<string, string | number>) => {
    let value: string = dict[key]
    for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
    return value
  }) as Parameters<typeof TeamComposer>[0]['t']
}

const t = translator(zh)

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

// One Member per relation: a Project owner, a follower of this Thread, another
// Project member, and a Workspace peer the Project does not carry.
const owner = status('@owner', 'member:owner')
const follower = status('@follower', 'member:follower')
const projectPeer = status('@projectpeer', 'member:projectpeer')
const stranger = status('@stranger', 'member:stranger')

function openMenu(ui: ReturnType<typeof render>, text: string): void {
  const textarea = ui.container.querySelector('textarea') as HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, text)
  textarea.selectionStart = text.length
  textarea.selectionEnd = text.length
  fireEvent.change(textarea, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } })
}

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

describe('mention row grouping and weight', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage())
  })

  it('puts each Member in the group its relation names, with the owner leading', () => {
    const ui = renderComposer('thread:thread:one')
    openMenu(ui, '@')

    expect(rows(ui).map(row => row.getAttribute('data-mention-group'))).toEqual(['owner', 'thread', 'project', 'other'])
    expect(rowOf(ui, 'owner').getAttribute('data-mention-group')).toBe('owner')
    expect(rowOf(ui, 'follower').getAttribute('data-mention-group')).toBe('thread')
    expect(rowOf(ui, 'projectpeer').getAttribute('data-mention-group')).toBe('project')
    expect(rowOf(ui, 'stranger').getAttribute('data-mention-group')).toBe('other')
    // Each heading names its relation in words, so the grouping is readable, not colour-only.
    for (const label of [zh.mentionGroupOwner, zh.mentionGroupThread, zh.mentionGroupProject, zh.mentionGroupOther]) {
      expect(ui.container.textContent).toContain(label)
    }
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
