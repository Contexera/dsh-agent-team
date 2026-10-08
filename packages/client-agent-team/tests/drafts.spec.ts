import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import { TEAM_DRAFTS_STORAGE_KEY, TeamDraftStore } from '../src/client/drafts.ts'

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

function stored(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(TEAM_DRAFTS_STORAGE_KEY) ?? '{}') as Record<string, unknown>
}

describe('TeamDraftStore', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage())
  })

  it('round-trips drafts and recipients per key and writes through to localStorage', () => {
    const store = new TeamDraftStore()
    const changes: string[] = []
    const off = store.subscribe(() => { changes.push(store.getSnapshot('channel:channel:one' as never).draft) })

    store.writeDraft('channel:channel:one' as never, 'half written')
    store.writeRecipients('channel:channel:one' as never, ['member:builder' as AgentTeamMemberId])

    const snapshot = store.getSnapshot('channel:channel:one' as never)
    expect(snapshot.draft).toBe('half written')
    expect([...snapshot.recipients]).toEqual(['member:builder'])
    // Snapshot identity is stable across unrelated reads for useSyncExternalStore.
    expect(store.getSnapshot('channel:channel:one' as never)).toBe(snapshot)
    expect(stored()['channel:channel:one']).toMatchObject({ draft: 'half written', recipientIds: ['member:builder'] })
    expect(changes).toEqual(['half written', 'half written'])
    off()
  })

  it('rebuilds entries from localStorage in a fresh store (refresh semantics)', () => {
    const first = new TeamDraftStore()
    first.writeDraft('thread:thread:nine' as never, 'reply draft')
    first.writeRecipients('thread:thread:nine' as never, ['member:lead' as AgentTeamMemberId])

    const second = new TeamDraftStore()
    const snapshot = second.getSnapshot('thread:thread:nine' as never)
    expect(snapshot.draft).toBe('reply draft')
    expect([...snapshot.recipients]).toEqual(['member:lead'])
  })

  it('clears one key on demand and keeps sibling keys intact', () => {
    const store = new TeamDraftStore()
    store.writeDraft('channel:channel:a' as never, 'keep me')
    store.writeDraft('thread:thread:b' as never, 'drop me')

    store.clear('thread:thread:b' as never)

    expect(store.getSnapshot('thread:thread:b' as never)).toEqual({ draft: '', recipients: new Set() })
    expect(store.getSnapshot('channel:channel:a' as never).draft).toBe('keep me')
    expect(Object.keys(stored())).toEqual(['channel:channel:a'])
  })

  it('drops fully emptied composers instead of storing them', () => {
    const store = new TeamDraftStore()
    store.writeDraft('channel:channel:a' as never, 'text')
    store.writeDraft('channel:channel:a' as never, '')

    expect(stored()['channel:channel:a']).toBeUndefined()
    // Writing emptiness into an empty slot stays silent.
    store.writeDraft('channel:channel:empty' as never, '')
    expect(stored()['channel:channel:empty']).toBeUndefined()
  })

  it('ignores identical rewrites instead of bumping savedAt or notifying', () => {
    const store = new TeamDraftStore()
    store.writeDraft('channel:channel:a' as never, 'same')
    const before = (stored()['channel:channel:a'] as { savedAt: number }).savedAt
    let notifications = 0
    const off = store.subscribe(() => { notifications += 1 })

    store.writeDraft('channel:channel:a' as never, 'same')

    expect((stored()['channel:channel:a'] as { savedAt: number }).savedAt).toBe(before)
    expect(notifications).toBe(0)
    off()
  })

  it('evicts the oldest entries beyond the retention limit', () => {
    const store = new TeamDraftStore()
    for (let index = 0; index < 51; index += 1) {
      store.writeDraft(`channel:channel:${index}` as never, `draft ${index}`)
    }
    expect(store.getSnapshot('channel:channel:0' as never).draft).toBe('')
    expect(store.getSnapshot('channel:channel:50' as never).draft).toBe('draft 50')
    expect(Object.keys(stored())).toHaveLength(50)
  })

  it('tolerates malformed persisted content', () => {
    localStorage.setItem(TEAM_DRAFTS_STORAGE_KEY, '{broken')
    expect(new TeamDraftStore().getSnapshot('channel:channel:a' as never)).toEqual({ draft: '', recipients: new Set() })

    localStorage.setItem(TEAM_DRAFTS_STORAGE_KEY, JSON.stringify({
      'channel:good': { draft: 'kept', recipientIds: [], savedAt: 1 },
      'bogus:key': { draft: 'wrong prefix', recipientIds: [], savedAt: 1 },
      'channel:mismatch': { draft: 42, recipientIds: [], savedAt: 1 },
      'thread:no-recipients': { draft: 'no ids', savedAt: 1 },
    }))
    const store = new TeamDraftStore()
    expect(store.getSnapshot('channel:good' as never).draft).toBe('kept')
    expect(store.getSnapshot('bogus:key' as never).draft).toBe('')
    expect(store.getSnapshot('channel:mismatch' as never).draft).toBe('')
    expect(store.getSnapshot('thread:no-recipients' as never).draft).toBe('')
  })
})
