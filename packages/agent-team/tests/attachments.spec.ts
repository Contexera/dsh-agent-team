import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

/** Escape a literal string for embedding in a RegExp (path separators differ per platform). */
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
import { Context } from '@deepseek-ai/cordis'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { harness as bootHostHarness } from './helpers/host-harness.ts'
import { ATTACHMENT_MAX_BYTES, attachmentsRoot, mediaTypeForPath, pathAttachmentId, readAttachment, requestScopedAttachmentId, sanitizeFileName, sanitizeMediaType, sweepAttachmentCache, validatePathAttachment, writeAttachment } from '../src/attachments.ts'
import AgentTeam from '../src/index.ts'
import { AgentTeamLedger } from '../src/ledger.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
import type { AgentTeamAttachmentId, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const originalDshHome = process.env.DSH_HOME
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
const newAttachmentId = (): AgentTeamAttachmentId => randomUUID() as AgentTeamAttachmentId

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
})

async function harness(): Promise<{ readonly ctx: Context; readonly facility: DomainFacility; readonly restart: () => Promise<void> }> {
  const booted = await bootHostHarness({
    prepare: async ctx => {
      await ctx.plugin(agentTeamInvariant)
    },
  })
  let fiber = booted.fiber
  const restart = async (): Promise<void> => {
    await fiber.dispose()
    fiber = await booted.ctx.plugin(AgentTeam)
  }
  return { ctx: booted.ctx, facility: booted.facility, restart }
}

/** Every attachment cache entry this spec's shared DSH home currently holds, order-independent. */
async function cacheEntries(): Promise<readonly string[]> {
  return (await readdir(attachmentsRoot()).catch(() => [] as string[])).sort()
}

