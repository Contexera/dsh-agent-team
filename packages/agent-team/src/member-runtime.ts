import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {
  AgentTeamAgentMember,
  AgentTeamMemberCapabilities,
  AgentTeamMemberId,
} from './types.ts'
import * as memberSkills from './member-skills.ts'
import type { MemberSkillProviderMount } from './member-skills.ts'
import { MemberToolPolicy } from './member-tool-policy.ts'

/** Result of waiting for a turn boundary: `waited` if a running turn had to finish first, `idle` if the Member was already between turns. */
export type TurnBoundary = 'waited' | 'idle'

/** Read-only core skills shipped beside the preset (meta skill first: its description routes skill-management work to itself), resolved from this module's emitted location so it follows the installed plugin. */
const BUNDLED_SKILLS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../core-skills')

export function deepCopyCapabilities(capabilities: AgentTeamMemberCapabilities): AgentTeamMemberCapabilities {
  const copyAllow = (allow: readonly string[] | undefined): { allow?: readonly string[] } =>
    allow === undefined ? {} : { allow: [...allow] }
  return {
    ...(capabilities.tools === undefined ? {} : { tools: copyAllow(capabilities.tools.allow) }),
    ...(capabilities.skills === undefined ? {} : { skills: copyAllow(capabilities.skills.allow) }),
  }
}

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

interface MemberRuntimeDeps {
  /** Host context for agent events, tool schemas, and the workspace registry. */
  readonly ctx: Context
  /** Resolve one Member's live agent context, or throw when it has none. */
  readonly liveMemberContext: (memberId: AgentTeamMemberId) => Context
  /** Agent ids with a turn in flight; shared by reference with the service. */
  readonly runningAgents: ReadonlySet<SessionId>
}

export class MemberRuntime {
  readonly toolPolicy: MemberToolPolicy
  /** Per-Member skill provider mounts. One entry holds the selection swap and the disposer, so a catalog re-filter and the unmount never disagree about which provider is live. */
  private readonly skillProviderMounts = new Map<AgentTeamMemberId, MemberSkillProviderMount>()

  constructor(private readonly deps: MemberRuntimeDeps) {
    this.toolPolicy = new MemberToolPolicy(deps)
  }

  /** Outstanding boundary waits, held so Host shutdown can release them all. */
  private readonly turnWaitResolvers = new Set<() => void>()

  /** Waits until a live Member's current turn ends or its Session is disposed; returns whether a running turn had to be awaited. The running turn keeps its schemas and catalog; the swap happens once idle so the next step sees the new restriction and skill selection on the same Session. Suspend/remove resolves the wait (the disposed handle already released the restriction); Host shutdown resolves every wait through `releaseTurnWaits`. */
  async awaitTurnBoundary(active: AgentHandle): Promise<TurnBoundary> {
    if (!this.deps.runningAgents.has(active.agent.id)) return 'idle'
    await new Promise<void>(resolve => {
      const disposers: Array<() => void> = []
      const settle = (): void => {
        this.turnWaitResolvers.delete(settle)
        for (const dispose of disposers.splice(0)) dispose()
        resolve()
      }
      this.turnWaitResolvers.add(settle)
      disposers.push(
        this.deps.ctx.on('agent/status', (payload: { agent: Agent; status: string }) => {
          if (payload.agent !== active.agent) return
          // A turn ending, cleanly or by error, is the boundary.
          if (payload.status !== 'running') settle()
        }),
        // Disposal resolves the wait: the restriction went with the disposed scope, leaving only the ledger intent for the next activation.
        this.deps.ctx.on('session/disposed', (session: { id: SessionId }) => {
          if (session.id === active.agent.session.id) settle()
        }),
      )
    })
    return 'waited'
  }

  /** Host-shutdown exit: resolves every boundary wait so the Member's lifecycle chain drains; `settle` removes each wait's listeners, so nothing survives shutdown. */
  releaseTurnWaits(): void {
    // Snapshot: every `settle` removes its own entry from the set.
    for (const settle of Array.from(this.turnWaitResolvers)) settle()
  }

  /** Mounts bundled core skills plus the Member's private directory behind the exact Agent entry in its preset's isolated skills router. Without that Team registry nothing is registered. The sanitized directory is authoritative; activateMember migrates any legacy colon directory onto it first. */
  mountMemberSkillProvider(
    member: AgentTeamAgentMember,
    agentCtx: Context,
    initialSelection: readonly string[] | undefined,
  ): void {
    const mount = memberSkills.mountMemberSkillProvider(agentCtx, this.deps.ctx.agentPresets, {
      skillsDirectory: join(memberMemoryDirectoryPath(member), 'skills'),
      bundledSkillsDirectory: BUNDLED_SKILLS_DIRECTORY,
      initialSelection,
    })
    if (mount === undefined) return
    this.skillProviderMounts.set(member.memberId, mount)
  }

