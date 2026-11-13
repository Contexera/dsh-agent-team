import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import { stableRequestUuid } from './request-scoped-id.ts'
import { recoveryFor } from './recovery-hints.ts'
import { truncateToCharacters } from './text.ts'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { AgentTeamAttachmentId, AgentTeamMessageAttachment, AgentTeamPutAttachmentResult } from './types.ts'

/** Composer attachment cache: `$DSH_HOME/agent-team/attachments/v1/<attachmentId>/` holds the payload (sanitized name) plus a `meta.json` sidecar. Bytes are temporary; the ledger keeps the metadata. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

/** Sidecar name; `sanitizeFileName` escapes client names that collide with it. */
const ATTACHMENT_SIDECAR_NAME = 'meta.json'
/** Cache ids are UUID directory names; arbitrary path-like text is not a reference. */
const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Referenced uploads survive this long after upload for member consumption. */
export const ATTACHMENT_REFERENCED_TTL_MS = 72 * 60 * 60 * 1000
/** Unreferenced uploads (uploaded but never sent) are cleaned much sooner. */
export const ATTACHMENT_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000

export function attachmentsRoot(): string {
  return dshHomePath('agent-team', 'attachments', 'v1')
}

/** Absolute payload path of one stored attachment, as offered to Member agents. */
export function attachmentPayloadPath(attachmentId: AgentTeamAttachmentId, name: string): string {
  if (name.length === 0 || sanitizeFileName(name) !== name) throw new Error(`attachment '${attachmentId}' has an invalid stored file name`)
  return join(attachmentDir(attachmentsRoot(), attachmentId), name)
}

/** Request-stable cache id (see `stableRequestUuid`); `scope` separates path copies from the request's own upload. */
export function requestScopedAttachmentId(requestId: string, scope?: string): AgentTeamAttachmentId {
  return stableRequestUuid('attachment-request', requestId, scope) as AgentTeamAttachmentId
}

/** The request-stable id of the `index`-th path copy one message or reply request prepares. */
export function pathAttachmentId(requestId: string, index: number): AgentTeamAttachmentId {
  return requestScopedAttachmentId(requestId, `path:${index}`)
}

/** Strip path separators, control characters, Windows-illegal characters, reserved device names, and leading dots from one client-supplied name. */
export function sanitizeFileName(raw: string): string {
  // oxlint-disable no-control-regex -- strip ASCII control characters, separators, and Windows-reserved characters from client filenames.
  const cleaned = truncateToCharacters(raw
    .replaceAll(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '')
    .replaceAll(/^\.+/g, '')
    .trim(), 180)
    .replace(/[\s.]+$/g, '')
  // oxlint-enable no-control-regex
  if (cleaned === '') return 'attachment'
  if (cleaned.toLowerCase() === ATTACHMENT_SIDECAR_NAME) return `_${cleaned}`
  // Win32 CreateFile resolves these device names (with or without an
  // extension) as hardware, so the payload write would fail or alias a device.
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned
}

/** Extension-derived media types for agent-supplied files; unknown types stay generic. */
const PATH_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
}

/** Best-effort media type from one path's extension, so images render as thumbnails. */
export function mediaTypeForPath(raw: string): string {
  return PATH_MEDIA_TYPES[extname(raw).toLowerCase()] ?? 'application/octet-stream'
}

/** Refuse with the subject named and the way out in one sentence, so the model can resend the same value. */
function refuseAttachment(subject: string, fault: string): never {
  throw new Error(`attachment ${subject} ${fault} — ${recoveryFor('attachment_path_rejected').sentence({ refused: subject })}`)
}