function ledgerAtBoot(facility: DomainFacility): AgentTeamLedger {
  return new AgentTeamLedger(facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
}

describe('attachment file hygiene', () => {
  it('strips path separators, control characters, and dot prefixes from names', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('etcpasswd')
    expect(sanitizeFileName('report\u0000\u001f.pdf')).toBe('report.pdf')
    expect(sanitizeFileName('a/b\\c.png')).toBe('abc.png')
    expect(sanitizeFileName('...hidden')).toBe('hidden')
    expect(sanitizeFileName('   ')).toBe('attachment')
    expect(sanitizeFileName(`${'x'.repeat(400)}.pdf`)).toHaveLength(180)
    expect(sanitizeFileName('meta.json')).toBe('_meta.json')
    expect(sanitizeFileName('META.JSON')).toBe('_META.JSON')
  })

  it('strips Windows-reserved names, illegal characters, and trailing spaces and dots', () => {
    // Reserved Win32 device names, including the with-extension form.
    expect(sanitizeFileName('CON')).toBe('_CON')
    expect(sanitizeFileName('con.txt')).toBe('_con.txt')
    expect(sanitizeFileName('PRN')).toBe('_PRN')
    expect(sanitizeFileName('AUX')).toBe('_AUX')
    expect(sanitizeFileName('NUL')).toBe('_NUL')
    expect(sanitizeFileName('COM1')).toBe('_COM1')
    expect(sanitizeFileName('lpt9.log')).toBe('_lpt9.log')
    // CON alone is reserved; longer words merely start with those letters.
    expect(sanitizeFileName('CONTRIBUTING.md')).toBe('CONTRIBUTING.md')
    // Colons would parse as NTFS alternate data streams.
    expect(sanitizeFileName('report:final.md')).toBe('reportfinal.md')
    // Characters Windows paths reserve.
    expect(sanitizeFileName('a<b>c|d"e?f*g.h')).toBe('abcdefg.h')
    // Trailing spaces and dots are illegal path suffixes on Windows.
    expect(sanitizeFileName('report ')).toBe('report')
    expect(sanitizeFileName('report.')).toBe('report')
    expect(sanitizeFileName('report .  .')).toBe('report')
    expect(sanitizeFileName('. . ')).toBe('attachment')
    // Every cleaned name above is a legal file name on all three platforms.
    for (const name of ['_con.txt', 'reportfinal.md', 'abcdefg.h', 'report', sanitizeFileName('a/b\\c.png'), sanitizeFileName('report\u0000\u001f.pdf')]) {
      expect(name.length).toBeGreaterThan(0)
      expect(name.length).toBeLessThanOrEqual(180)
      // oxlint-disable-next-line no-control-regex -- the assertion intentionally matches control characters.
      expect(name).not.toMatch(/[\\/:*?"<>|\u0000-\u001f\u007f]/)
      expect(name).not.toMatch(/[\s.]$/)
      expect(name).not.toMatch(/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i)
    }
  })

  it('accepts well-formed media types and falls back for anything else', () => {
    expect(sanitizeMediaType('image/png')).toBe('image/png')
    expect(sanitizeMediaType('Application/PDF')).toBe('application/pdf')
    expect(sanitizeMediaType('vnd.x+y')).toBe('application/octet-stream')
    expect(sanitizeMediaType('../etc')).toBe('application/octet-stream')
    expect(sanitizeMediaType(undefined)).toBe('application/octet-stream')
  })
})

describe('attachment cache', () => {
  it('writes immutable payload plus metadata and reads it back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-attachments-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const id = newAttachmentId()
    const stored = await writeAttachment(root, id, '../report final.pdf', 'application/pdf', Buffer.from('payload'))
    expect(stored.name).toBe('report final.pdf')
    expect(stored.byteSize).toBe(7)
    expect(stored.path).toBe(join(root, id, 'report final.pdf'))
    const readBack = await readAttachment(root, id)
    expect(readBack).toMatchObject({ kind: 'found', attachment: { name: 'report final.pdf', mediaType: 'application/pdf' } })
    if (readBack.kind === 'found') expect(readBack.attachment.bytes.toString('utf8')).toBe('payload')
    expect(await readFile(join(root, id, 'meta.json'), 'utf8')).toContain('uploadedAt')
  })

  it('keeps a payload named meta.json readable by reserving the sidecar name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-attachments-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const id = newAttachmentId()
    const stored = await writeAttachment(root, id, 'meta.json', 'application/json', Buffer.from('payload'))
    expect(stored.name).toBe('_meta.json')
    const readBack = await readAttachment(root, id)
    expect(readBack).toMatchObject({ kind: 'found', attachment: { name: '_meta.json' } })
    if (readBack.kind === 'found') expect(readBack.attachment.bytes.toString('utf8')).toBe('payload')
    expect(JSON.parse(await readFile(join(root, id, 'meta.json'), 'utf8'))).toMatchObject({ name: '_meta.json' })
  })

  it('stores a payload named after a Windows reserved device under the underscore prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-attachments-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const id = newAttachmentId()
    const stored = await writeAttachment(root, id, 'aux.txt', 'text/plain', Buffer.from('payload'))
    expect(stored.name).toBe('_aux.txt')
    const readBack = await readAttachment(root, id)
    expect(readBack).toMatchObject({ kind: 'found', attachment: { name: '_aux.txt' } })
    if (readBack.kind === 'found') expect(readBack.attachment.bytes.toString('utf8')).toBe('payload')
  })

  it('sweeps orphans after 24h and referenced uploads only after 72h', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-attachments-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const orphan = newAttachmentId()
    const fresh = newAttachmentId()
    const old = newAttachmentId()
    await writeAttachment(root, orphan, 'orphan.txt', 'text/plain', Buffer.from('a'))
    await writeAttachment(root, fresh, 'fresh.txt', 'text/plain', Buffer.from('b'))
    await writeAttachment(root, old, 'old.txt', 'text/plain', Buffer.from('c'))
    // Backdate meta so the sweep sees ages without sleeping.
    const now = Date.now()
    await writeFile(join(root, orphan, 'meta.json'), JSON.stringify({ name: 'orphan.txt', mediaType: 'text/plain', uploadedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() }))
    await writeFile(join(root, fresh, 'meta.json'), JSON.stringify({ name: 'fresh.txt', mediaType: 'text/plain', uploadedAt: new Date(now - 73 * 60 * 60 * 1000).toISOString() }))
    await writeFile(join(root, old, 'meta.json'), JSON.stringify({ name: 'old.txt', mediaType: 'text/plain', uploadedAt: new Date(now - 30 * 60 * 60 * 1000).toISOString() }))

    // Sweep with `old` (30h) and `fresh` (73h) referenced: the orphan is past
    // 24h and `fresh` is past its 72h consumption window; `old` survives.
    const removed = await sweepAttachmentCache(root, id => id === old || id === fresh, now)
    expect([...removed].sort()).toEqual([orphan, fresh].sort())
    await expect(readAttachment(root, old)).resolves.toMatchObject({ kind: 'found' })
    await expect(readAttachment(root, fresh)).resolves.toEqual({ kind: 'missing' })
    // A later sweep with `old` still referenced leaves it alone.
    const later = await sweepAttachmentCache(root, id => id === old, now + 60 * 60 * 1000)
    expect(later).toEqual([])
    expect(await readdir(root)).toEqual([old])
  })
  it('reclaims abandoned partial uploads while protecting recent and referenced entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-attach-partial-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const abandoned = newAttachmentId()
    const corrupt = newAttachmentId()
    const referenced = newAttachmentId()
    const recent = requestScopedAttachmentId('recent-partial')
    const foreign = 'not-a-cache-entry'
    const now = Date.now()
    const old = new Date(now - 25 * 60 * 60 * 1000)
    for (const name of [abandoned, corrupt, referenced, recent, foreign]) {
      const dir = join(root, name)
      await mkdir(dir)
      await writeFile(join(dir, 'payload.txt'), 'partial upload')
      if (name === corrupt) await writeFile(join(dir, 'meta.json'), '{"name":')
      if (name !== recent) await utimes(dir, old, old)
    }
    const redirected = newAttachmentId()
    await symlink(join(root, foreign), join(root, redirected), 'junction')

    const removed = await sweepAttachmentCache(root, id => id === referenced, now)

    expect([...removed].sort()).toEqual([abandoned, corrupt].sort())
    expect((await readdir(root)).sort()).toEqual([foreign, recent, redirected, referenced].sort())
    expect(await readFile(join(root, redirected, 'payload.txt'), 'utf8')).toBe('partial upload')
  })
})

