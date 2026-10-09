/**
 * Per-Member runtime state extracted from the Agent Team Host service: the
 * cohesive per-Member maps and methods that must dispose together across
 * activation, edit, suspend, and removal — the tool-policy restriction seam,
 * the private skill selection/provider mounts, capability warnings, and
 * private-memory provisioning.
 *
 * This class is Host-side by design: its turn-boundary wait subscribes to
 * Host-level agent events, and every traceable-service registration goes
 * through contexts the Host already owns. The service keeps orchestration
 * (ledger, handles, notifications, recovery); this module owns per-Member
 * runtime invariants.
 *
 * @module @contexera/dsh-agent-team/member-runtime
 */

import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {
  AgentTeamAgentMember,
  AgentTeamCapabilityWarning,
  AgentTeamMemberCapabilities,
  AgentTeamMemberId,
} from './types.ts'
import * as memberSkills from './member-skills.ts'
import type { MemberSkillSelectionRef } from './member-skills.ts'

/**
 * Read-only core skills shipped beside the preset (the meta skill first:
 * its description routes any skill-management work to itself). Resolved
 * from this module's emitted location so it follows the installed plugin,
 * like the preset roster's own root.
 */
const BUNDLED_SKILLS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../core-skills')

/** Model-facing capabilities every Team-enabled preset must publish. */
export const AGENT_TEAM_TOOL_NAMES = Object.freeze([
  'team_inbox',
  'team_thread',
  'team_message',
  'team_claim',
  'team_view',
  'context_rollover',
  'context_checkpoint',
  'context_status',
  'context_compact',
] as const)

/** Copy a Remote-supplied capability overlay into owned frozen storage. */
export function deepCopyCapabilities(capabilities: AgentTeamMemberCapabilities): AgentTeamMemberCapabilities {
  const copyAllow = (allow: readonly string[] | undefined): { allow?: readonly string[] } =>
    allow === undefined ? {} : { allow: [...allow] }
  return {
    ...(capabilities.tools === undefined ? {} : { tools: copyAllow(capabilities.tools.allow) }),
    ...(capabilities.skills === undefined ? {} : { skills: copyAllow(capabilities.skills.allow) }),
  }
}

/**
 * Filesystem directory segment for one Member's private memory namespace.
 * The `member:<uuid>` ref is a durable ledger identity and must never appear
 * in a path: Windows rejects `:` in a path segment (NTFS parses it as an
 * Alternate Data Stream separator), which made Member activation fail at its
 * first `mkdir` on Windows (issue #7).
 */
export function memberMemoryDirectoryName(memberId: AgentTeamMemberId): string {
  return memberId.replaceAll(':', '-')
}

/** The sanitized absolute private-memory path for one Member, regardless of what the ledger recorded. */
export function memberMemoryDirectoryPath(member: Pick<AgentTeamAgentMember, 'memberId' | 'privateMemoryPath'>): string {
  // Sanitize per segment: only a segment that actually contains the ledger's
  // member identity colon needs rewriting, and the recorded final segment is
  // the only place it can appear. The drive-letter colon of a Windows
  // absolute prefix is not a member identity and must survive untouched, so
  // a colon-free final segment keeps the recorded path verbatim even when
  // earlier segments carry colons.
  const separator = Math.max(member.privateMemoryPath.lastIndexOf('/'), member.privateMemoryPath.lastIndexOf('\\'))
  const finalSegment = separator === -1 ? member.privateMemoryPath : member.privateMemoryPath.slice(separator + 1)
  if (!finalSegment.includes(':')) return member.privateMemoryPath
  const prefix = separator === -1 ? '' : member.privateMemoryPath.slice(0, separator + 1)
  return prefix + memberMemoryDirectoryName(member.memberId)
}

/** Everything the runtime needs from its owning Host service. */
export interface MemberRuntimeDeps {
  /** Host context for agent events, tool schemas, and the workspace registry. */
  readonly ctx: Context
  /** Resolve one Member's live agent context, or throw when it has none. */
  readonly liveMemberContext: (memberId: AgentTeamMemberId) => Context
  /** Agent ids with a turn in flight; shared by reference with the service. */
  readonly runningAgents: ReadonlySet<SessionId>
}

