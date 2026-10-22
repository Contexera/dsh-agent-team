import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { sanitizeFileName, sanitizeMediaType } from './attachments.ts'
import { HUMAN_AVATAR_MAX_BYTES } from './human-settings.ts'

/**
 * Persistent human avatar store. Layout mirrors the composer attachment
 * cache (`<avatarRef>/` payload plus `meta.json`) but lives under its own
 * root with no TTL sweep: avatar bytes must survive longer than the 72h
 * referenced / 24h orphan windows that bound message attachments.
 */

export function humanAvatarsRoot(): string {
  return dshHomePath('agent-team', 'human', 'v1')
}

function avatarDir(root: string, avatarRef: string): string {
  return join(root, avatarRef)
}

export interface StoredHumanAvatar {
  readonly name: string
  readonly mediaType: string
  readonly byteSize: number
  readonly uploadedAt: string
  readonly bytes: Buffer
}

/** Accept only image payloads; the settings page sends `image/*` exclusively. */
export function assertAvatarMediaType(mediaType: string): string {
  const sanitized = sanitizeMediaType(mediaType)
  if (!sanitized.startsWith('image/')) throw new Error(`human avatar must be an image (got '${mediaType}')`)
  return sanitized
}

/** Write one avatar as an immutable entry; the caller stores the ref in settings. */
export async function writeHumanAvatar(
  root: string,
  rawName: string,
  mediaType: string,
  bytes: Buffer,
): Promise<{ avatarRef: string; path: string; name: string; byteSize: number; mediaType: string }> {
  if (bytes.byteLength === 0) throw new Error('human avatar must not be empty')
  if (bytes.byteLength > HUMAN_AVATAR_MAX_BYTES) throw new Error(`human avatar exceeds the ${HUMAN_AVATAR_MAX_BYTES} byte limit`)
  const storedMediaType = assertAvatarMediaType(mediaType)
  const name = sanitizeFileName(rawName)
  const avatarRef = randomUUID()
  const dir = avatarDir(root, avatarRef)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), bytes)
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ name, mediaType: storedMediaType, uploadedAt: new Date().toISOString() }), 'utf8')
  return { avatarRef, path: join(dir, name), name, byteSize: bytes.byteLength, mediaType: storedMediaType }
}

/** Read one avatar back; `undefined` when removed or never written. */
export async function readHumanAvatar(root: string, avatarRef: string): Promise<StoredHumanAvatar | undefined> {
  const dir = avatarDir(root, avatarRef)
  let metaRaw: Buffer
  try {
    metaRaw = await readFile(join(dir, 'meta.json'))
  } catch {
    return undefined
  }
  const meta = JSON.parse(metaRaw.toString('utf8')) as { name: string; mediaType: string; uploadedAt: string }
  const entries = await readdir(dir)
  const payload = entries.filter(entry => entry !== 'meta.json')[0]
  if (payload === undefined) return undefined
  const bytes = await readFile(join(dir, payload))
  return { name: meta.name, mediaType: meta.mediaType, byteSize: bytes.byteLength, uploadedAt: meta.uploadedAt, bytes }
}

/** Remove one avatar entry; missing entries already satisfy the removal. */
export async function removeHumanAvatar(root: string, avatarRef: string): Promise<void> {
  await rm(avatarDir(root, avatarRef), { recursive: true, force: true })
}
