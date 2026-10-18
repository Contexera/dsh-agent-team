import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  type SessionHandle,
  type SessionPersistence,
} from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { StoredSessionReader, classifyStoredSessionFailure, sessionFailureOf } from '../src/stored-session-reader.ts'

const sessionId = SessionId('session:reader-fixture')

function ioError(message: string, code: string): Error {
  const error = new Error(message)
  Object.defineProperty(error, 'code', { value: code })
  return error
}

function handleWith(overrides: { readonly events?: readonly unknown[]; readonly close?: () => Promise<void> } = {}): SessionHandle {
  return {
    id: sessionId,
    header: { id: sessionId } as never,
    inheritedEventCount: SessionLogOffset(0),
    access: 'read',
    read: vi.fn(async () => ({ eventState: 'shared' as const, events: overrides.events ?? [] as never })),
    close: overrides.close ?? (vi.fn(async () => {})),
  } as unknown as SessionHandle
}

function readerWith(persistence: Partial<SessionPersistence>): StoredSessionReader {
  return new StoredSessionReader({ sessionPersistence: persistence } as unknown as Context)
}

describe('StoredSessionReader failure normalization', () => {
  it('classifies a typed missing id as missing', async () => {
    const reader = readerWith({ open: async () => { throw new SessionPersistenceNotFoundError(sessionId) } })
    const result = await reader.read(sessionId)
    expect(result).toEqual({ ok: false, failure: { kind: 'missing', sessionId, detail: `session "${sessionId}" not found` } })
  })

  it('classifies a typed format refusal as refused and carries the artifact location', async () => {
    const refusal = new SessionFormatUnsupportedError('cannot safely transform unclassified message source', { kind: 'jsonl', path: '/tmp/log/session.v0.jsonl.zstd' })
    const reader = readerWith({ open: async () => { throw refusal } })
    const result = await reader.read(sessionId)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure.kind).toBe('refused')
    expect(result.failure.location).toEqual({ kind: 'jsonl', path: '/tmp/log/session.v0.jsonl.zstd' })
    expect(result.failure.detail).toBe('cannot safely transform unclassified message source')
  })

  it('classifies the typed corruption error and the plain corrupt-session-log text family as corrupt', async () => {
    const typed = readerWith({ open: async () => { throw new SessionPersistenceCorruptionError('validation failed', { cause: undefined }) } })
    expect(await typed.read(sessionId)).toMatchObject({ ok: false, failure: { kind: 'corrupt' } })
    const plain = readerWith({ open: async () => { throw new Error('corrupt session log: header line is not valid JSON') } })
    expect(await plain.read(sessionId)).toMatchObject({ ok: false, failure: { kind: 'corrupt', detail: 'corrupt session log: header line is not valid JSON' } })
  })

  it('classifies a direct system error code as io, and unmatched values as unknown', async () => {
    const io = readerWith({ open: async () => { throw ioError('EIO: failed', 'EIO') } })
    expect(await io.read(sessionId)).toMatchObject({ ok: false, failure: { kind: 'io', detail: 'EIO: failed' } })
    const thrown = readerWith({ open: async () => { throw 'not an error' } })
    expect(await thrown.read(sessionId)).toMatchObject({ ok: false, failure: { kind: 'unknown', detail: 'not an error' } })
  })

  it('finds the typed refusal through a wrapped cause chain', () => {
    const refusal = new SessionFormatUnsupportedError('cannot safely transform unclassified message source')
    const wrapped = new Error('failed to load the session', { cause: new Error('middle layer', { cause: refusal }) })
    const failure = sessionFailureOf(wrapped, sessionId)
    expect(failure).toMatchObject({ kind: 'refused', sessionId, detail: 'cannot safely transform unclassified message source' })
    expect(classifyStoredSessionFailure(wrapped, sessionId).kind).toBe('refused')
  })

  it('sessionFailureOf returns undefined for non-session failures, including fs errors', () => {
    expect(sessionFailureOf(new Error('private memory init failed'), sessionId)).toBeUndefined()
    expect(sessionFailureOf(ioError('ENOENT: no such file', 'ENOENT'), sessionId)).toBeUndefined()
  })

  it('returns the full inspection on success and closes the handle on every path', async () => {
    const close = vi.fn(async () => {})
    const reader = readerWith({
      open: async () => handleWith({ events: [{ type: 'turn/start' }], close }),
      stat: async () => ({ header: { id: sessionId } as never, revision: 'r1' as never }),
    })
    const result = await reader.read(sessionId)
    expect(result).toEqual({ ok: true, inspection: { header: { id: sessionId }, inheritedEventCount: 0, events: [{ type: 'turn/start' }] } })
    expect(close).toHaveBeenCalledTimes(1)
    expect(await reader.exists(sessionId)).toBe(true)
  })

  it('normalizes a close failure after a successful read', async () => {
    const close = async () => { throw new Error('close exploded') }
    const reader = readerWith({ open: async () => handleWith({ close }) })
    expect(await reader.read(sessionId)).toMatchObject({ ok: false, failure: { kind: 'unknown', detail: 'close exploded' } })
  })

  it('exists reports missing sessions as absent and propagates unexpected stat failures', async () => {
    const missing = readerWith({ stat: async () => undefined })
    expect(await missing.exists(sessionId)).toBe(false)
    const failing = readerWith({ stat: async () => { throw ioError('EBUSY', 'EBUSY') } })
    await expect(failing.exists(sessionId)).rejects.toThrow(/EBUSY/)
  })
})

