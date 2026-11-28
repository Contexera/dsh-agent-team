import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { AgentTeamAgentMember, AgentTeamMemberId } from './types.ts'

/** Directory segment for a Member's private memory. The `member:<uuid>` ref must never appear in a path: Windows rejects `:` in a path segment (NTFS reads it as an Alternate Data Stream separator). */
export function memberMemoryDirectoryName(memberId: AgentTeamMemberId): string {
  return memberId.replaceAll(':', '-')
}

/** The sanitized absolute private-memory path for one Member, regardless of what the ledger recorded. */
export function memberMemoryDirectoryPath(member: Pick<AgentTeamAgentMember, 'memberId' | 'privateMemoryPath'>): string {
  // Only the recorded final segment can carry the ledger's member-identity colon, so only it is rewritten. A Windows drive-letter colon is not an identity and must survive: a colon-free final segment keeps the recorded path verbatim.
  const separator = Math.max(member.privateMemoryPath.lastIndexOf('/'), member.privateMemoryPath.lastIndexOf('\\'))
  const finalSegment = separator === -1 ? member.privateMemoryPath : member.privateMemoryPath.slice(separator + 1)
  if (!finalSegment.includes(':')) return member.privateMemoryPath
  const prefix = separator === -1 ? '' : member.privateMemoryPath.slice(0, separator + 1)
  return prefix + memberMemoryDirectoryName(member.memberId)
}

export function localMemberMemoryDirectory(memberId: AgentTeamMemberId): string {
  return dshHomePath('agent-team', 'members', memberMemoryDirectoryName(memberId))
}

/**
 * Provisions a Member's private memory namespace: notes/, skills/, and a first-run memory.md scaffold. The per-Member skill provider scans exactly this root.
 *
 * `privateMemoryPath` is a durable Member fact that cannot be rewritten, so a legacy colon directory recorded in the ledger is renamed onto the sanitized path once (same-parent, atomic) rather than orphaning existing memory. A recorded path in a different DSH home is never acted on (see `migrateLegacyMemoryDirectory`).
 *
 * A colon-form twin directory is merged too: the branded `member:<uuid>` ref shown by every Team tool result leads Members to hand-assemble colon paths, which Linux accepts silently (two directories for one Member) and Windows rejects. `memory.md` cannot merge, so the sanitized copy wins and twin-only notes/skills move in without overwriting.
 */
export async function initializeMemberPrivateMemory(path: string, options: {
  readonly legacyPath?: string
  readonly warn: (message: string) => void
}): Promise<void> {
  const { legacyPath, warn } = options
  if (legacyPath !== undefined && legacyPath !== path) {
    const migration = await migrateLegacyMemoryDirectory(legacyPath, path)
    if (migration === 'refused-foreign-home') warn(`agent-team: refused to migrate the recorded Member private memory '${legacyPath}' into '${path}': they are not in the same directory, so the recorded directory names a different DSH home and is left untouched`)
  }
  const twinPath = twinMemoryDirectoryPath(path)
  if (twinPath !== undefined) await mergeTwinMemoryDirectory(twinPath, path)
  await initializePrivateAssets(path, '# Member memory\n\nCold-start recovery index. Where knowledge belongs, writing, compaction, and demotion rules: the bundled `member-memory-manager` skill.\n\n## Durable rules\n- <rule>\n\n## On-demand notes\n- <scenario> → `notes/<cluster>/README.md`\n\n## Open local state\n- <unfinished local state> (<task, thread, or path>)\n')
}

export function initializeManagerPrivateAssets(root: string): Promise<void> {
  return initializePrivateAssets(root, [
    '# Team manager memory',
    '',
    'Cold-start recovery index for the Team manager. Writing and review rules: the bundled `manager-memory` skill.',
    '',
    '## Durable rules',
    '- <rule>',
    '',
    '## On-demand notes',
    '- <scenario> → `notes/<cluster>/README.md`',
    '',
    '## Open local state',
    '- <unfinished local state> (<path or ref>)',
    '',
  ].join('\n'))
}

