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
    const off = store.subscribe(() => { changes.push(store.getSnapshot('project:project:one' as never).draft) })

    store.writeDraft('project:project:one' as never, 'half written')
    store.writeRecipients('project:project:one' as never, ['member:builder' as AgentTeamMemberId])

    const snapshot = store.getSnapshot('project:project:one' as never)
    expect(snapshot.draft).toBe('half written')
    expect([...snapshot.recipients]).toEqual(['member:builder'])
    // Snapshot identity is stable across unrelated reads for useSyncExternalStore.
    expect(store.getSnapshot('project:project:one' as never)).toBe(snapshot)
    expect(stored()['project:project:one']).toMatchObject({ draft: 'half written', recipientIds: ['member:builder'] })
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

  it('keeps a Project draft saved before Projects were renamed from Channels', () => {
    localStorage.setItem(TEAM_DRAFTS_STORAGE_KEY, JSON.stringify({ 'channel:channel:old': { draft: 'kept', recipientIds: [], savedAt: 1 } }))
    expect(new TeamDraftStore().getSnapshot('project:project:old' as never).draft).toBe('kept')
  })

  it('clears one key on demand and keeps sibling keys intact', () => {
    const store = new TeamDraftStore()
    store.writeDraft('project:project:a' as never, 'keep me')
    store.writeDraft('thread:thread:b' as never, 'drop me')

    store.clear('thread:thread:b' as never)

    expect(store.getSnapshot('thread:thread:b' as never)).toEqual({ draft: '', recipients: new Set() })
    expect(store.getSnapshot('project:project:a' as never).draft).toBe('keep me')
    expect(Object.keys(stored())).toEqual(['project:project:a'])
  })

  it('drops fully emptied composers instead of storing them', () => {
    const store = new TeamDraftStore()
    store.writeDraft('project:project:a' as never, 'text')
    store.writeDraft('project:project:a' as never, '')

    expect(stored()['project:project:a']).toBeUndefined()
    store.writeDraft('project:project:empty' as never, '')
    expect(stored()['project:project:empty']).toBeUndefined()
  })

  it('ignores identical rewrites instead of bumping savedAt or notifying', () => {
    const store = new TeamDraftStore()
    store.writeDraft('project:project:a' as never, 'same')
    const before = (stored()['project:project:a'] as { savedAt: number }).savedAt
    let notifications = 0
    const off = store.subscribe(() => { notifications += 1 })

    store.writeDraft('project:project:a' as never, 'same')

    expect((stored()['project:project:a'] as { savedAt: number }).savedAt).toBe(before)
    expect(notifications).toBe(0)
    off()
  })

  it('evicts the oldest entries beyond the retention limit', () => {
    const store = new TeamDraftStore()
    for (let index = 0; index < 51; index += 1) {
      store.writeDraft(`project:project:${index}` as never, `draft ${index}`)
    }
    expect(store.getSnapshot('project:project:0' as never).draft).toBe('')
    expect(store.getSnapshot('project:project:50' as never).draft).toBe('draft 50')
    expect(Object.keys(stored())).toHaveLength(50)
  })

  it('tolerates malformed persisted content', () => {
    localStorage.setItem(TEAM_DRAFTS_STORAGE_KEY, '{broken')
    expect(new TeamDraftStore().getSnapshot('project:project:a' as never)).toEqual({ draft: '', recipients: new Set() })

    localStorage.setItem(TEAM_DRAFTS_STORAGE_KEY, JSON.stringify({
      'project:good': { draft: 'kept', recipientIds: [], savedAt: 1 },
      'bogus:key': { draft: 'wrong prefix', recipientIds: [], savedAt: 1 },
      'project:mismatch': { draft: 42, recipientIds: [], savedAt: 1 },
      'thread:no-recipients': { draft: 'no ids', savedAt: 1 },
    }))
    const store = new TeamDraftStore()
    expect(store.getSnapshot('project:good' as never).draft).toBe('kept')
    expect(store.getSnapshot('bogus:key' as never).draft).toBe('')
    expect(store.getSnapshot('project:mismatch' as never).draft).toBe('')
    expect(store.getSnapshot('thread:no-recipients' as never).draft).toBe('')
  })
})