/**
 * The classification contract is only as good as the error identities the real
 * backend produces. The plain-text family above is not hypothetical: the JSONL
 * backend's `assertStoredIdentity` runs OUTSIDE the decode try/catch that wraps
 * parse failures into `SessionPersistenceCorruptionError`, so an identity
 * mismatch arrives at this seam as a bare `Error`. A synthetic fixture cannot
 * show that, and probes that only covered the parse path once suggested the
 * branch was unreachable. Pin the real trigger instead of restating it.
 */
describe('corruption identity against the real JSONL backend', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  })

  async function realPersistence(): Promise<{ readonly root: string; readonly persistence: SessionPersistence }> {
    const root = await mkdtemp(join(tmpdir(), 'reader-seam-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    return { root, persistence: ctx.get('sessionPersistence') as SessionPersistence }
  }

  /** Create one stored Session and close it, so its artifact is on disk. */
  async function store(persistence: SessionPersistence, id: SessionId): Promise<void> {
    const handle = await persistence.create({ id, version: sessionFormatCatalog.currentVersion, createdAt: Date.now(), isSeeded: false, delegationDepth: 0, cwd: '/tmp' } as never)
    try {
      await handle.flush()
    } finally {
      await handle.close()
    }
  }

  /** The one required directory entry under `directory`. */
  async function entryIn(directory: string): Promise<string> {
    const [entry] = await readdir(directory)
    if (entry === undefined) throw new Error(`expected one entry in ${directory}`)
    return entry
  }

  /** The one Session artifact in a session directory, without the writer's lock. */
  async function artifactIn(directory: string): Promise<string> {
    const [artifact] = (await readdir(directory)).filter(name => !name.endsWith('.lock'))
    if (artifact === undefined) throw new Error(`expected one Session artifact in ${directory}`)
    return artifact
  }

  it('classifies an identity mismatch, which the backend throws as a bare Error, as corrupt', async () => {
    const { root, persistence } = await realPersistence()
    const owner = SessionId('session:seam-owner')
    const impostor = SessionId('session:seam-impostor')
    await store(persistence, owner)
    const bucket = join(root, await entryIn(root))
    const ownerDirectory = await entryIn(bucket)
    const known = new Set(await readdir(bucket))
    await store(persistence, impostor)
    const impostorDirectory = (await readdir(bucket)).find(name => !known.has(name))
    expect(impostorDirectory).toBeDefined()

    // Promote the owner's artifact into the impostor's directory: the header
    // inside names the owner, so the backend refuses the impostor by identity.
    const ownerArtifact = await artifactIn(join(bucket, ownerDirectory))
    const impostorArtifact = (await readdir(join(bucket, impostorDirectory!))).find(name => !name.endsWith('.lock')) ?? ownerArtifact
    await writeFile(join(bucket, impostorDirectory!, impostorArtifact), await readFile(join(bucket, ownerDirectory, ownerArtifact)))

    const thrown = await persistence.open(impostor, 'read').then(() => undefined, (error: unknown) => error)
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(SessionPersistenceCorruptionError)
    expect((thrown as Error).message).toMatch(/^corrupt session log /)

    expect(classifyStoredSessionFailure(thrown, impostor)).toMatchObject({ kind: 'corrupt', sessionId: impostor })
    expect(await readerWith(persistence).read(impostor)).toMatchObject({ ok: false, failure: { kind: 'corrupt' } })
  })
})
