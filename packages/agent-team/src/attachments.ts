import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { requestScopedUuid } from './request-scoped-id.ts'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { AgentTeamAttachmentId } from './types.ts'

/**
 * Composer attachments are a cache, not an archive: bytes live only so Member
 * agents can read them within the consumption window, while the ledger keeps
 * the metadata forever. Everything here derives from the on-disk layout
 * `$DSH_HOME/agent-team/attachments/v1/<attachmentId>/` holding the payload
 * file (original sanitized name) plus a `meta.json` sidecar.
 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
/** Referenced uploads survive this long after upload for member consumption. */
export const ATTACHMENT_REFERENCED_TTL_MS = 72 * 60 * 60 * 1000
/** Unreferenced uploads (uploaded but never sent) are cleaned much sooner. */
export const ATTACHMENT_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000

export function attachmentsRoot(): string {
  return dshHomePath('agent-team', 'attachments', 'v1')
}

/** Absolute payload path of one stored attachment, as offered to Member agents. */
export function attachmentPayloadPath(attachmentId: AgentTeamAttachmentId, name: string): string {
  return join(attachmentsRoot(), attachmentId, name)
}

export function newAttachmentId(): AgentTeamAttachmentId {
  return randomUUID() as AgentTeamAttachmentId
}

/**
 * Request-stable cache identity for one upload of an idempotent request: see
 * [`requestScopedUuid`](./request-scoped-id.ts) for why the id is derived
 * rather than fresh. `scope` separates several attachments prepared by one
 * request (path copies) from the request's upload itself.
 */
export function requestScopedAttachmentId(requestId: string, scope?: string): AgentTeamAttachmentId {
  return requestScopedUuid('attachment-request', requestId, scope) as AgentTeamAttachmentId
}

/** The request-stable id of the `index`-th path copy one message or reply request prepares. */
export function pathAttachmentId(requestId: string, index: number): AgentTeamAttachmentId {
  return requestScopedAttachmentId(requestId, `path:${index}`)
}

/** Strip path separators, control characters, Windows-illegal characters, reserved device names, and leading dots from one client-supplied name. */
export function sanitizeFileName(raw: string): string {
  // oxlint-disable no-control-regex -- strip ASCII control characters, separators, and Windows-reserved characters from client filenames.
  const cleaned = raw
    .replaceAll(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '')
    .replaceAll(/^\.+/g, '')
    .trim()
    .slice(0, 180)
    .replace(/[\s.]+$/g, '')
  // oxlint-enable no-control-regex
  if (cleaned === '') return 'attachment'
  // The metadata sidecar owns 'meta.json' inside every entry directory; a
  // payload with that name would be clobbered by the sidecar and unreadable.
  if (/^meta\.json$/i.test(cleaned)) return `_${cleaned}`
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

/**
 * Validate one agent-supplied attachment path before any cache write happens,
 * so a rejection anywhere leaves the upload cache untouched.
 */
export async function validatePathAttachment(raw: string): Promise<void> {
  if (!isAbsolute(raw)) throw new Error(`attachment path '${raw}' must be absolute — attachments are resolved from the filesystem root, so a relative path names nothing`)
  const info = await stat(raw).catch(() => undefined)
  if (info === undefined) throw new Error(`attachment path '${raw}' does not exist — check the path, then retry; an unreadable path is refused before anything is cached`)
  if (!info.isFile()) throw new Error(`attachment path '${raw}' is not a regular file — point at one file, not a directory`)
  if (info.size === 0) throw new Error(`attachment '${basename(raw)}' must not be empty — attach a file with content, or drop the attachment`)
  if (info.size > ATTACHMENT_MAX_BYTES) throw new Error(`attachment '${basename(raw)}' exceeds the ${ATTACHMENT_MAX_BYTES} byte limit — split it across messages or shrink the file`)
}

/**
 * Copy one validated file into the cache under the caller's request-stable id.
 * A committed Message may already reference that id, so an existing entry is
 * never overwritten: identical name and bytes replay it, and anything else is
 * refused as the same request-id collision the ledger reports.
 */
export async function copyPathAttachment(root: string, raw: string, attachmentId: AgentTeamAttachmentId, requestId: string): Promise<{ attachmentId: AgentTeamAttachmentId; name: string; byteSize: number; mediaType: string }> {
  const bytes = await readFile(raw)
  const name = sanitizeFileName(basename(raw))
  const mediaType = mediaTypeForPath(raw)
  const existing = await readAttachment(root, attachmentId)
  if (existing !== undefined) {
    collideUnlessSamePayload(existing, name, mediaType, bytes, requestId)
    return { attachmentId, name: existing.name, byteSize: existing.byteSize, mediaType: existing.mediaType }
  }
  const stored = await writeAttachment(root, attachmentId, basename(raw), mediaType, bytes)
  return { attachmentId: stored.attachmentId, name: stored.name, byteSize: stored.byteSize, mediaType: stored.mediaType }
}

/**
 * Store one upload under the id its `requestId` derives. The first attempt
 * writes the entry; a later attempt with the same request replays it, and a
 * different payload for that same request is refused instead of silently
 * becoming a second upload of the same idempotency key.
 */
export async function writeRequestScopedAttachment(root: string, requestId: string, rawName: string, mediaType: string, bytes: Buffer): Promise<{ attachmentId: AgentTeamAttachmentId; path: string; name: string; byteSize: number; mediaType: string }> {
  const attachmentId = requestScopedAttachmentId(requestId)
  const existing = await readAttachment(root, attachmentId)
  if (existing !== undefined) {
    collideUnlessSamePayload(existing, sanitizeFileName(rawName), mediaType, bytes, requestId)
    return { attachmentId, path: join(attachmentDir(root, attachmentId), existing.name), name: existing.name, byteSize: existing.byteSize, mediaType: existing.mediaType }
  }
  return writeAttachment(root, attachmentId, rawName, mediaType, bytes)
}

/** Refuse a reused request id whose stored payload no longer matches this attempt. */
function collideUnlessSamePayload(existing: StoredAttachment, name: string, mediaType: string, bytes: Buffer, requestId: string): void {
  if (existing.name !== name || existing.mediaType !== mediaType || !existing.bytes.equals(bytes)) {
    throw new Error(`agent-team request id '${requestId}' was reused with a different operation or payload`)
  }
}

interface AttachmentMeta {
  readonly name: string
  readonly mediaType: string
  readonly uploadedAt: string
}

function attachmentDir(root: string, attachmentId: AgentTeamAttachmentId): string {
  return join(root, attachmentId)
}

/** Write one upload as an immutable payload plus its metadata sidecar. */
export async function writeAttachment(root: string, attachmentId: AgentTeamAttachmentId, rawName: string, mediaType: string, bytes: Buffer): Promise<{ attachmentId: AgentTeamAttachmentId; path: string; name: string; byteSize: number; mediaType: string }> {
  const name = sanitizeFileName(rawName)
  const dir = attachmentDir(root, attachmentId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), bytes)
  const meta: AttachmentMeta = { name, mediaType, uploadedAt: new Date().toISOString() }
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta), 'utf8')
  return { attachmentId, path: join(dir, name), name, byteSize: bytes.byteLength, mediaType }
}