/** Per-Member runtime state; the four maps dispose together with each Member. */
export class MemberRuntime {
  /**
   * Live per-Member tool restriction disposers, mirroring modelSelections:
   * activation registers, disposal paths release, edits swap at a turn
   * boundary. Deliberate interface reservation: the restriction seam is the
   * primitive future Runtime Revision manifests orchestrate — do not remove
   * during cleanup.
   */
  private readonly memberRestrictions = new Map<AgentTeamMemberId, () => void>()
  /**
   * The allow-list currently enforced behind `memberRestrictions`: the
   * rollback source when a swap's new restriction fails to install, so a
   * failed apply never leaves the Member less restricted than before.
   */
  private readonly enforcedToolAllow = new Map<AgentTeamMemberId, readonly string[]>()
  /**
   * Capability intent the live surface is known to reflect (`null` = applied
   * with no capabilities): runtime-derived like `capabilityWarnings`, never
   * persisted, and absent whenever the runtime cannot prove it — an unknown
   * surface re-applies rather than trusting a guess.
   */
  private readonly appliedCapabilities = new Map<AgentTeamMemberId, AgentTeamMemberCapabilities | null>()
  /**
   * Runtime-derived capability warnings, recomputed at every activation (like
   * memberFailures, keyed by Member and never persisted): persisted warnings
   * would lie after a Host restart or a Harness upgrade renames tools.
   */
  private readonly capabilityWarnings = new Map<AgentTeamMemberId, readonly AgentTeamCapabilityWarning[]>()
  /** Live skill selection refs let capability edits re-filter the catalog without disposing the Session. */
  private readonly skillSelections = new Map<AgentTeamMemberId, MemberSkillSelectionRef>()
  /** Per-Member private skill provider disposers; released with the Member's agent scope. */
  private readonly skillProviderDisposals = new Map<AgentTeamMemberId, () => void>()

  constructor(private readonly deps: MemberRuntimeDeps) {}

  /** One Member's live capability warnings, if any; runtime-derived, never persisted. */
  capabilityWarningsFor(memberId: AgentTeamMemberId): readonly AgentTeamCapabilityWarning[] | undefined {
    return this.capabilityWarnings.get(memberId)
  }

  /**
   * Apply one Member's persisted tool allow-list as a scoped restriction on
   * the freshly composed preset surface, and derive activation-time warnings
   * for entries the current tool surface no longer knows. Runs inside setup
   * BEFORE validateMemberPreset so the validation observes the restricted
   * view (the Host always unions the five Team tools over the configured
   * list). Deliberate interface reservation: this restriction seam is the
   * primitive future Runtime Revision manifests orchestrate — do not remove
   * during cleanup.
   */
  applyMemberToolPolicy(agentCtx: Context, member: AgentTeamAgentMember): void {
    const configured = member.capabilities?.tools?.allow
    if (configured === undefined) {
      this.capabilityWarnings.delete(member.memberId)
      return
    }
    // Drop names the current surface does not know rather than failing the
    // activation: a Harness upgrade renaming a tool must not make the Member
    // unavailable. The warning carries the known-name digest so a distant
    // future reader can diagnose the drift.
    const known = this.deps.ctx.tools.schemas(scopeOf(agentCtx)).map(tool => tool.name)
    const knownSet = new Set(known)
    const dropped = configured.filter(name => !knownSet.has(name))
    this.setCapabilityWarnings(member.memberId, dropped.map(name => ({ name, knownNames: known })))
    const allow = [...new Set([...configured.filter(name => knownSet.has(name)), ...AGENT_TEAM_TOOL_NAMES])]
    if (allow.length === 0) return
    // tools.restrict() requires a scoped context and rejects names outside
    // the inherited surface; both errors surface as this Member's activation
    // failure without touching any other Member.
    const dispose = agentCtx.tools.restrict({ allow })
    this.memberRestrictions.set(member.memberId, dispose)
    this.enforcedToolAllow.set(member.memberId, Object.freeze([...allow]))
  }