/** Validate an agent-supplied path before any cache write, so a rejection leaves the cache untouched. */
export async function validatePathAttachment(raw: string): Promise<void> {
  if (!isAbsolute(raw)) refuseAttachment(`path '${raw}'`, 'must be absolute')
  const info = await stat(raw).catch(() => undefined)
  if (info === undefined) refuseAttachment(`path '${raw}'`, 'does not exist')
  if (!info.isFile()) refuseAttachment(`path '${raw}'`, 'is not a regular file')
  if (info.size === 0) refuseAttachment(`'${basename(raw)}'`, 'must not be empty')
  if (info.size > ATTACHMENT_MAX_BYTES) refuseAttachment(`'${basename(raw)}'`, `exceeds the ${ATTACHMENT_MAX_BYTES} byte limit`)
}

/** Copy a validated file under the request-stable id. A committed Message may reference that id, so an existing entry is never overwritten: identical content replays, anything else is refused as a request-id collision. */
export async function copyPathAttachment(root: string, raw: string, attachmentId: AgentTeamAttachmentId, requestId: string): Promise<AgentTeamMessageAttachment> {
  const { name, byteSize, mediaType } = await writeAttachmentOnce(root, attachmentId, requestId, basename(raw), mediaTypeForPath(raw), await readFile(raw))
  return { attachmentId, name, byteSize, mediaType }
}

/** Store an upload under its request-derived id: identical payload replays, a different payload for the same request is refused. */
export function writeRequestScopedAttachment(root: string, requestId: string, rawName: string, mediaType: string, bytes: Buffer): Promise<AgentTeamPutAttachmentResult> {
  const attachmentId = requestScopedAttachmentId(requestId)
  return withCacheEntries(root, [attachmentId], () => writeAttachmentOnce(root, attachmentId, requestId, rawName, mediaType, bytes))
}

async function writeAttachmentOnce(root: string, attachmentId: AgentTeamAttachmentId, requestId: string, rawName: string, mediaType: string, bytes: Buffer): Promise<AgentTeamPutAttachmentResult> {
  const existing = await readAttachmentForWrite(root, attachmentId)
  if (existing === undefined) return writeAttachment(root, attachmentId, rawName, mediaType, bytes)
  const { name, byteSize } = existing
  if (name !== sanitizeFileName(rawName) || existing.mediaType !== mediaType || !existing.bytes.equals(bytes)) {
    throw new Error(`agent-team request id '${requestId}' was reused with a different operation or payload`)
  }
  return { attachmentId, path: join(attachmentDir(root, attachmentId), name), name, byteSize, mediaType }
}

interface AttachmentMeta {
  readonly name: string
  readonly mediaType: string
  readonly uploadedAt: string
}

function attachmentDir(root: string, attachmentId: AgentTeamAttachmentId): string {
  if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) {
    throw new AttachmentCacheInvalidError(`attachment '${attachmentId}' is not a UUID cache id`)
  }
  return join(root, attachmentId)
}

const cacheEntryTails = new Map<string, Promise<void>>()

/** Reserve every entry before waiting so a sweep or retry cannot observe a half-written entry or clear another attempt's copies. */
async function withCacheEntries<T>(root: string, ids: readonly AgentTeamAttachmentId[], use: () => Promise<T>): Promise<T> {
  if (ids.length === 0) return use()
  const paths = ids.map(id => attachmentDir(root, id))
  const result = Promise.all(paths.map(path => cacheEntryTails.get(path))).then(use)
  const tail = result.then(() => {}, () => {})
  for (const path of paths) cacheEntryTails.set(path, tail)
  try {
    return await result
  } finally {
    for (const path of paths) if (cacheEntryTails.get(path) === tail) cacheEntryTails.delete(path)
  }
}

/** Keep a message's attachments available through the ledger commit and failure cleanup. */
export function withMessageAttachmentEntries<T>(root: string, request: {
  readonly requestId: string
  readonly attachments?: readonly AgentTeamAttachmentId[] | undefined
  readonly attachmentPaths?: readonly string[] | undefined
}, use: () => Promise<T>): Promise<T> {
  return withCacheEntries(root, [...request.attachments ?? [], ...(request.attachmentPaths ?? []).map((_, index) => pathAttachmentId(request.requestId, index))], use)
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { readonly code?: unknown }).code
    : undefined
}