  /** Live-apply a capability edit to a mounted provider; a no-op when this Member has none. */
  swapSkillSelection(memberId: AgentTeamMemberId, allow: readonly string[] | undefined): void {
    this.skillProviderMounts.get(memberId)?.swap(allow)
  }

  /**
   * Provisions a Member's private memory namespace: notes/, skills/, and a first-run memory.md scaffold. The per-Member skill provider scans exactly this root.
   *
   * `privateMemoryPath` is a durable Member fact that cannot be rewritten, so a legacy colon directory recorded in the ledger is renamed onto the sanitized path once (same-parent, atomic) rather than orphaning existing memory. A recorded path in a different DSH home is never acted on (see `migrateLegacyMemoryDirectory`).
   *
   * A colon-form twin directory is merged too: the branded `member:<uuid>` ref shown by every Team tool result leads Members to hand-assemble colon paths, which Linux accepts silently (two directories for one Member) and Windows rejects. `memory.md` cannot merge, so the sanitized copy wins and twin-only notes/skills move in without overwriting.
   */
  async initializePrivateMemory(path: string, legacyPath?: string): Promise<void> {
    if (legacyPath !== undefined && legacyPath !== path) {
      const migration = await migrateLegacyMemoryDirectory(legacyPath, path)
            // A refusal means the record names a directory in another DSH home: provision fresh here rather than take that directory out of its home.
      if (migration === 'refused-foreign-home') this.deps.ctx.logger.warn(`agent-team: refused to migrate the recorded Member private memory '${legacyPath}' into '${path}': they are not in the same directory, so the recorded directory names a different DSH home and is left untouched`)
    }
    const twinPath = twinMemoryDirectoryPath(path)
    if (twinPath !== undefined) await mergeTwinMemoryDirectory(twinPath, path)
    await mkdir(join(path, 'notes'), { recursive: true })
    await mkdir(join(path, 'skills'), { recursive: true })
    try {
      await writeFile(join(path, 'memory.md'), '# Member memory\n\nCold-start recovery index. Where knowledge belongs, writing, compaction, and demotion rules: the bundled `member-memory-manager` skill.\n\n## Durable rules\n- <rule>\n\n## On-demand notes\n- <scenario> → `notes/<cluster>/README.md`\n\n## Open local state\n- <unfinished local state> (<task, thread, or path>)\n', { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  /** Irreversibly remove one Member: archive its Session and delete its private namespace. */
  async cleanupRemovedMember(member: AgentTeamAgentMember): Promise<void> {
        // The ledger path may still name the legacy colon directory: remove both spellings (rm tolerates the missing one). Every target must sit inside this process's members root: the recorded path is a durable absolute fact, and a process resolving another DSH home would otherwise delete the real Member's private memory.
    const sanitized = memberMemoryDirectoryPath(member)
    const targets = sanitized === member.privateMemoryPath ? [sanitized] : [sanitized, member.privateMemoryPath]
    const owned = targets.filter(target => isInsideMembersRoot(target))
    const refused = targets.filter(target => !isInsideMembersRoot(target))
    if (refused.length > 0) this.deps.ctx.logger.warn(`agent-team: refused to delete recorded Member private memory outside this DSH home: ${refused.map(target => `'${target}'`).join(', ')}`)
    const results = await Promise.allSettled([
      this.deps.ctx.workspaceRegistry.archiveSession(member.sessionId),
      ...owned.map(target => rm(target, { recursive: true, force: true })),
    ])
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, `failed to clean up removed Member '${member.memberId}'`)
  }

  /** Drop one Member's transient selection/disposer state after its handle is gone; safe to call twice. */
  forgetMember(memberId: AgentTeamMemberId): void {
    const mount = this.skillProviderMounts.get(memberId)
    if (mount !== undefined) {
      this.skillProviderMounts.delete(memberId)
      mount.dispose()
    }
    this.toolPolicy.forgetMember(memberId)
  }

  /** Dispose every registered per-Member seam; service shutdown only. */
  disposeAll(): void {
    const members = new Set([...this.toolPolicy.memberIds(), ...this.skillProviderMounts.keys()])
    for (const memberId of members) this.forgetMember(memberId)
  }
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