  /** Whether the live surface is known to reflect exactly this capability intent; an absent record never matches. */
  appliedCapabilitiesMatch(memberId: AgentTeamMemberId, capabilities: AgentTeamMemberCapabilities | undefined): boolean {
    if (!this.appliedCapabilities.has(memberId)) return false
    return isDeepStrictEqual(this.appliedCapabilities.get(memberId) ?? undefined, capabilities ?? undefined)
  }

  /** Record the capability intent the live surface now reflects; callers invoke it only after every effect of the apply succeeded. */
  recordAppliedCapabilities(memberId: AgentTeamMemberId, capabilities: AgentTeamMemberCapabilities | undefined): void {
    this.appliedCapabilities.set(memberId, capabilities ?? null)
  }

  /**
   * Swap a live Member's tool policy at a turn boundary: dispose the old
   * restriction, apply the new one, and when the new install fails restore
   * the previous allow-list before rethrowing — the swap must never leave the
   * Member wider than the surface it started from.
   */
  reapplyMemberToolPolicy(member: AgentTeamAgentMember): void {
    const agentCtx = this.deps.liveMemberContext(member.memberId)
    const previousAllow = this.enforcedToolAllow.get(member.memberId)
    this.releaseMemberToolPolicy(member.memberId)
    try {
      this.applyMemberToolPolicy(agentCtx, member)
    } catch (error) {
      if (previousAllow !== undefined) {
        try {
          const dispose = agentCtx.tools.restrict({ allow: [...previousAllow] })
          this.memberRestrictions.set(member.memberId, dispose)
          this.enforcedToolAllow.set(member.memberId, previousAllow)
          // Capability warnings are deliberately NOT restored: they describe
          // the STORED configuration's divergence from the tool surface (the
          // input `applyMemberToolPolicy` derives from), and the accepted
          // edit is stored even though its runtime apply failed — reporting
          // the restored leftover here would make one stored configuration
          // render two different warnings depending on the prior state. When
          // the failure precedes the derivation itself (schemas throws),
          // warnings stay empty rather than inventing a known-name digest;
          // the next successful apply or activation re-derives them.
        } catch (restore) {
          this.deps.ctx.logger.warn(`agent-team: failed to restore the previous tool restriction for member '${member.memberId}' after a failed apply: ${restore instanceof Error ? restore.message : String(restore)}`)
        }
      }
      throw error
    }
  }

  /** Release one Member's restriction disposer and warning state; safe to call twice. */
  releaseMemberToolPolicy(memberId: AgentTeamMemberId): void {
    const dispose = this.memberRestrictions.get(memberId)
    if (dispose !== undefined) {
      this.memberRestrictions.delete(memberId)
      dispose()
    }
    this.enforcedToolAllow.delete(memberId)
    this.capabilityWarnings.delete(memberId)
    this.appliedCapabilities.delete(memberId)
  }

  private setCapabilityWarnings(memberId: AgentTeamMemberId, warnings: readonly AgentTeamCapabilityWarning[]): void {
    if (warnings.length === 0) this.capabilityWarnings.delete(memberId)
    else this.capabilityWarnings.set(memberId, Object.freeze([...warnings]))
  }

  /** Outstanding boundary waits, held so Host shutdown can release them all. */
  private readonly turnWaitResolvers = new Set<() => void>()

