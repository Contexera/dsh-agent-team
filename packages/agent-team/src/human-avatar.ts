import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { sanitizeFileName, sanitizeMediaType } from './attachments.ts'
import { HUMAN_AVATAR_MAX_BYTES } from './human-settings.ts'

/** Persistent human avatar store: `<avatarRef>/` payload plus `meta.json`, with no TTL sweep since avatars outlive message attachments. */

export function humanAvatarsRoot(): string {
  return dshHomePath('agent-team', 'human', 'v1')
}

const HUMAN_AVATAR_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The directory id emitted by every released avatar writer; reject every other value before it reaches a path join. */
export function assertHumanAvatarRef(avatarRef: string): string {
  if (!HUMAN_AVATAR_REF.test(avatarRef)) throw new Error(`invalid human avatar reference '${avatarRef}'`)
  return avatarRef
}

function avatarDir(root: string, avatarRef: string): string {
  return join(root, assertHumanAvatarRef(avatarRef))
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'
}

/** Resolve one existing avatar directory and reject a symlink or a real path outside the store. */
async function existingAvatarDir(root: string, avatarRef: string): Promise<string | undefined> {
  const lexical = avatarDir(root, avatarRef)
  try {
    const [rootPath, dirPath, info] = await Promise.all([realpath(root), realpath(lexical), lstat(lexical)])
    if (info.isSymbolicLink() || !info.isDirectory() || dirname(dirPath) !== rootPath) {
      throw new Error(`human avatar '${avatarRef}' is outside the avatar store`)
    }
    return dirPath
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

/** Resolve one regular file directly inside an avatar directory, never following a symlink out of it. */
async function avatarFile(dir: string, name: string): Promise<string | undefined> {
  const lexical = join(dir, name)
  try {
    const [filePath, info] = await Promise.all([realpath(lexical), lstat(lexical)])
    if (info.isSymbolicLink() || !info.isFile() || dirname(filePath) !== dir) {
      throw new Error(`human avatar payload '${name}' is outside its avatar directory`)
    }
    return filePath
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
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
  let created = false
  try {
    await mkdir(root, { recursive: true })
    await mkdir(dir)
    created = true
    const [rootPath, dirPath] = await Promise.all([realpath(root), realpath(dir)])
    if (dirname(dirPath) !== rootPath) throw new Error(`human avatar '${avatarRef}' is outside the avatar store`)
    const path = join(dirPath, name)
    await writeFile(path, bytes)
    await writeFile(join(dirPath, 'meta.json'), JSON.stringify({ name, mediaType: storedMediaType, uploadedAt: new Date().toISOString() }), 'utf8')
    return { avatarRef, path, name, byteSize: bytes.byteLength, mediaType: storedMediaType }
  } catch (error) {
    if (created) await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/** Read one avatar back; `undefined` when removed or never written. */
export async function readHumanAvatar(root: string, avatarRef: string): Promise<StoredHumanAvatar | undefined> {
  const dir = await existingAvatarDir(root, avatarRef)
  if (dir === undefined) return undefined
  const metaPath = await avatarFile(dir, 'meta.json')
  if (metaPath === undefined) return undefined
  const metaRaw = await readFile(metaPath)
  const meta = JSON.parse(metaRaw.toString('utf8')) as { name: string; mediaType: string; uploadedAt: string }
  // Avatar storage first shipped after the filename sanitizer's released shape,
  // so every historical writer already stored the sanitized name verbatim.
  if (typeof meta.name !== 'string' || sanitizeFileName(meta.name) !== meta.name
    || typeof meta.mediaType !== 'string' || typeof meta.uploadedAt !== 'string') {
    throw new Error(`human avatar '${avatarRef}' has invalid metadata`)
  }
  assertAvatarMediaType(meta.mediaType)
  const payloadPath = await avatarFile(dir, meta.name)
  if (payloadPath === undefined) return undefined
  const bytes = await readFile(payloadPath)
  return { name: meta.name, mediaType: meta.mediaType, byteSize: bytes.byteLength, uploadedAt: meta.uploadedAt, bytes }
}

/** Remove one avatar entry; missing entries already satisfy the removal. */
export async function removeHumanAvatar(root: string, avatarRef: string): Promise<void> {
  const dir = await existingAvatarDir(root, avatarRef)
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
}