async function initializePrivateAssets(root: string, scaffold: string): Promise<void> {
  await mkdir(join(root, 'notes'), { recursive: true })
  await mkdir(join(root, 'skills'), { recursive: true })
  try {
    await writeFile(join(root, 'memory.md'), scaffold, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** Defer deletion until the lifecycle caller has started Session archival. */
export function prepareMemberPrivateMemoryRemoval(
  member: Pick<AgentTeamAgentMember, 'memberId' | 'privateMemoryPath'>,
  warn: (message: string) => void,
): () => Promise<void>[] {
  // The ledger may still name the legacy colon path. Neither spelling may be deleted outside this DSH home.
  const sanitized = memberMemoryDirectoryPath(member)
  const targets = sanitized === member.privateMemoryPath ? [sanitized] : [sanitized, member.privateMemoryPath]
  const owned = targets.filter(target => isInsideMembersRoot(target))
  const refused = targets.filter(target => !isInsideMembersRoot(target))
  if (refused.length > 0) warn(`agent-team: refused to delete recorded Member private memory outside this DSH home: ${refused.map(target => `'${target}'`).join(', ')}`)
  return () => owned.map(target => rm(target, { recursive: true, force: true }))
}

/**
 * One-time in-place migration of a colon-named private memory directory onto its sanitized path. An existing sanitized target wins (idempotent across restarts); a missing legacy source is the fresh-install case.
 *
 * The rename is confined to one parent directory: a process resolving a different DSH home (isolated test home, second instance) holds a sanitized target in its own tree while the record names the real one, and renaming across trees would silently take a Member's private memory out of its home. Such a source is left in place and only that refusal is reported.
 */
async function migrateLegacyMemoryDirectory(legacyPath: string, path: string): Promise<'refused-foreign-home' | undefined> {
  let legacy: Awaited<ReturnType<typeof stat>>
  try {
    legacy = await stat(legacyPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!legacy.isDirectory()) throw new Error(`legacy Member memory path '${legacyPath}' exists but is not a directory`)
  if (dirname(legacyPath) !== dirname(path)) return 'refused-foreign-home'
  try {
    await stat(path)
    return undefined // Sanitized directory already present: migration already done or a new install.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await rename(legacyPath, path)
  return undefined
}

/** Whether an absolute path names a Member directory inside this process's members root; only such a path is this process's to delete. */
function isInsideMembersRoot(candidate: string): boolean {
  const fromRoot = relative(dshHomePath('agent-team', 'members'), resolve(candidate))
  // '' is the members root itself and '..' escapes it: only a real descendant is authorized.
  return fromRoot.length > 0 && !fromRoot.startsWith('..') && !isAbsolute(fromRoot)
}

/** The colon-form twin path of one sanitized Member memory directory, when the segment form admits one. */
function twinMemoryDirectoryPath(sanitizedPath: string): string | undefined {
  const separator = Math.max(sanitizedPath.lastIndexOf('/'), sanitizedPath.lastIndexOf('\\'))
  const prefix = separator === -1 ? '' : sanitizedPath.slice(0, separator + 1)
  const finalSegment = separator === -1 ? sanitizedPath : sanitizedPath.slice(separator + 1)
  // Only the exact sanitized identity segment (`member-<uuid>`) has a colon twin (`member:<uuid>`).
  if (!/^member-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(finalSegment)) return undefined
  return `${prefix}member:${finalSegment.slice('member-'.length)}`
}

/** The colon-twin trace name for one conflicting file: `note.md` → `note.colon-twin.md`. */
function colonTwinTraceName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? `${name}.colon-twin` : `${name.slice(0, dot)}.colon-twin${name.slice(dot)}`
}

/** Merges a hand-created colon-form twin into the sanitized Member memory directory. Unlike the legacy migration this is a merge: the sanitized directory is the live root, so on conflict its copy wins and the twin's copy is kept beside it under a `.colon-twin` name. Twin-only files move in under their own names, then the emptied twin is removed. */
async function mergeTwinMemoryDirectory(twinPath: string, path: string): Promise<void> {
  let twin: Awaited<ReturnType<typeof stat>>
  try {
    twin = await stat(twinPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return
  }
  if (!twin.isDirectory()) return
  await mergeDirectoryContents(twinPath, path)
  await rm(twinPath, { recursive: true, force: true })
}

/** Recursively move every twin file into the live root; an existing live file wins, its twin copy traced beside it. */
async function mergeDirectoryContents(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    if (entry.isDirectory()) {
      await mergeDirectoryContents(sourcePath, targetPath)
    } else if (entry.isFile()) {
      // rename(2) silently replaces an existing target on POSIX (EEXIST exists only on Windows, where the twin cannot exist), so probe first. Activation is the single serialized writer, so the probe-to-rename window has no race.
      let liveFilePresent = true
      try {
        await stat(targetPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        liveFilePresent = false
      }
      // The live root stays authoritative; the twin's losing copy stays traceable beside it.
      await rename(sourcePath, liveFilePresent ? join(target, colonTwinTraceName(entry.name)) : targetPath)
    }
  }
}