  /**
   * Wait until one live Member's current turn ends or its Session is
   * disposed. While the Agent runs, the current turn keeps its schemas and
   * catalog; the swap happens once idle, so the next step recomputes schemas
   * from the new restriction and the durable replacement skill catalog from
   * the new selection, with the same Session and history surviving.
   * Suspend/remove during the wait resolves it — the disposed handle released
   * the old restriction already and no disposer leaks. Host shutdown resolves
   * every wait through `releaseTurnWaits` instead of waiting out a turn that
   * may never end. Returns whether any wait happened, so the caller can
   * re-check the handle afterwards.
   */
  async awaitTurnBoundary(active: AgentHandle): Promise<boolean> {
    if (!this.deps.runningAgents.has(active.agent.id)) return false
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
          // A turn that ends — clean idle or error — is the boundary; the
          // next step recomputes schemas from the new restriction.
          if (payload.status !== 'running') settle()
        }),
        // Disposal (suspend/remove/reactivation) resolves the wait: the old
        // restriction went with the disposed scope, so only the ledger
        // intent remains to apply at the next activation.
        this.deps.ctx.on('session/disposed', (session: { id: SessionId }) => {
          if (session.id === active.agent.session.id) settle()
        }),
      )
    })
    return true
  }

  /**
   * Host-shutdown exit for every boundary wait: resolve them all so the
   * Member's lifecycle chain drains without depending on a turn that may
   * never end. `settle` removes each wait's listeners, so no subscription,
   * waiter, or model request survives the shutdown.
   */
  releaseTurnWaits(): void {
    // Snapshot: every `settle` removes its own entry from the set.
    for (const settle of Array.from(this.turnWaitResolvers)) settle()
  }

  /**
   * Register the Member-private skill provider on the created agent's exact
   * scope layer (the traceable-service seam, like the tool restriction):
   * bundled read-only core skills plus this Member's own private directory,
   * with the live selection ref that later capability edits swap in place.
   * The sanitized directory is authoritative: activateMember migrated any
   * legacy colon directory onto it before the provider mounted.
   */
  mountMemberSkillProvider(member: AgentTeamAgentMember, agentCtx: Context, selection: MemberSkillSelectionRef): void {
    this.skillProviderDisposals.set(member.memberId, memberSkills.mountMemberSkillProvider(agentCtx, {
      skillsDirectory: join(memberMemoryDirectoryPath(member), 'skills'),
      bundledSkillsDirectory: BUNDLED_SKILLS_DIRECTORY,
      selection,
    }))
    this.skillSelections.set(member.memberId, selection)
  }

  /** Live-apply a capability edit to a registered selection; a no-op when none exists. */
  swapSkillSelection(memberId: AgentTeamMemberId, allow: readonly string[] | undefined): void {
    this.skillSelections.get(memberId)?.swap(allow)
  }

  /**
   * Provision one Member's private memory namespace: notes/, skills/, and a
   * first-run memory.md scaffold. The Member-private skills directory starts
   * empty; the per-Member provider scans exactly this root (default roots
   * excluded).
   *
   * Existing installs recorded the pre-fix colon directory in the ledger, and
   * `privateMemoryPath` is a durable Member fact the renewal path cannot
   * rewrite: when the legacy directory exists it is renamed onto the sanitized
   * path once (same-parent rename, atomic), so existing private memory
   * survives instead of being silently orphaned. A recorded path that names a
   * different DSH home is never acted on — see `migrateLegacyMemoryDirectory`.
   *
   * A colon-form twin directory is also merged when it exists: a Member may
   * have written files under the ledger identity spelling (the branded
   * `member:<uuid>` ref is what every Team tool result shows, so a
   * hand-assembled path carries the colon). Linux accepts the segment
   * silently — two directories for one Member — while Windows would have
   * failed the write outright. The twin is never a durable-Member-Fact
   * candidate: only the files the Member actually wrote there are worth
   * keeping, and `memory.md` cannot merge, so the sanitized copy always wins
   * and twin-only notes/skills are moved in without overwriting.
   */
  async initializePrivateMemory(path: string, legacyPath?: string): Promise<void> {
    if (legacyPath !== undefined && legacyPath !== path) {
      const migration = await migrateLegacyMemoryDirectory(legacyPath, path)
      // A refusal means the record names a directory in ANOTHER DSH home: this
      // process provisions the Member fresh here instead of taking that
      // directory out of its own home.
      if (migration === 'refused-foreign-home') this.deps.ctx.logger.warn(`agent-team: refused to migrate the recorded Member private memory '${legacyPath}' into '${path}': they are not in the same directory, so the recorded directory names a different DSH home and is left untouched`)
    }
    const twinPath = twinMemoryDirectoryPath(path)
    if (twinPath !== undefined) await mergeTwinMemoryDirectory(twinPath, path)
    await mkdir(join(path, 'notes'), { recursive: true })
    await mkdir(join(path, 'skills'), { recursive: true })
    try {
      await writeFile(join(path, 'memory.md'), '# Member memory\n\nA bounded routing index: identity, durable rules, what is in hand, and one line per topic cluster.\nWriting, compaction, and retirement rules: the bundled `member-memory-manager` skill.\n\n## Identity and role\n- <what this Member owns, and does not own>\n\n## Durable rules\n- <only rules that must bind every step; one line each>\n\n## In hand\n- <overwrite as work moves; this section never accumulates history>\n\n## Notes index\n- <cluster>: `notes/<cluster>/README.md`\n', { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  /** Irreversibly remove one Member: archive its Session and delete its private namespace. */
  async cleanupRemovedMember(member: AgentTeamAgentMember): Promise<void> {
    // The ledger path may still name the legacy colon directory (never
    // activated after the fix): remove both spellings; rm is force-tolerant
    // of the one that does not exist. Every target must sit inside THIS
    // process's members root: the recorded path is a durable absolute fact,
    // and a process resolving another DSH home (an isolated test home, a
    // second instance) would otherwise delete the directory that fact names —
    // the real Member's private memory.
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
    this.skillSelections.delete(memberId)
    const providerDispose = this.skillProviderDisposals.get(memberId)
    if (providerDispose !== undefined) {
      this.skillProviderDisposals.delete(memberId)
      providerDispose()
    }
    this.releaseMemberToolPolicy(memberId)
  }

  /** Dispose every registered per-Member seam; service shutdown only. */
  disposeAll(): void {
    this.skillSelections.clear()
    for (const dispose of this.skillProviderDisposals.values()) dispose()
    this.skillProviderDisposals.clear()
    for (const dispose of this.memberRestrictions.values()) dispose()
    this.memberRestrictions.clear()
    this.capabilityWarnings.clear()
  }
}

/**
 * One-time in-place migration of a pre-fix colon-named private memory
 * directory onto its sanitized path. A sanitized target that already exists
 * wins (idempotent across restarts and partially migrated installs); a legacy
 * source that never existed is simply the fresh-install case.
 *
 * The rename is confined to one parent directory, which is what the migration
 * has always meant: the recorded path is a durable absolute fact, so a process
 * resolving a different DSH home (an isolated test home, a second instance, a
 * moved home) holds a sanitized target in ITS tree while the record still names
 * the real one. Renaming across trees would take a Member's whole private
 * memory out of its home — silently, since only the next session notices an
 * empty index. Such a source is left exactly where it is, and only that
 * refusal is reported back: every other outcome needs nothing from the caller.
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

/**
 * Whether one absolute path names a Member directory inside THIS process's
 * members root. Only such a path is this process's to delete: a recorded path
 * may name the same Member in another DSH home, where the removal happening
 * here has no authority.
 */
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
  // Only the exact sanitized identity segment (`member-<uuid>`) has a colon
  // twin (`member:<uuid>`); any other segment shape has no identity mapping.
  if (!/^member-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(finalSegment)) return undefined
  return `${prefix}member:${finalSegment.slice('member-'.length)}`
}

/** The colon-twin trace name for one conflicting file: `note.md` → `note.colon-twin.md`. */
function colonTwinTraceName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? `${name}.colon-twin` : `${name.slice(0, dot)}.colon-twin${name.slice(dot)}`
}

/**
 * Merge a hand-created colon-form twin directory into the sanitized Member
 * memory directory. Unlike the ledger legacy migration this is a merge, not a
 * rename: the sanitized directory is the Member's live root (the injected
 * paths and the skill provider point at it), so on a same-path conflict the
 * live root's copy wins and the twin's losing copy is preserved beside it
 * under a `.colon-twin` name instead of being silently discarded. Twin-only
 * files move in under their own names; the emptied twin directory is then
 * removed so the drift cannot silently recur.
 */
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
      // rename(2) silently REPLACES an existing target on POSIX (the EEXIST
      // error only exists on Windows, where the colon twin cannot exist at
      // all), so a collision must be detected, not caught: probe the target
      // first. Activation is the single serialized writer, so the
      // probe-to-rename window has no concurrent writer to race.
      let liveFilePresent = true
      try {
        await stat(targetPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        liveFilePresent = false
      }
      // The live root stays authoritative; the twin's losing copy stays
      // traceable beside it instead of being silently discarded.
      await rename(sourcePath, liveFilePresent ? join(target, colonTwinTraceName(entry.name)) : targetPath)
    }
  }
}