class AttachmentCacheInvalidError extends Error {
  constructor(message: string, readonly repairable = false) {
    super(message)
    this.name = 'AttachmentCacheInvalidError'
  }
}

function outside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
}

async function resolveCacheDirectory(root: string, attachmentId: AgentTeamAttachmentId): Promise<string | undefined> {
  const dir = attachmentDir(root, attachmentId)
  let info
  try {
    info = await lstat(dir)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new AttachmentCacheInvalidError(`attachment '${attachmentId}' does not name a cache directory`)
  }
  const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dir)])
  if (outside(realRoot, realDir)) {
    throw new AttachmentCacheInvalidError(`attachment '${attachmentId}' points outside the attachment cache`)
  }
  return realDir
}

async function cacheFile(dir: string, name: string): Promise<string | undefined> {
  const path = join(dir, name)
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new AttachmentCacheInvalidError(`attachment cache file '${name}' is not a regular file`, true)
  }
  const real = await realpath(path)
  if (outside(dir, real)) {
    throw new AttachmentCacheInvalidError(`attachment cache file '${name}' points outside its entry`)
  }
  return real
}

function parseAttachmentMeta(raw: Buffer): AttachmentMeta {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new AttachmentCacheInvalidError('attachment metadata is not valid JSON', true)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AttachmentCacheInvalidError('attachment metadata is not an object', true)
  }
  const meta = parsed as Partial<AttachmentMeta>
  if (typeof meta.name !== 'string' || meta.name.length === 0 || sanitizeFileName(meta.name) !== meta.name) {
    throw new AttachmentCacheInvalidError('attachment metadata has an invalid file name', true)
  }
  if (typeof meta.mediaType !== 'string' || sanitizeMediaType(meta.mediaType) !== meta.mediaType) {
    throw new AttachmentCacheInvalidError('attachment metadata has an invalid media type', true)
  }
  if (typeof meta.uploadedAt !== 'string' || !Number.isFinite(Date.parse(meta.uploadedAt))) {
    throw new AttachmentCacheInvalidError('attachment metadata has an invalid upload time', true)
  }
  return { name: meta.name, mediaType: meta.mediaType, uploadedAt: meta.uploadedAt }
}

/** Write one upload as an immutable payload plus its metadata sidecar. */
export async function writeAttachment(root: string, attachmentId: AgentTeamAttachmentId, rawName: string, mediaType: string, bytes: Buffer): Promise<AgentTeamPutAttachmentResult> {
  const name = sanitizeFileName(rawName)
  const storedMediaType = sanitizeMediaType(mediaType)
  const dir = attachmentDir(root, attachmentId)
  const existing = await lstat(dir).catch(error => {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  })
  if (existing !== undefined) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new AttachmentCacheInvalidError(`attachment '${attachmentId}' does not name a cache directory`)
    }
  }
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), bytes)
  const meta: AttachmentMeta = { name, mediaType: storedMediaType, uploadedAt: new Date().toISOString() }
  await writeFile(join(dir, ATTACHMENT_SIDECAR_NAME), JSON.stringify(meta), 'utf8')
  return { attachmentId, path: join(dir, name), name, byteSize: bytes.byteLength, mediaType: storedMediaType }
}

export interface StoredAttachment {
  readonly name: string
  readonly mediaType: string
  readonly byteSize: number
  readonly uploadedAt: string
  readonly bytes: Buffer
}

export type AttachmentReadOutcome =
  | { readonly kind: 'found'; readonly attachment: StoredAttachment }
  | { readonly kind: 'missing' }