export interface StoredAttachment {
  readonly name: string
  readonly mediaType: string
  readonly byteSize: number
  readonly uploadedAt: string
  readonly bytes: Buffer
}

/** Read one attachment back; `undefined` when the cache entry is gone (GC'd). */
export async function readAttachment(root: string, attachmentId: AgentTeamAttachmentId): Promise<StoredAttachment | undefined> {
  const dir = attachmentDir(root, attachmentId)
  let metaRaw: Buffer
  try {
    metaRaw = await readFile(join(dir, 'meta.json'))
  } catch {
    return undefined
  }
  const meta = JSON.parse(metaRaw.toString('utf8')) as AttachmentMeta
  const entries = await readdir(dir)
  const payload = entries.filter(entry => entry !== 'meta.json')[0]
  if (payload === undefined) return undefined
  const bytes = await readFile(join(dir, payload))
  return { name: meta.name, mediaType: meta.mediaType, byteSize: bytes.byteLength, uploadedAt: meta.uploadedAt, bytes }
}

export interface CacheEntryScan {
  readonly attachmentId: AgentTeamAttachmentId
  readonly uploadedAt: number
}

/** List every cache entry with its upload instant for the GC sweep. */
export async function scanAttachmentCache(root: string): Promise<readonly CacheEntryScan[]> {
  let ids: string[]
  try {
    ids = await readdir(root)
  } catch {
    return []
  }
  const entries: CacheEntryScan[] = []
  for (const id of ids) {
    try {
      const metaRaw = await readFile(join(root, id, 'meta.json'))
      const meta = JSON.parse(metaRaw.toString('utf8')) as AttachmentMeta
      entries.push({ attachmentId: id as AgentTeamAttachmentId, uploadedAt: Date.parse(meta.uploadedAt) })
    } catch {
      // A half-written or foreign directory is not ours to judge; skip it.
    }
  }
  return entries
}

/** Remove one cache entry's bytes; missing entries already satisfy the sweep. */
export async function removeAttachment(root: string, attachmentId: AgentTeamAttachmentId): Promise<void> {
  await rm(attachmentDir(root, attachmentId), { recursive: true, force: true })
}

/** Ids of uploads a Message still references — everything else is an orphan. */
export type ReferencedAttachments = ReadonlySet<AgentTeamAttachmentId>

/**
 * One GC pass: drop uploads older than the orphan TTL, and referenced ones
 * older than the consumption-window TTL. Returns the ids removed so the
 * service can log them.
 */
export async function sweepAttachmentCache(root: string, referenced: ReferencedAttachments, now: number): Promise<readonly AgentTeamAttachmentId[]> {
  const removed: AgentTeamAttachmentId[] = []
  for (const entry of await scanAttachmentCache(root)) {
    const age = now - entry.uploadedAt
    const ttl = referenced.has(entry.attachmentId) ? ATTACHMENT_REFERENCED_TTL_MS : ATTACHMENT_ORPHAN_TTL_MS
    if (age > ttl) {
      await removeAttachment(root, entry.attachmentId)
      removed.push(entry.attachmentId)
    }
  }
  return removed
}

/** Accept only well-formed `type/subtype` media types; anything else falls back to the generic binary type. */
export function sanitizeMediaType(raw?: string | undefined): string {
  const candidate = (raw ?? '').trim().toLowerCase()
  return /^[a-z0-9][-.\w]*\/[-.\w]+$/.test(candidate) ? candidate : 'application/octet-stream'
}