describe('Agent Team attachment remotes', () => {
  it('refuses a concurrent upload with the same request id and different bytes', async () => {
    const { ctx } = await harness()
    const request = { requestId: requestId('put-concurrent'), workspaceId: alpha, name: 'report.txt' }
    const first = Buffer.from('first upload').toString('base64')
    const second = Buffer.from('conflicting payload').toString('base64')

    const [accepted, conflict, replay] = await Promise.allSettled([
      ctx.agentTeam.putAttachment({ ...request, bytesBase64: first }),
      ctx.agentTeam.putAttachment({ ...request, bytesBase64: second }),
      ctx.agentTeam.putAttachment({ ...request, bytesBase64: first }),
    ])

    expect(accepted).toMatchObject({ status: 'fulfilled' })
    expect(conflict).toMatchObject({ status: 'rejected', reason: { message: expect.stringMatching(/reused with a different operation or payload/) } })
    expect(replay).toEqual(accepted)
    const stored = await ctx.agentTeam.getAttachment({ attachmentId: requestScopedAttachmentId(request.requestId) })
    expect(stored.bytesBase64).toBe(first)
  })
  it('reads valid attachments and keeps invalid, unreadable, and missing entries distinct', async () => {
    const { ctx } = await harness()
    const uploaded = await ctx.agentTeam.putAttachment({
      requestId: requestId('put-upload'), workspaceId: alpha,
      name: 'design.png', mediaType: 'image/png', bytesBase64: Buffer.from('png-bytes').toString('base64'),
    })
    expect(uploaded.mediaType).toBe('image/png')
    expect(uploaded.path).toContain(uploaded.attachmentId)
    const readBack = await ctx.agentTeam.getAttachment({ attachmentId: uploaded.attachmentId })
    expect(readBack.bytesBase64).toBe(Buffer.from('png-bytes').toString('base64'))
    expect(readBack.name).toBe('design.png')

    await expect(ctx.agentTeam.putAttachment({
      requestId: requestId('big'), workspaceId: alpha,
      name: 'big.bin', bytesBase64: Buffer.alloc(ATTACHMENT_MAX_BYTES + 1).toString('base64'),
    })).rejects.toThrow(/byte limit/)
    await expect(ctx.agentTeam.putAttachment({
      requestId: requestId('empty'), workspaceId: alpha,
      name: 'empty.bin', bytesBase64: '',
    })).rejects.toThrow(/must not be empty/)
    await expect(ctx.agentTeam.getAttachment({ attachmentId: newAttachmentId() })).rejects.toThrow(/no longer cached/)
    // A gone entry is an expected cross-Remote failure: it carries the stable
    // code so the Client branches on it without parsing the message.
    const missing = newAttachmentId()
    await expect(ctx.agentTeam.getAttachment({ attachmentId: missing }))
      .rejects.toMatchObject({ name: 'RemoteError', code: 'team/attachment-not-found', details: { attachmentId: missing } })

    // Invalid ids cannot escape the cache and are not reported as a confirmed miss.
    for (const invalidId of ['../outside', '/tmp/outside', 'nested/file', 'a\\b', 'meta.json', 'not-a-uuid', 'CON', 'con.txt', 'report.', 'report ', '.', '..']) {
      const error = await ctx.agentTeam.getAttachment({ attachmentId: invalidId as never }).catch(failure => failure)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toMatchObject({ code: 'team/attachment-not-found' })
    }

    // An existing directory without a sidecar is incomplete, not a confirmed miss.
    const incomplete = newAttachmentId()
    await mkdir(join(attachmentsRoot(), incomplete), { recursive: true })
    await writeFile(join(attachmentsRoot(), incomplete, 'shot.png'), 'png')
    await expect(ctx.agentTeam.getAttachment({ attachmentId: incomplete }))
      .rejects.toMatchObject({ name: 'AttachmentCacheInvalidError', message: expect.stringMatching(/no metadata sidecar/) })

    const payloadMissing = newAttachmentId()
    await mkdir(join(attachmentsRoot(), payloadMissing), { recursive: true })
    await writeFile(join(attachmentsRoot(), payloadMissing, 'meta.json'),
      JSON.stringify({ name: 'shot.png', mediaType: 'image/png', uploadedAt: new Date().toISOString() }), 'utf8')
    await expect(ctx.agentTeam.getAttachment({ attachmentId: payloadMissing }))
      .rejects.toMatchObject({ name: 'AttachmentCacheInvalidError', message: expect.stringMatching(/does not contain exactly the payload/) })

    // Malformed metadata and an unreadable metadata entry are failures, not expiry.
    const malformed = newAttachmentId()
    await mkdir(join(attachmentsRoot(), malformed), { recursive: true })
    await writeFile(join(attachmentsRoot(), malformed, 'shot.png'), 'png')
    await writeFile(join(attachmentsRoot(), malformed, 'meta.json'), '{not-json', 'utf8')
    await expect(ctx.agentTeam.getAttachment({ attachmentId: malformed }))
      .rejects.toMatchObject({ name: 'AttachmentCacheInvalidError', message: expect.stringMatching(/metadata is not valid JSON/) })

    const unreadable = newAttachmentId()
    await mkdir(join(attachmentsRoot(), unreadable, 'meta.json'), { recursive: true })
    await writeFile(join(attachmentsRoot(), unreadable, 'shot.png'), 'png')
    await expect(ctx.agentTeam.getAttachment({ attachmentId: unreadable }))
      .rejects.toMatchObject({ name: 'AttachmentCacheInvalidError', message: expect.stringMatching(/not a regular file/) })
  })

  it.skipIf(process.platform === 'win32')('rejects a cache entry redirected outside the attachment root', async () => {
    const { ctx } = await harness()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-attachment-outside-'))
    cleanups.push(async () => { await rm(outside, { recursive: true, force: true }) })
    await writeFile(join(outside, 'shot.png'), 'png')
    await writeFile(join(outside, 'meta.json'), JSON.stringify({ name: 'shot.png', mediaType: 'image/png', uploadedAt: new Date().toISOString() }), 'utf8')
    const attachmentId = newAttachmentId()
    await mkdir(attachmentsRoot(), { recursive: true })
    await symlink(outside, join(attachmentsRoot(), attachmentId), 'dir')
    cleanups.push(async () => { await rm(join(attachmentsRoot(), attachmentId), { recursive: true, force: true }) })
    await expect(ctx.agentTeam.getAttachment({ attachmentId }))
      .rejects.toMatchObject({ name: 'AttachmentCacheInvalidError', message: expect.stringMatching(/does not name a cache directory/) })
  })

  it('stores message attachment metadata, appends prompt lines, and replays old ledgers unchanged', async () => {
    const { ctx, facility } = await harness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    const uploaded = await ctx.agentTeam.putAttachment({
      requestId: requestId('put-message'), workspaceId: alpha,
      name: 'design.png', mediaType: 'image/png', bytesBase64: Buffer.from('png').toString('base64'),
    })
    const sent = await ctx.agentTeam.startThread({ kind: 'task',
      requestId: requestId('send'), workspaceId: alpha, projectRef: project.project.projectRef,
      body: '请看这张图', attachments: [uploaded.attachmentId],
    })
    expect(sent.kind).toBe('committed')
    if (sent.kind !== 'committed') return
    expect(sent.message.attachments).toHaveLength(1)
    expect(sent.message.attachments?.[0]?.name).toBe('design.png')
    expect(sent.message.body).toContain('请看这张图')
    expect(sent.message.body).toMatch(new RegExp(`\\[attachment\\] .*attachments${escapeRegExp(sep)}v1${escapeRegExp(sep)}`))

    // Idempotent resend with the same request resolves to the same message.
    const beforeResend = await cacheEntries()
    const resent = await ctx.agentTeam.startThread({ kind: 'task',
      requestId: requestId('send'), workspaceId: alpha, projectRef: project.project.projectRef,
      body: '请看这张图', attachments: [uploaded.attachmentId],
    })
    expect(resent.kind).toBe('committed')
    expect(await cacheEntries()).toEqual(beforeResend)

    // An unknown attachment id is rejected before the ledger append.
    await expect(ctx.agentTeam.startThread({ kind: 'task',
      requestId: requestId('send-unknown'), workspaceId: alpha, projectRef: project.project.projectRef,
      body: 'missing', attachments: [newAttachmentId()],
    })).rejects.toThrow(/not in the upload cache/)
    const incomplete = newAttachmentId()
    await mkdir(join(attachmentsRoot(), incomplete), { recursive: true })
    await writeFile(join(attachmentsRoot(), incomplete, 'shot.png'), 'png')
    await expect(ctx.agentTeam.startThread({ kind: 'task',
      requestId: requestId('send-incomplete'), workspaceId: alpha, projectRef: project.project.projectRef,
      body: 'incomplete', attachments: [incomplete],
    })).rejects.toThrow(/no metadata sidecar/)
    const unreadable = newAttachmentId()
    await mkdir(join(attachmentsRoot(), unreadable, 'meta.json'), { recursive: true })
    await writeFile(join(attachmentsRoot(), unreadable, 'shot.png'), 'png')
    await expect(ctx.agentTeam.startThread({ kind: 'task',
      requestId: requestId('send-unreadable'), workspaceId: alpha, projectRef: project.project.projectRef,
      body: 'unreadable', attachments: [unreadable],
    })).rejects.toThrow(/not a regular file/)

    // A cold replay over the same table accepts the new-format record and the
    // projection carries the metadata; the live service serves the history.
    const cold = ledgerAtBoot(facility)
    expect(() => cold.validate()).not.toThrow()
    expect(cold.referencedAttachmentIds().has(uploaded.attachmentId)).toBe(true)
    const history = ctx.agentTeam.threadHistory({ workspaceId: alpha, taskRef: sent.task!.taskRef })
    expect(history.facts.some(fact => fact.kind === 'message' && fact.message.attachments?.[0]?.name === 'design.png')).toBe(true)
  })

  it('replays a retried path send on the entry the first attempt prepared', async () => {
    const { ctx } = await harness()
    const sourceRoot = await mkdtemp(join(tmpdir(), 'dsh-attachment-source-'))
    cleanups.push(async () => { await rm(sourceRoot, { recursive: true, force: true }) })
    const source = join(sourceRoot, 'report.txt')
    await writeFile(source, 'path payload')
    const project = await ctx.agentTeam.createProject({ requestId: requestId('path-retry-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    const request = { kind: 'discussion', requestId: requestId('path-retry'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: 'same request', attachmentPaths: [source] } as const

    const first = await ctx.agentTeam.startThread(request)
    expect(first.kind).toBe('committed')
    const beforeRetry = await cacheEntries()
    // Same request and same payload: the retry resolves to the original
    // message instead of rejecting, and prepares no new cache entry.
    const resent = await ctx.agentTeam.startThread(request)
    expect(resent.kind).toBe('committed')
    if (first.kind === 'committed' && resent.kind === 'committed') {
      expect(resent.message.messageRef).toBe(first.message.messageRef)
      expect(resent.message.body).toBe(first.message.body)
      expect(resent.message.attachments?.[0]?.attachmentId).toBe(first.message.attachments?.[0]?.attachmentId)
    }
    expect(await cacheEntries()).toEqual(beforeRetry)
    expect(beforeRetry).toContain(pathAttachmentId('path-retry', 0))
  })

  it('replays a retried upload on its request id and refuses a different payload', async () => {
    const { ctx } = await harness()
    const request = { requestId: requestId('put-retry'), workspaceId: alpha, name: 'design.png',
      mediaType: 'image/png', bytesBase64: Buffer.from('png-bytes').toString('base64') }
    const first = await ctx.agentTeam.putAttachment(request)
    const before = await cacheEntries()
    const replayed = await ctx.agentTeam.putAttachment(request)
    expect(replayed).toEqual(first)
    expect(await cacheEntries()).toEqual(before)
    await expect(ctx.agentTeam.getAttachment({ attachmentId: first.attachmentId }))
      .resolves.toMatchObject({ name: 'design.png', mediaType: 'image/png' })
    // Reusing the idempotency key for another payload must not become a second upload.
    await expect(ctx.agentTeam.putAttachment({ ...request, bytesBase64: Buffer.from('other-bytes').toString('base64') }))
      .rejects.toThrow(/reused with a different operation or payload/)
    await expect(ctx.agentTeam.putAttachment({ ...request, name: 'renamed.png' }))
      .rejects.toThrow(/reused with a different operation or payload/)
    expect(await cacheEntries()).toEqual(before)
  })

  it('does not let concurrent sends replace the bytes bound to the first Message', async () => {
    const { ctx } = await harness()
    const root = await mkdtemp(join(tmpdir(), 'dsh-attach-concurrent-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    await mkdir(join(root, 'other'))
    const original = join(root, 'report.txt')
    const conflicting = join(root, 'other', 'report.txt')
    await writeFile(original, 'original')
    await writeFile(conflicting, 'conflict')
    const { project } = await ctx.agentTeam.createProject({ requestId: requestId('concurrent-project'), workspaceId: alpha, name: 'engineering', description: '' })
    const request = { kind: 'discussion', requestId: requestId('concurrent-send'), workspaceId: alpha, projectRef: project.projectRef, body: 'report' } as const

    const [accepted, conflict] = await Promise.allSettled([
      ctx.agentTeam.startThread({ ...request, attachmentPaths: [original] }),
      ctx.agentTeam.startThread({ ...request, attachmentPaths: [conflicting] }),
    ])

    expect(accepted).toMatchObject({ status: 'fulfilled', value: { kind: 'committed' } })
    expect(conflict).toMatchObject({ status: 'rejected', reason: { message: expect.stringMatching(/reused with a different operation or payload/) } })
    const stored = await ctx.agentTeam.getAttachment({ attachmentId: pathAttachmentId(request.requestId, 0) })
    expect(Buffer.from(stored.bytesBase64, 'base64').toString()).toBe('original')
  })

  it.each(['upload', 'path'] as const)('keeps an old %s attachment when its Message commits during a sweep', async (kind) => {
    const { ctx } = await harness()
    const ledger = ctx.agentTeam['ledger']!
    const { project } = await ctx.agentTeam.createProject({ requestId: requestId('sweep-project'), workspaceId: alpha, name: 'engineering', description: '' })
    const sendId = requestId('send-during-sweep')
    const name = 'report.txt'
    const body = 'report bytes'
    const root = attachmentsRoot()
    const now = Date.now()
    const attachmentId = kind === 'upload' ? requestScopedAttachmentId('sweep-upload') : pathAttachmentId(sendId, 0)
    await writeAttachment(root, attachmentId, name, 'text/plain', Buffer.from(body))
    await writeFile(join(root, attachmentId, 'meta.json'), JSON.stringify({ name, mediaType: 'text/plain',
      uploadedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() }))
    const sourceDir = await mkdtemp(join(tmpdir(), 'dsh-attach-sweep-'))
    cleanups.push(async () => { await rm(sourceDir, { recursive: true, force: true }) })
    const source = join(sourceDir, name)
    await writeFile(source, body)
    const commit = ledger.startThread.bind(ledger)
    const prepared = Promise.withResolvers<void>()
    const releaseCommit = Promise.withResolvers<void>()
    ledger.startThread = async request => {
      prepared.resolve()
      await releaseCommit.promise
      return commit(request)
    }

    const sending = ctx.agentTeam.startThread({ kind: 'discussion', requestId: sendId, workspaceId: alpha, projectRef: project.projectRef, body,
      ...(kind === 'upload' ? { attachments: [attachmentId] } : { attachmentPaths: [source] }) })
    await Promise.race([prepared.promise, sending])
    const sweeping = sweepAttachmentCache(root, id => ledger.referencedAttachmentIds().has(id), now)
    releaseCommit.resolve()

    const [sent, removed] = await Promise.all([sending, sweeping])
    expect(sent).toMatchObject({ kind: 'committed', message: { attachments: [{ attachmentId }] } })
    expect(removed).not.toContain(attachmentId)
    await expect(ctx.agentTeam.getAttachment({ attachmentId })).resolves.toMatchObject({ bytesBase64: Buffer.from(body).toString('base64') })
  })

  it('replays an upload retry after the Host restarts', async () => {
    const { ctx, restart } = await harness()
    const request = { requestId: requestId('put-restart'), workspaceId: alpha, name: 'restart.png',
      mediaType: 'image/png', bytesBase64: Buffer.from('png-bytes').toString('base64') }
    const first = await ctx.agentTeam.putAttachment(request)
    const before = await cacheEntries()
    await restart()
    // The derived identity is durable, so the restarted Host converges on the
    // entry the previous instance wrote instead of minting another one.
    const replayed = await ctx.agentTeam.putAttachment(request)
    expect(replayed.attachmentId).toBe(first.attachmentId)
    expect(replayed.path).toBe(first.path)
    // The restart also runs the boot sweep, which can retire entries an earlier
    // test left in this file's shared cache; the retry itself must mint none.
    expect((await cacheEntries()).filter(id => !before.includes(id))).toEqual([])
    await expect(ctx.agentTeam.getAttachment({ attachmentId: first.attachmentId }))
      .resolves.toMatchObject({ name: 'restart.png', bytesBase64: Buffer.from('png-bytes').toString('base64') })
  })

  it('converges a half-written request-scoped entry instead of colliding', async () => {
    const { ctx } = await harness()
    const payloadOnlyId = requestScopedAttachmentId('put-half-written-payload')
    const payloadOnlyDir = join(attachmentsRoot(), payloadOnlyId)
    await mkdir(payloadOnlyDir, { recursive: true })
    // A payload without its metadata sidecar is unreadable state the retry repairs.
    await writeFile(join(payloadOnlyDir, 'design.png'), Buffer.from('png-bytes'))
    const payloadOnly = await ctx.agentTeam.putAttachment({ requestId: requestId('put-half-written-payload'), workspaceId: alpha,
      name: 'design.png', mediaType: 'image/png', bytesBase64: Buffer.from('png-bytes').toString('base64') })
    expect(payloadOnly.attachmentId).toBe(payloadOnlyId)
    expect(await readAttachment(attachmentsRoot(), payloadOnlyId)).toMatchObject({ kind: 'found', attachment: { name: 'design.png', mediaType: 'image/png', byteSize: 9 } })

    const metadataOnlyId = requestScopedAttachmentId('put-half-written-metadata')
    const metadataOnlyDir = join(attachmentsRoot(), metadataOnlyId)
    await mkdir(metadataOnlyDir, { recursive: true })
    await writeFile(join(metadataOnlyDir, 'meta.json'), JSON.stringify({ name: 'design.png', mediaType: 'image/png', uploadedAt: new Date().toISOString() }), 'utf8')
    const metadataOnly = await ctx.agentTeam.putAttachment({ requestId: requestId('put-half-written-metadata'), workspaceId: alpha,
      name: 'design.png', mediaType: 'image/png', bytesBase64: Buffer.from('png-bytes').toString('base64') })
    expect(metadataOnly.attachmentId).toBe(metadataOnlyId)
    expect(await readAttachment(attachmentsRoot(), metadataOnlyId)).toMatchObject({ kind: 'found', attachment: { name: 'design.png', mediaType: 'image/png', byteSize: 9 } })
  })

  it('resolves Human reply attachments from the upload cache and replays them', async () => {
    const { ctx, facility } = await harness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    const started = await ctx.agentTeam.startThread({ kind: 'task',
      requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: '开个任务',
    })
    if (started.kind !== 'committed') throw new Error('expected committed')
    const uploaded = await ctx.agentTeam.putAttachment({
      requestId: requestId('put-reply'), workspaceId: alpha,
      name: 'reply.png', mediaType: 'image/png', bytesBase64: Buffer.from('png').toString('base64'),
    })
    const replied = await ctx.agentTeam.reply({
      requestId: requestId('reply'), workspaceId: alpha, taskRef: started.task!.taskRef,
      body: '补充截图', baseRevision: started.thread.revision, attachments: [uploaded.attachmentId],
    })
    expect(replied.kind).toBe('committed')
    if (replied.kind !== 'committed') return
    expect(replied.message.attachments).toHaveLength(1)
    expect(replied.message.attachments?.[0]?.name).toBe('reply.png')
    expect(replied.message.body).toMatch(new RegExp(`\\[attachment\\] .*attachments${escapeRegExp(sep)}v1${escapeRegExp(sep)}`))

    // An unknown attachment id is rejected before the ledger append.
    await expect(ctx.agentTeam.reply({
      requestId: requestId('reply-unknown'), workspaceId: alpha, taskRef: started.task!.taskRef,
      body: 'missing', baseRevision: replied.thread.revision, attachments: [newAttachmentId()],
    })).rejects.toThrow(/not in the upload cache/)

    const cold = ledgerAtBoot(facility)
    expect(() => cold.validate()).not.toThrow()
    expect(cold.referencedAttachmentIds().has(uploaded.attachmentId)).toBe(true)
    const history = ctx.agentTeam.threadHistory({ workspaceId: alpha, taskRef: started.task!.taskRef })
    expect(history.facts.some(fact => fact.kind === 'message' && fact.message.attachments?.[0]?.name === 'reply.png')).toBe(true)
  })
})

describe('agent-supplied attachment paths', () => {
  it('derives media types from file extensions', async () => {
    expect(mediaTypeForPath('/tmp/shot.png')).toBe('image/png')
    expect(mediaTypeForPath('/tmp/shot.JPG')).toBe('image/jpeg')
    expect(mediaTypeForPath('/tmp/clip.webp')).toBe('image/webp')
    expect(mediaTypeForPath('/tmp/notes.txt')).toBe('text/plain')
    expect(mediaTypeForPath('/tmp/blob.bin')).toBe('application/octet-stream')
  })

  it('rejects relative, missing, directory, empty, and oversized sources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-attach-paths-'))
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
    await expect(validatePathAttachment('relative/shot.png')).rejects.toThrow(/must be absolute/)
    await expect(validatePathAttachment(join(dir, 'missing.png'))).rejects.toThrow(/does not exist/)
    await expect(validatePathAttachment(dir)).rejects.toThrow(/not a regular file/)
    const empty = join(dir, 'empty.png')
    await writeFile(empty, '')
    await expect(validatePathAttachment(empty)).rejects.toThrow(/must not be empty/)
    const big = join(dir, 'big.png')
    await writeFile(big, Buffer.alloc(ATTACHMENT_MAX_BYTES + 1))
    await expect(validatePathAttachment(big)).rejects.toThrow(/byte limit/)
  })

  it('copies validated paths into the cache for sends and replies, and rejects atomically', async () => {
    const { ctx, facility } = await harness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    const sourceDir = await mkdtemp(join(tmpdir(), 'dsh-attach-src-'))
    cleanups.push(async () => { await rm(sourceDir, { recursive: true, force: true }) })
    const screenshot = join(sourceDir, '验收截图.png')
    await writeFile(screenshot, Buffer.from('png-bytes'))

    const cacheBefore = await readdir(attachmentsRoot()).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
      throw error
    })
    const sent = await ctx.agentTeam.startThread({ kind: 'task',
      requestId: requestId('send'), workspaceId: alpha, projectRef: project.project.projectRef,
      body: '截图在下面', attachmentPaths: [screenshot],
    })
    expect(sent.kind).toBe('committed')
    if (sent.kind !== 'committed') return
    // Same metadata shape as a manual upload, with an inferred image type.
    expect(sent.message.attachments).toHaveLength(1)
    const attachment = sent.message.attachments?.[0]
    expect(attachment?.name).toBe('验收截图.png')
    expect(attachment?.mediaType).toBe('image/png')
    expect(attachment?.byteSize).toBe(Buffer.byteLength('png-bytes'))
    // The prompt line points at the cached copy, which holds the original bytes.
    const cachedPath = sent.message.body.split('\n').find(line => line.startsWith('[attachment] '))?.slice('[attachment] '.length)
    expect(cachedPath).toBeDefined()
    expect(cachedPath).toContain(attachment?.attachmentId)
    expect((await readFile(cachedPath!)).toString('utf8')).toBe('png-bytes')
    expect(await readdir(attachmentsRoot())).toHaveLength(cacheBefore.length + 1)

    // A reply carries path attachments through the same pipeline.
    const replied = await ctx.agentTeam.reply({
      requestId: requestId('reply'), workspaceId: alpha, taskRef: sent.task!.taskRef,
      body: '补充一张', baseRevision: sent.thread.revision, attachmentPaths: [screenshot],
    })
    expect(replied.kind).toBe('committed')
    if (replied.kind !== 'committed') return
    expect(replied.message.attachments?.[0]?.mediaType).toBe('image/png')
    const history = ctx.agentTeam.threadHistory({ workspaceId: alpha, taskRef: sent.task!.taskRef })
    expect(history.facts.filter(fact => fact.kind === 'message' && fact.message.attachments !== undefined)).toHaveLength(2)

    // One bad path rejects the whole send: no message, no cache writes.
    const entriesBefore = await readdir(attachmentsRoot())
    await expect(ctx.agentTeam.startThread({ kind: 'task',
      requestId: requestId('send-bad'), workspaceId: alpha, projectRef: project.project.projectRef,
      body: '不应提交', attachmentPaths: [join(sourceDir, 'missing.png')],
    })).rejects.toThrow(/does not exist/)
    const coldAfterFailure = ledgerAtBoot(facility)
    expect(() => coldAfterFailure.validate()).not.toThrow()
    expect(await readdir(attachmentsRoot())).toEqual(entriesBefore)
  })

  it('replays a retried reply with the same path attachment and refuses a changed payload', async () => {
    const { ctx } = await harness()
    const sourceRoot = await mkdtemp(join(tmpdir(), 'dsh-attachment-source-'))
    cleanups.push(async () => { await rm(sourceRoot, { recursive: true, force: true }) })
    const source = join(sourceRoot, 'note.txt')
    await writeFile(source, 'reply payload')
    const project = await ctx.agentTeam.createProject({ requestId: requestId('reply-path-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('reply-path-start'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: '开个任务' })
    if (started.kind !== 'committed') throw new Error('expected committed')
    const request = { requestId: requestId('reply-path-retry'), workspaceId: alpha, taskRef: started.task!.taskRef,
      body: '带一个附件', baseRevision: started.thread.revision, attachmentPaths: [source] } as const

    const first = await ctx.agentTeam.reply(request)
    expect(first.kind).toBe('committed')
    const before = await cacheEntries()
    const resent = await ctx.agentTeam.reply(request)
    expect(resent.kind).toBe('committed')
    if (first.kind === 'committed' && resent.kind === 'committed') {
      expect(resent.message.messageRef).toBe(first.message.messageRef)
      expect(resent.message.attachments?.[0]?.attachmentId).toBe(first.message.attachments?.[0]?.attachmentId)
    }
    expect(await cacheEntries()).toEqual(before)

    // Reusing the reply's request id for another payload stays a collision.
    await writeFile(source, Buffer.from('changed payload'))
    await expect(ctx.agentTeam.reply(request)).rejects.toThrow(/reused with a different operation or payload/)
    expect(await cacheEntries()).toEqual(before)
  })

  it('drops a prepared path entry when the send fails and keeps referenced bytes on a collision', async () => {
    const { ctx, facility } = await harness()
    const sourceDir = await mkdtemp(join(tmpdir(), 'dsh-attach-cleanup-'))
    cleanups.push(async () => { await rm(sourceDir, { recursive: true, force: true }) })
    const screenshot = join(sourceDir, 'evidence.png')
    await writeFile(screenshot, Buffer.from('png-bytes'))
    const project = await ctx.agentTeam.createProject({ requestId: requestId('cleanup-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    const before = await cacheEntries()

    // A referenced upload that is not in the cache fails after the path copy:
    // the entry this attempt prepared is unreferenced, so it is removed again.
    await expect(ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('fail-cleanup'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: '不应提交', attachmentPaths: [screenshot], attachments: [newAttachmentId()] }))
      .rejects.toThrow(/not in the upload cache/)
    expect(await cacheEntries()).toEqual(before)
    expect(() => ledgerAtBoot(facility).validate()).not.toThrow()

    const request = { kind: 'discussion', requestId: requestId('collision-keep'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: 'first body', attachmentPaths: [screenshot] } as const
    const sent = await ctx.agentTeam.startThread(request)
    expect(sent.kind).toBe('committed')
    const committed = await cacheEntries()
    expect(committed.length).toBe(before.length + 1)

    // Same request id, different body: the ledger refuses it, and the cleanup
    // guard leaves the committed entry alone because the ledger references it.
    await expect(ctx.agentTeam.startThread({ ...request, body: 'different body' }))
      .rejects.toThrow(/reused with a different operation or payload/)
    expect(await cacheEntries()).toEqual(committed)

    // Same request id, different source bytes: the copy refuses it before any
    // write, and the committed bytes stay intact.
    await writeFile(screenshot, Buffer.from('other bytes'))
    await expect(ctx.agentTeam.startThread(request)).rejects.toThrow(/reused with a different operation or payload/)
    expect(await cacheEntries()).toEqual(committed)
    const prepared = pathAttachmentId('collision-keep', 0)
    expect(committed).toContain(prepared)
    expect(await readFile(join(attachmentsRoot(), prepared, 'evidence.png'), 'utf8')).toBe('png-bytes')
  })
})