/** Read one attachment back, separating a confirmed absent entry from corrupt or unreadable cache state. */
export async function readAttachment(root: string, attachmentId: AgentTeamAttachmentId): Promise<AttachmentReadOutcome> {
  const dir = await resolveCacheDirectory(root, attachmentId)
  if (dir === undefined) return { kind: 'missing' }
  const metaPath = await cacheFile(dir, ATTACHMENT_SIDECAR_NAME)
  if (metaPath === undefined) throw new AttachmentCacheInvalidError(`attachment '${attachmentId}' has no metadata sidecar`, true)
  const meta = parseAttachmentMeta(await readFile(metaPath))
  const entries = await readdir(dir)
  const payloads = entries.filter(entry => entry !== ATTACHMENT_SIDECAR_NAME)
  if (payloads.length !== 1 || payloads[0] !== meta.name) {
    throw new AttachmentCacheInvalidError(`attachment '${attachmentId}' does not contain exactly the payload its metadata names`, true)
  }
  const payloadPath = await cacheFile(dir, meta.name)
  if (payloadPath === undefined) {
    throw new AttachmentCacheInvalidError(`attachment '${attachmentId}' metadata has no payload`, true)
  }
  const bytes = await readFile(payloadPath)
  return { kind: 'found', attachment: { name: meta.name, mediaType: meta.mediaType, byteSize: bytes.byteLength, uploadedAt: meta.uploadedAt, bytes } }
}

/** A retried write may replace its own partial entry, but never a redirected path or an I/O failure. */
async function readAttachmentForWrite(root: string, attachmentId: AgentTeamAttachmentId): Promise<StoredAttachment | undefined> {
  try {
    const outcome = await readAttachment(root, attachmentId)
    return outcome.kind === 'found' ? outcome.attachment : undefined
  } catch (error) {
    if (!(error instanceof AttachmentCacheInvalidError) || !error.repairable) throw error
    await removeAttachment(root, attachmentId)
    return undefined
  }
}

async function ageOfCacheEntry(root: string, id: AgentTeamAttachmentId, now: number): Promise<{ readonly age: number; readonly incomplete: boolean } | undefined> {
  try {
    const dir = await resolveCacheDirectory(root, id)
    if (dir === undefined) return undefined
    try {
      const metaPath = await cacheFile(dir, ATTACHMENT_SIDECAR_NAME)
      if (metaPath !== undefined) {
        const meta = parseAttachmentMeta(await readFile(metaPath))
        return { age: now - Date.parse(meta.uploadedAt), incomplete: false }
      }
    } catch (error) {
      if (!(error instanceof AttachmentCacheInvalidError) || !error.repairable) throw error
    }
    return { age: now - (await stat(dir)).mtimeMs, incomplete: true }
  } catch {
    return undefined
  }
}

/** Remove one cache entry's bytes; missing entries already satisfy the sweep. */
export async function removeAttachment(root: string, attachmentId: AgentTeamAttachmentId): Promise<void> {
  await rm(attachmentDir(root, attachmentId), { recursive: true, force: true })
}

/** One GC pass: drops orphans past the orphan TTL and referenced uploads past the consumption TTL; returns removed ids. */
export async function sweepAttachmentCache(root: string, isReferenced: (id: AgentTeamAttachmentId) => boolean, now: number): Promise<readonly AgentTeamAttachmentId[]> {
  const removed: AgentTeamAttachmentId[] = []
  const names = await readdir(root).catch(error => {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  })
  for (const name of names) {
    if (!ATTACHMENT_ID_PATTERN.test(name)) continue
    const id = name as AgentTeamAttachmentId
    await withCacheEntries(root, [id], async () => {
      const entry = await ageOfCacheEntry(root, id, now)
      if (entry === undefined || entry.age <= ATTACHMENT_ORPHAN_TTL_MS) return
      // A send may have committed while the sweep waited to reserve this entry.
      if ((entry.incomplete || entry.age <= ATTACHMENT_REFERENCED_TTL_MS) && isReferenced(id)) return
      await removeAttachment(root, id)
      removed.push(id)
    })
  }
  return removed
}

/** Accept only well-formed `type/subtype` media types; anything else falls back to the generic binary type. */
export function sanitizeMediaType(raw?: string | undefined): string {
  const candidate = (raw ?? '').trim().toLowerCase()
  return /^[a-z0-9][-.\w]*\/[-.\w]+$/.test(candidate) ? candidate : 'application/octet-stream'
}
