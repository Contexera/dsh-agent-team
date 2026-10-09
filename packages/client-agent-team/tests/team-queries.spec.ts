import { describe, expect, it, vi } from 'vitest'
import { TeamQueries, type TeamQueryIdentity } from '../src/client/team-queries.ts'
import type { TeamChangeListener, TeamChangeScope, TeamChangeUpdate } from '../src/client/team-changes.ts'

/** Stand-in for TeamChangeStream: subscribers receive exactly what a test emits. */
function hub() {
  const listeners: Array<{ scope: TeamChangeScope; listener: TeamChangeListener }> = []
  return {
    changes: {
      subscribe: (scope: TeamChangeScope, listener: TeamChangeListener) => {
        const entry = { scope, listener }
        listeners.push(entry)
        return () => {
          const index = listeners.indexOf(entry)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
    },
    emit(scope: TeamChangeScope, update: TeamChangeUpdate): void {
      for (const entry of listeners) if (entry.scope === scope || entry.scope === undefined) entry.listener(update)
    },
  }
}

const workspace = { kind: 'workspace' as const, workspaceId: 'w1' as never }
const presence = { kind: 'presence' as const, workspaceId: 'w1' as never }

/**
 * Drive the continuations a resolved response queues — its landing, and the
 * guard that landing runs through — to quiescence. Both are microtasks, so
 * draining the queue is deterministic on any machine; a wall-clock wait is not,
 * and a loaded machine ends it before the landing it was waiting for.
 */
const drainContinuations = async (): Promise<void> => {
  for (let turn = 0; turn < 64; turn += 1) await Promise.resolve()
}

/** The production roster identity, mirrored: one key per Workspace. */
const roster = (): TeamQueryIdentity => ({
  key: 'members:w1',
  covers: scope => scope !== undefined
    && ((scope.kind === 'presence' || scope.kind === 'workspace') && scope.workspaceId === ('w1' as never)),
})

describe('TeamQueries', () => {
  it('shares one in-flight read between concurrent consumers of the same query', async () => {
    const { changes } = hub()
    const queries = new TeamQueries(changes)
    const load = vi.fn(async () => 'roster')
    const first = queries.read(roster(), load)
    const second = queries.read(roster(), load)
    expect(await first).toBe('roster')
    expect(await second).toBe('roster')
    expect(load).toHaveBeenCalledTimes(1)
    expect(queries.diagnostics()['members:w1']).toMatchObject({ issued: 1, shared: 1 })
  })

  it('supersedes an in-flight read on invalidation so the next consumer issues a fresh one', async () => {
    const { changes, emit } = hub()
    const queries = new TeamQueries(changes)
    queries.subscribeChanges(workspace, () => {})
    const answer = vi.fn(async () => 'roster')
    const before = queries.read(roster(), answer)
    emit(workspace, { type: 'changed', version: 1, baseline: true })
    const after = queries.read(roster(), answer)
    expect(await before).toBe('roster')
    expect(await after).toBe('roster')
    expect(answer).toHaveBeenCalledTimes(2)
    expect(queries.diagnostics()['members:w1']).toMatchObject({ issued: 2, superseded: 1 })
  })

  it('collapses one dispatch across scopes: repeated consumers join the read that dispatch issued', async () => {
    const { changes, emit } = hub()
    const queries = new TeamQueries(changes)
    queries.subscribeChanges(workspace, () => {})
    const load = vi.fn(async () => 'roster')
    // Seed the query state, then let a dispatch land with nothing in flight.
    expect(await queries.read(roster(), load)).toBe('roster')
    emit(workspace, { type: 'changed', version: 5 })
    // Consumers reacting to that dispatch share one read: the same version
    // carries no new data, so it supersedes nothing.
    const joined = queries.read(roster(), load)
    const second = queries.read(roster(), load)
    expect(await joined).toBe('roster')
    expect(await second).toBe('roster')
    // The same version arriving again does not supersede anything either.
    emit(workspace, { type: 'changed', version: 5 })
    expect(load).toHaveBeenCalledTimes(2)
    expect(queries.diagnostics()['members:w1']).toMatchObject({ issued: 2, shared: 1, superseded: 0 })
  })

  it('always invalidates on a stream-opening baseline, even at the same version', async () => {
    const { changes, emit } = hub()
    const queries = new TeamQueries(changes)
    queries.subscribeChanges(workspace, () => {})
    emit(workspace, { type: 'changed', version: 9, baseline: true })
    const held = Promise.withResolvers<string>()
    const before = queries.read(roster(), () => held.promise)
    // A reconnect reopens the stream at the same version: a plain dispatch at
    // this version would stay joinable, but the baseline must make the
    // in-flight read unjoinable so the post-reconnect consumer re-reads.
    emit(workspace, { type: 'changed', version: 9, baseline: true })
    const load = vi.fn(async () => 'roster')
    const after = queries.read(roster(), load)
    expect(load).toHaveBeenCalledTimes(1)
    expect(await after).toBe('roster')
    held.resolve('pre-reconnect roster')
    expect(await before).toBe('roster')
    expect(queries.diagnostics()['members:w1']).toMatchObject({ issued: 2, superseded: 1 })
  })

  it('drops a late stale response whole: both consumers keep the newer result', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { changes, emit } = hub()
    const queries = new TeamQueries(changes)
    queries.subscribeChanges(workspace, () => {})
    const oldAnswer = Promise.withResolvers<string>()
    const newAnswer = Promise.withResolvers<string>()
    const oldRead = queries.read(roster(), () => oldAnswer.promise)
    emit(workspace, { type: 'changed', version: 1, baseline: true })
    const newRead = queries.read(roster(), () => newAnswer.promise)
    newAnswer.resolve('fresh roster')
    expect(await newRead).toBe('fresh roster')
    oldAnswer.resolve('old roster')
    // The stale response's consumer receives the newer result, not its own payload.
    expect(await oldRead).toBe('fresh roster')
    expect(queries.diagnostics()['members:w1']).toMatchObject({ droppedStale: 1 })
    const logged = info.mock.calls.filter(call => String(call[0]).includes('stale read response'))
    expect(logged).toHaveLength(1)
    expect(JSON.stringify(logged[0]!.slice(1))).not.toContain('roster')
    info.mockRestore()
  })

  it('surfaces a read failure when nothing newer landed, and never as an empty success', async () => {
    const { changes } = hub()
    const queries = new TeamQueries(changes)
    const failure = queries.read(roster(), () => Promise.reject(new Error('roster offline')))
    await expect(failure).rejects.toThrow('roster offline')
    expect(queries.diagnostics()['members:w1']).toMatchObject({ failed: 1, droppedStale: 0 })
  })

  it('drops a stale failure too: an old error never masks the newer result', async () => {
    const { changes, emit } = hub()
    const queries = new TeamQueries(changes)
    queries.subscribeChanges(workspace, () => {})
    const stale = Promise.withResolvers<string>()
    const current = Promise.withResolvers<string>()
    const staleRead = queries.read(roster(), () => stale.promise)
    emit(workspace, { type: 'changed', version: 1, baseline: true })
    const currentRead = queries.read(roster(), () => current.promise)
    current.resolve('fresh roster')
    expect(await currentRead).toBe('fresh roster')
    stale.reject(new Error('late failure'))
    expect(await staleRead).toBe('fresh roster')
    expect(queries.diagnostics()['members:w1']).toMatchObject({ failed: 1, droppedStale: 1 })
  })

  it('counts a failure answered inside the payload as failed without changing delivery', async () => {
    const { changes } = hub()
    const queries = new TeamQueries(changes)
    const failure = { ok: false as const, error: { message: 'roster down' } }
    const result = await queries.read(roster(), async () => failure)
    // The consumer's own result.ok face still renders the error — the
    // counter observes, delivery is unchanged.
    expect(result).toBe(failure)
    expect(queries.diagnostics()['members:w1']).toMatchObject({ issued: 1, failed: 1 })
  })

  it('newGeneration resets watermarks and stops joining the old generation\'s reads', async () => {
    const { changes, emit } = hub()
    const queries = new TeamQueries(changes)
    queries.subscribeChanges(presence, () => {})
    emit(presence, { type: 'changed', version: 3 })
    const held = Promise.withResolvers<string>()
    const oldGeneration = queries.read(roster(), () => held.promise)
    queries.newGeneration()
    // The restarted generation repeats the same presence version: the reset
    // watermark lets it invalidate instead of colliding with the old epoch.
    emit(presence, { type: 'changed', version: 3 })
    const load = vi.fn(async () => 'fresh roster')
    const fresh = queries.read(roster(), load)
    expect(await fresh).toBe('fresh roster')
    expect(load).toHaveBeenCalledTimes(1)
    // The old generation's read is not joinable anymore.
    expect(queries.diagnostics()['members:w1']?.issued).toBe(2)
    held.resolve('stale roster')
    expect(await oldGeneration).toBe('fresh roster')
  })

  it('keeps diagnostics per query key', async () => {
    const { changes } = hub()
    const queries = new TeamQueries(changes)
    const other: TeamQueryIdentity = { key: 'members:w2', covers: () => true }
    await queries.read(roster(), async () => 'w1')
    await queries.read(other, async () => 'w2')
    expect(Object.keys(queries.diagnostics()).sort()).toEqual(['members:w1', 'members:w2'])
    expect(queries.diagnostics()['members:w1']).toMatchObject({ issued: 1, failed: 0 })
  })

  it('never applies a superseded response and moves its waiters to the read that replaced it', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { changes, emit } = hub()
    const queries = new TeamQueries(changes)
    queries.subscribeChanges(workspace, () => {})
    const expired = Promise.withResolvers<string>()
    const fresh = Promise.withResolvers<string>()
    const expiredRead = queries.read(roster(), () => expired.promise)
    emit(workspace, { type: 'changed', version: 1, baseline: true })
    const freshRead = queries.read(roster(), () => fresh.promise)
    // The superseded response lands first, with nothing newer applied yet: it
    // must not become state, and its waiters must not see its payload.
    expired.resolve('expired payload')
    await drainContinuations()
    expect(queries.diagnostics()['members:w1']).toMatchObject({ droppedSuperseded: 1, droppedStale: 0 })
    fresh.resolve('fresh roster')
    expect(await freshRead).toBe('fresh roster')
    expect(await expiredRead).toBe('fresh roster')
    const logged = info.mock.calls.filter(call => String(call[0]).includes('stale read response dropped'))
    expect(logged).toHaveLength(1)
    expect(JSON.stringify(logged[0]!.slice(1))).toContain('superseded')
    expect(JSON.stringify(logged[0]!.slice(1))).not.toContain('payload')
    info.mockRestore()
  })

  it('reissues the read itself when an invalidation supersedes it and nothing replaced it', async () => {
    const { changes, emit } = hub()
    const queries = new TeamQueries(changes)
    queries.subscribeChanges(workspace, () => {})
    expect(await queries.read(roster(), async () => 'landed roster')).toBe('landed roster')
    const expired = Promise.withResolvers<string>()
    const fresh = Promise.withResolvers<string>()
    let calls = 0
    const pending = queries.read(roster(), () => (calls++ === 0 ? expired.promise : fresh.promise))
    emit(workspace, { type: 'changed', version: 2, baseline: true })
    // The wake's own listener lives on another surface, so no consumer
    // re-reads: the layer must issue the replacement itself — the waiters get
    // post-change data, never the expired payload and never the pre-change
    // result they would keep showing forever.
    expired.resolve('expired payload')
    await drainContinuations()
    expect(queries.diagnostics()['members:w1']).toMatchObject({ issued: 3, droppedSuperseded: 1, droppedStale: 0 })
    fresh.resolve('post-change roster')
    expect(await pending).toBe('post-change roster')
  })

  it('does not reissue after dispose; waiters get the last landed result', async () => {
    const { changes, emit } = hub()
    const queries = new TeamQueries(changes)
    queries.subscribeChanges(workspace, () => {})
    expect(await queries.read(roster(), async () => 'landed roster')).toBe('landed roster')
    const held = Promise.withResolvers<string>()
    let calls = 0
    const pending = queries.read(roster(), () => { calls += 1; return held.promise })
    emit(workspace, { type: 'changed', version: 3, baseline: true })
    queries.dispose()
    held.resolve('expired payload')
    await drainContinuations()
    expect(calls).toBe(1)
    expect(await pending).toBe('landed roster')
  })

  it('newGeneration blocks the old generation\'s response from reaching any reader', async () => {
    const { changes } = hub()
    const queries = new TeamQueries(changes)
    queries.subscribeChanges(workspace, () => {})
    expect(await queries.read(roster(), async () => 'pre-reset roster')).toBe('pre-reset roster')
    const oldGeneration = Promise.withResolvers<string>()
    const reissuedLoad = Promise.withResolvers<string>()
    const dying = queries.read(roster(), () => oldGeneration.promise)
    queries.newGeneration()
    const reissued = queries.read(roster(), () => reissuedLoad.promise)
    // The old generation answers while the post-reset read is still in flight:
    // nothing newer has landed, so only the superseded guard stands between
    // that payload and a post-reset reader.
    oldGeneration.resolve('old generation payload')
    await drainContinuations()
    expect(queries.diagnostics()['members:w1']).toMatchObject({ droppedSuperseded: 1, droppedStale: 0 })
    reissuedLoad.resolve('post-reset roster')
    expect(await reissued).toBe('post-reset roster')
    expect(await dying).toBe('post-reset roster')
  })
})
