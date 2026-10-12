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

// One Member per tier: follows this Thread, takes part in the Channel only,
// and the rest of the Workspace.
const follower = status('@follower', 'member:follower')
const channelPeer = status('@channelpeer', 'member:channelpeer')
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
  return [...ui.container.querySelectorAll<HTMLElement>('[role="option"][data-mention-tier]')]
}

function rowOf(ui: ReturnType<typeof render>, handle: string): HTMLElement {
  const row = rows(ui).find(candidate => candidate.textContent?.includes(handle))
  if (row === undefined) throw new Error(`no mention row for ${handle}`)
  return row
}

function renderComposer(draftKey: string): ReturnType<typeof render> {
  const drafts = new TeamDraftStore()
  return render(<TeamComposer members={[stranger, channelPeer, follower]}
    followerMemberIds={new Set([follower.member.memberId])}
    channelPeerMemberIds={new Set([channelPeer.member.memberId])}
    drafts={drafts} draftKey={draftKey as never} pending={false} placeholder="" pendingFiles={[]} onSubmit={() => {}} t={t} />)
}

afterEach(cleanup)

describe('mention row weight', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage())
  })

  it('dims a name by whether the Member is in the conversation being written into', () => {
    const ui = renderComposer('thread:thread:one')
    openMenu(ui, '@')

    // Weight reads whether the Member is in this Thread. A Channel peer takes
    // part in the Channel yet not in this Thread, so its name drops a weight
    // even though the Channel counts it as a participant.
    expect(rowOf(ui, 'follower').getAttribute('data-mention-inside')).toBe('true')
    expect(rowOf(ui, 'channelpeer').getAttribute('data-mention-inside')).toBe('false')
    expect(rowOf(ui, 'stranger').getAttribute('data-mention-inside')).toBe('false')
  })

  it('keeps a Channel peer at full weight on a Channel send, where it is inside', () => {
    const ui = renderComposer('channel:channel:one')
    openMenu(ui, '@')

    // The two surfaces disagree about the same tier: the Channel is the
    // conversation here, so taking part in it is taking part in this.
    expect(rowOf(ui, 'follower').getAttribute('data-mention-inside')).toBe('true')
    expect(rowOf(ui, 'channelpeer').getAttribute('data-mention-inside')).toBe('true')
    expect(rowOf(ui, 'stranger').getAttribute('data-mention-inside')).toBe('false')
  })

  it('states no consequence on a row, on either surface', () => {
    // Weight is the whole of the row's distinction: the Host's confirmation is
    // announced by the status line after the send, so no row carries words of
    // its own. This is the decision, not an accident — the note that used to sit
    // beside the description must not come back on any tier of either surface.
    for (const draftKey of ['thread:thread:one', 'channel:channel:one']) {
      const ui = renderComposer(draftKey)
      openMenu(ui, '@')
      for (const row of rows(ui)) {
        expect(row.textContent).not.toContain(zh.mentionConfirmation)
        expect(row.textContent).not.toContain('需确认')
      }
    }
  })
})
