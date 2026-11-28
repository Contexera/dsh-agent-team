/**
 * Host-owned Team manager Session lifecycle. One runtime exists per Host and
 * owns the private pointer store, one serialized operation chain, and one
 * current Agent handle. A successor is prepared under that chain and becomes
 * current only at publication. It never creates a Member identity, reads
 * Member policy, or writes Team ledger facts.
 * @module @contexera/dsh-agent-team/manager-session
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type AgentOptions,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { MemberSkillProviderMount } from './member-skills.ts'
import { mountMemberSkillProvider } from './member-skills.ts'
import {
  sessionFailureOf,
  type StoredSessionFailure,
  type StoredSessionInspection,
  type StoredSessionReader,
} from './stored-session-reader.ts'
import type { ManagerSessionPointer, ManagerSessionStoreLike } from './manager-session-store.ts'
import {
  installManagerToolPolicy,
  MANAGER_SESSION_PRESET_ID,
  MANAGER_SESSION_TITLE,
  type ManagerToolPolicy,
} from './manager-tool-policy.ts'
import type {
  AgentTeamManagerDiagnostic,
  AgentTeamManagerDiagnosticClass,
  AgentTeamManagerSessionResult,
} from './types.ts'

type RecoverStoredPointer = () => AgentTeamManagerSessionResult | undefined | Promise<AgentTeamManagerSessionResult | undefined>

/** The default Workspace as the Host Controller resolved it. */
export interface ManagerWorkspaceValue {
  readonly workspaceId: WorkspaceId
  readonly path: string
}

/**
 * The read-only skills shipped with the bundle for the manager, resolved beside
 * the built module. It is a sibling of the Member core skills, never the same
 * directory: a manager skill must not enter a Member catalog and vice versa.
 */
export const MANAGER_BUNDLED_SKILLS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../manager-skills')

/** Everything the manager runtime consumes from the Host composition. */
export interface ManagerSessionRuntimeDeps {
  readonly ctx: Context
  readonly store: ManagerSessionStoreLike
  readonly reader: Pick<StoredSessionReader, 'read'>
  readonly managerPrivateRoot: string
  /** Scanned before the writable private directory, so a same-name private skill never shadows a shipped one. */
  readonly managerBundledSkillsRoot: string
  readonly defaultAgentOptions: () => AgentOptions
  readonly initializeDefaultWorkspace: (signal: AbortSignal) => Promise<ManagerWorkspaceValue | undefined>
}

interface ManagerGeneration {
  readonly handle: AgentHandle
  readonly policy: ManagerToolPolicy
  readonly skills: MemberSkillProviderMount | undefined
}

/** A pointer read that either yielded a value or already prepared the failure result. */
type PointerRead =
  | { readonly ok: true; readonly pointer: ManagerSessionPointer | undefined }
  | { readonly ok: false; readonly result: AgentTeamManagerSessionResult }

/**
 * The one manager Session runtime. Public mutating methods serialize through a
 * single chain; the guard sees the in-memory current handle, while the private
 * pointer remains the durable registration.
 */
export class ManagerSessionRuntime {
  private tail: Promise<void> = Promise.resolve()
  private current: ManagerGeneration | undefined
  private disposed = false
  private disposal: Promise<void> | undefined
  private readonly abort = new AbortController()

  constructor(private readonly deps: ManagerSessionRuntimeDeps) {}

  /**
   * Restore the registered Session at Host startup. A missing or archived
   * pointer is left untouched for the next open to replace; no Session is
   * created during boot.
   */
  preRestore(): Promise<AgentTeamManagerSessionResult | undefined> {
    return this.enqueue(async () => {
      try {
        const read = this.readPointer()
        if (!read.ok) return read.result
        const pointer = read.pointer
        if (pointer === undefined || this.isArchived(pointer.sessionId)) return undefined
        const agent = this.current?.handle.agent
        if (agent?.id === pointer.sessionId) {
          return this.compositionIsManager(agent)
            ? this.ready(pointer)
            : this.unavailable(
              'preset-composition',
              'the live manager Agent has lost its team-manager composition',
              pointer.sessionId,
            )
        }
        // Keep the rejection inside this try: preRestore reports a classified
        // unavailable result instead of throwing an asynchronous read failure.
        return await this.resolveStoredPointer(pointer, {
          archived: () => undefined,
          missing: () => undefined,
          outsideMessage: 'the registered manager Session is already live outside the manager runtime',
        })
      } catch (error) {
        return this.unavailable('runtime', messageOf(error))
      }
    })
  }

  /** Ensure the durable manager pointer resolves to one usable live Session. */
  open(): Promise<AgentTeamManagerSessionResult> {
    return this.enqueue(async () => {
      try {
        return await this.openLocked()
      } catch (error) {
        return this.unavailable('runtime', messageOf(error))
      }
    })
  }

  /** Replace the current Session only while it is still the caller-observed pointer. */
  newConversation(expectedSessionId: SessionId): Promise<AgentTeamManagerSessionResult> {
    return this.enqueue(async () => {
      try {
        const read = this.readPointer()
        if (!read.ok) return read.result
        const pointer = read.pointer
        if (pointer === undefined) return this.replaceLocked(undefined)
        if (pointer.sessionId !== expectedSessionId) return this.currentStatusLocked(pointer)
        return this.replaceLocked(pointer)
      } catch (error) {
        return this.unavailable('runtime', messageOf(error))
      }
    })
  }

  /** Current and replaced manager Sessions remain Team-owned; an unreadable lineage cannot authorize ordinary reuse. */
  ownsSession(sessionId: SessionId): boolean {
    if (this.disposed) throw new Error('Team manager runtime is disposed')
    return this.deps.store.ownedSessionIds().includes(sessionId)
  }

  /**
   * Whether this exact Agent is the live, currently registered manager. A tool
   * handler asks this itself: `ownsSession` answers lineage, which a replaced
   * generation still satisfies, so it cannot authorize a call on its own. The
   * answer is read from the in-memory handle and re-checked against the durable
   * pointer, and a pointer that cannot be read refuses rather than assuming.
   */
  isCurrentManagerAgent(agent: Agent): boolean {
    if (this.disposed) return false
    if (this.current?.handle.agent !== agent) return false
    try {
      if (this.deps.store.read()?.sessionId !== agent.id) return false
    } catch {
      return false
    }
    return this.compositionIsManager(agent) && !this.isArchived(agent.id)
  }

  /** Host teardown: stop the manager handle and release its policy before the domain closes. */
  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.abort.abort({ kind: 'disposed' })
    this.disposal = this.tail.then(async () => {
      const current = this.current
      this.current = undefined
      if (current !== undefined) {
        await this.stopGeneration(current, 'current manager Session disposal failed')
      }
    })
    return this.disposal
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      if (this.disposed) throw new Error('Team manager runtime is disposed')
      return operation()
    })
    this.tail = run.then(() => {}, () => {})
    return run
  }

  private async openLocked(): Promise<AgentTeamManagerSessionResult> {
    const read = this.readPointer()
    if (!read.ok) return read.result
    const pointer = read.pointer
    if (pointer === undefined) return this.replaceLocked(undefined)
    const agent = this.current?.handle.agent
    if (agent?.id === pointer.sessionId) {
      if (this.isArchived(pointer.sessionId)) return this.replaceLocked(pointer)
      if (this.compositionIsManager(agent)) return this.ready(pointer)
      return this.unavailable(
        'preset-composition',
        'the live manager Agent has lost its team-manager composition',
        pointer.sessionId,
      )
    }
    return (await this.resolveStoredPointer(pointer, {
      archived: () => this.replaceLocked(pointer),
      missing: () => this.replaceLocked(pointer),
      outsideMessage: 'the registered manager Session is already live outside the manager runtime',
    }))!
  }

  /**
   * Report the pointer a stale replacement observed without creating another
   * Session. Missing and unreadable pointers stay distinct so a damaged log is
   * never silently replaced by a stale caller.
   */
  private async currentStatusLocked(pointer: ManagerSessionPointer): Promise<AgentTeamManagerSessionResult> {
    const agent = this.current?.handle.agent
    if (agent?.id === pointer.sessionId) {
      if (this.isArchived(pointer.sessionId)) {
        return this.unavailable('runtime', 'the current manager Session was archived', pointer.sessionId)
      }
      return this.compositionIsManager(agent)
        ? this.ready(pointer)
        : this.unavailable(
          'preset-composition',
          'the live manager Agent has lost its team-manager composition',
          pointer.sessionId,
        )
    }
    return (await this.resolveStoredPointer(pointer, {
      archived: () => this.unavailable('runtime', 'the current manager Session was archived', pointer.sessionId),
      missing: () => this.unavailable(
        'session-unreadable',
        'the current manager Session is missing; reopen the destination to replace it',
        pointer.sessionId,
      ),
      outsideMessage: 'the current manager Session is live outside the manager runtime',
    }))!
  }

  /** The caller decides whether an archived or missing pointer can be replaced. */
  private async resolveStoredPointer(
    pointer: ManagerSessionPointer,
    options: {
      readonly archived: RecoverStoredPointer
      readonly missing: RecoverStoredPointer
      readonly outsideMessage: string
    },
  ): Promise<AgentTeamManagerSessionResult | undefined> {
    if (this.isArchived(pointer.sessionId)) return await options.archived()
    if (this.liveOutsideManager(pointer.sessionId)) {
      return this.unavailable('session-unreadable', options.outsideMessage, pointer.sessionId)
    }
    const stored = await this.deps.reader.read(pointer.sessionId, this.abort.signal)
    if (this.disposed) return this.unavailable('runtime', 'Team manager runtime is disposed', pointer.sessionId)
    if (!stored.ok) {
      if (stored.failure.kind === 'missing') return await options.missing()
      return this.readFailure(stored.failure)
    }
    return this.resumeLocked(pointer, stored.inspection, options)
  }

  private async resumeLocked(
    pointer: ManagerSessionPointer,
    inspection: StoredSessionInspection,
    recovery: {
      readonly archived: RecoverStoredPointer
      readonly missing: RecoverStoredPointer
    },
  ): Promise<AgentTeamManagerSessionResult | undefined> {
    if (this.isArchived(pointer.sessionId)) return recovery.archived()
    const workspace = await this.workspaceForExisting(pointer, inspection)
    if (workspace === undefined) {
      if (!await this.anyUsableWorkspace()) return Object.freeze({ status: 'no-workspace' })
      return this.unavailable(
        'workspace-unavailable',
        'the registered manager Session no longer has a matching usable Workspace',
        pointer.sessionId,
      )
    }
    try {
      await this.initializePrivateAssets()
    } catch (error) {
      return this.unavailable('runtime', `manager private assets could not be provisioned: ${messageOf(error)}`, pointer.sessionId)
    }

    let installed: ManagerGeneration
    try {
      installed = await this.activate({ persisted: true, sessionId: pointer.sessionId, workspace })
    } catch (error) {
      if (sessionFailureOf(error, pointer.sessionId)?.kind === 'missing') return recovery.missing()
      return this.activationFailure('session-resume', error, pointer.sessionId)
    }

    if (this.disposed) {
      await this.disposeCandidate(installed)
      return this.unavailable('runtime', 'Team manager runtime is disposed', pointer.sessionId)
    }
    try {
      await workspace.attachSession(pointer.sessionId)
    } catch (error) {
      await this.disposeCandidate(installed)
      return this.activationFailure('session-attach', error, pointer.sessionId)
    }
    if (this.disposed) {
      await this.disposeCandidate(installed)
      return this.unavailable('runtime', 'Team manager runtime is disposed', pointer.sessionId)
    }

    const previous = this.publish(installed)
    this.nameSession(installed.handle.agent)
    await this.disposeRetired(previous)
    return this.ready({ sessionId: pointer.sessionId, workspaceId: workspace.id })
  }

  /**
   * Create, attach, persist, and publish one successor. Nothing before the
   * pointer write is visible as the current manager; a failure there disposes
   * (and, for an unpublished fresh Session, best-effort archives) the
   * candidate while the old pointer and handle stay untouched.
   */
  private async replaceLocked(
    previousPointer: ManagerSessionPointer | undefined,
  ): Promise<AgentTeamManagerSessionResult> {
    let workspace: Workspace | undefined
    try {
      workspace = await this.workspaceForCreation()
    } catch (error) {
      return this.unavailable('workspace-unavailable', messageOf(error))
    }
    if (workspace === undefined) return Object.freeze({ status: 'no-workspace' })

    const sessionId = `agent-team-manager-${randomUUID()}` as SessionId
    let installed: ManagerGeneration
    try {
      await this.initializePrivateAssets()
      installed = await this.activate({ persisted: false, sessionId, workspace })
    } catch (error) {
      await this.archiveFailedFreshSession(sessionId)
      return this.activationFailure('session-create', error, sessionId)
    }

    try {
      if (this.isArchived(sessionId)) {
        throw new ManagerSetupError('the successor manager Session was archived before attach')
      }
      await workspace.attachSession(sessionId)
      if (this.isArchived(sessionId)) {
        throw new ManagerSetupError('the successor manager Session was archived before pointer persistence')
      }
    } catch (error) {
      await this.rollbackCandidate(installed, 'the successor manager Session could not be prepared')
      if (error instanceof ManagerSetupError) return this.unavailable('runtime', messageOf(error), sessionId)
      return this.activationFailure('session-attach', error, sessionId)
    }

    const nextPointer: ManagerSessionPointer = Object.freeze({
      sessionId,
      workspaceId: workspace.id,
      previousSessionIds: Object.freeze([
        ...previousPointer?.previousSessionIds ?? [],
        ...previousPointer === undefined ? [] : [previousPointer.sessionId],
      ]),
    })
    let persisted: boolean
    try {
      persisted = await this.deps.store.writeIfExpected(previousPointer?.sessionId, nextPointer)
    } catch (error) {
      await this.rollbackCandidate(installed, 'the manager pointer write failed')
      return this.unavailable('pointer-persist', messageOf(error), sessionId)
    }
    if (!persisted) {
      await this.rollbackCandidate(installed, 'the manager pointer changed before persistence')
      const current = this.readPointer()
      if (!current.ok) return current.result
      return current.pointer === undefined
        ? this.unavailable('pointer-persist', 'the manager pointer changed while persisting the successor', sessionId)
        : this.currentStatusLocked(current.pointer)
    }

    const previous = this.publish(installed)
    this.nameSession(installed.handle.agent)
    if (this.isArchived(sessionId)) {
      await this.disposeRetired(previous)
      return this.unavailable('runtime', 'the successor manager Session was archived after pointer persistence', sessionId)
    }
    await this.disposeRetired(previous)
    await this.archiveRetired(previous)
    return this.ready(nextPointer)
  }

  private async activate(input: {
    readonly persisted: boolean
    readonly sessionId: SessionId
    readonly workspace: Workspace
  }): Promise<ManagerGeneration> {
    let installedPolicy: ManagerToolPolicy | undefined
    const setup = async (agentCtx: Context, agent: Agent) => {
      try {
        await this.deps.ctx.agentPresets.mount(agentCtx, MANAGER_SESSION_PRESET_ID)
        if (!this.compositionIsManager(agent)) {
          throw new Error(`expected the isolated '${MANAGER_SESSION_PRESET_ID}' preset`)
        }
        installedPolicy = installManagerToolPolicy(agentCtx, agent, {
          ctx: this.deps.ctx,
          isCurrentAgent: subject => this.current?.handle.agent === subject,
          pointerSessionId: () => this.deps.store.read()?.sessionId,
          isArchived: sessionId => this.isArchived(sessionId),
        })
        installModelSelection(agentCtx)
      } catch (error) {
        throw new ManagerSetupError(messageOf(error), { cause: error })
      }
      return {
        commit: () => {
          const logged = agent.session.ownEvents().toReversed().find(event => event.type === 'sandbox/mode')
          if (logged?.data.mode !== 'danger-full-access') setSandboxMode(agent.session, 'danger-full-access')
        },
      }
    }

    let handle: AgentHandle
    try {
      handle = input.persisted
        ? await this.deps.ctx.agents.resume({
          resumeSessionId: input.sessionId,
          agentOptions: this.deps.defaultAgentOptions(),
          setup,
          signal: this.abort.signal,
        })
        : await this.deps.ctx.agents.create({
          sessionId: input.sessionId,
          meta: {
            // Creation and attach share this exact Workspace path.
            cwd: input.workspace.path,
            agentPreset: MANAGER_SESSION_PRESET_ID,
          },
          agentOptions: this.deps.defaultAgentOptions(),
          setup,
          signal: this.abort.signal,
        })
    } catch (error) {
      installedPolicy?.dispose()
      throw error
    }
    if (installedPolicy === undefined) {
      await handle.dispose()
      throw new ManagerSetupError('the manager tool policy was not installed')
    }
    try {
      const skills = mountMemberSkillProvider(handle.agent.ctx, this.deps.ctx.agentPresets, {
        skillsDirectory: join(this.deps.managerPrivateRoot, 'skills'),
        bundledSkillsDirectory: this.deps.managerBundledSkillsRoot,
        initialSelection: undefined,
      })
      return { handle, policy: installedPolicy, skills }
    } catch (error) {
      try {
        await handle.dispose()
        installedPolicy.dispose()
      } catch {
        // Leave the denying guard installed while the unpublished handle is
        // still live.
      }
      throw error
    }
  }

  private async workspaceForCreation(): Promise<Workspace | undefined> {
    let preferred: ManagerWorkspaceValue | undefined
    try {
      preferred = await this.deps.initializeDefaultWorkspace(this.abort.signal)
    } catch (error) {
      throw new Error(`default Workspace initialization failed: ${messageOf(error)}`, { cause: error })
    }
    const candidates: Array<{ readonly workspaceId: WorkspaceId }> = [
      ...(preferred === undefined ? [] : [{ workspaceId: preferred.workspaceId }]),
      ...this.deps.ctx.workspaceRegistry.list().map(workspace => ({ workspaceId: workspace.id })),
    ]
    const seen = new Set<WorkspaceId>()
    for (const candidate of candidates) {
      if (seen.has(candidate.workspaceId)) continue
      seen.add(candidate.workspaceId)
      const workspace = this.deps.ctx.workspaceRegistry.get(candidate.workspaceId)
      if (workspace === undefined) continue
      if (await workspace.status() !== 'ok') continue
      return workspace
    }
    return undefined
  }

  /** A resumed Session is attached to the Workspace whose path is exactly its stored cwd. */
  private async workspaceForExisting(
    pointer: ManagerSessionPointer,
    inspection: StoredSessionInspection,
  ): Promise<Workspace | undefined> {
    const cwd = inspection.header.cwd
    if (cwd === undefined) return undefined
    const list = this.deps.ctx.workspaceRegistry.list()
    const matching = list.find(workspace => workspace.path === cwd)
    if (matching !== undefined && await matching.status() === 'ok') return matching
    const recorded = this.deps.ctx.workspaceRegistry.get(pointer.workspaceId)
    if (recorded !== undefined && recorded.path === cwd && await recorded.status() === 'ok') return recorded
    return undefined
  }

  private async anyUsableWorkspace(): Promise<boolean> {
    for (const workspace of this.deps.ctx.workspaceRegistry.list()) {
      if (await workspace.status() === 'ok') return true
    }
    return false
  }

  private publish(installed: ManagerGeneration): ManagerGeneration | undefined {
    const previous = this.current
    // The old Agent loses authorization here, before its handle stops.
    this.current = installed
    return previous
  }

  /** Release a candidate that never became current; archive only an unpublished fresh Session. */
  private async rollbackCandidate(installed: ManagerGeneration, detail: string): Promise<void> {
    const sessionId = installed.handle.agent.id
    await this.disposeCandidate(installed)
    if (this.isArchived(sessionId)) return
    try {
      await this.deps.ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
    } catch (error) {
      this.warn(`${detail}; the unpublished candidate was not archived: ${messageOf(error)}`)
    }
  }

  /** Hide a failed never-published creation when its Session log actually landed. */
  private async archiveFailedFreshSession(sessionId: SessionId): Promise<void> {
    if (this.isArchived(sessionId)) return
    try {
      const stored = await this.deps.reader.read(sessionId)
      if (!stored.ok && stored.failure.kind === 'missing') return
      await this.deps.ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
    } catch (error) {
      this.warn(`failed manager Session creation could not be archived: ${messageOf(error)}`)
    }
  }

  private disposeCandidate(installed: ManagerGeneration): Promise<void> {
    return this.stopGeneration(installed, 'candidate manager Session disposal failed')
  }

  private disposeRetired(previous: ManagerGeneration | undefined): Promise<void> {
    return previous === undefined
      ? Promise.resolve()
      : this.stopGeneration(previous, 'retired manager Session disposal failed after the successor was current')
  }

  private async stopGeneration(generation: ManagerGeneration, warning: string): Promise<void> {
    try {
      // A handle that fails to stop still needs its guard to deny execution.
      await generation.handle.dispose()
      generation.policy.dispose()
      generation.skills?.dispose()
    } catch (error) {
      this.warn(`${warning}: ${messageOf(error)}`)
    }
  }

  /** Archive the replaced Session without deleting its log or rolling back the published successor. */
  private async archiveRetired(previous: ManagerGeneration | undefined): Promise<void> {
    if (previous === undefined) return
    const sessionId = previous.handle.agent.id
    if (this.isArchived(sessionId)) return
    try {
      await this.deps.ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
    } catch (error) {
      this.warn(`retired manager Session archival failed after the successor was current: ${messageOf(error)}`)
    }
  }

  private async initializePrivateAssets(): Promise<void> {
    const root = this.deps.managerPrivateRoot
    await mkdir(join(root, 'notes'), { recursive: true })
    await mkdir(join(root, 'skills'), { recursive: true })
    try {
      await writeFile(join(root, 'memory.md'), [
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
      ].join('\n'), { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  /** A default title is cosmetic: an explicit title always wins and failure never blocks activation. */
  private nameSession(agent: Agent): void {
    const sessionTitle = this.deps.ctx.get('sessionTitle')
    if (sessionTitle === undefined) return
    try {
      if (sessionTitle.get(agent.session) !== undefined) return
      sessionTitle.rename(agent.session, MANAGER_SESSION_TITLE)
    } catch {
      // The composition may carry no session-title service, or the rename races its disposal.
    }
  }

  private readPointer(): PointerRead {
    try {
      return { ok: true, pointer: this.deps.store.read() }
    } catch (error) {
      return { ok: false, result: this.unavailable('pointer-read', messageOf(error)) }
    }
  }

  private compositionIsManager(agent: Agent): boolean {
    try {
      return this.deps.ctx.agentPresets.composedPreset(agent.ctx) === MANAGER_SESSION_PRESET_ID
    } catch {
      return false
    }
  }

  private liveOutsideManager(sessionId: SessionId): boolean {
    const live = this.deps.ctx.agents.get(sessionId)
    return live !== undefined && live !== this.current?.handle.agent
  }

  private isArchived(sessionId: SessionId): boolean {
    return this.deps.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)
  }

  private readFailure(failure: StoredSessionFailure): AgentTeamManagerSessionResult {
    const diagnosticClass: AgentTeamManagerDiagnosticClass = failure.kind === 'refused'
      ? 'session-refused'
      : 'session-unreadable'
    return this.unavailable(
      diagnosticClass,
      failure.kind === 'refused' ? failure.detail : `${failure.kind}: ${failure.detail}`,
      failure.sessionId,
      failure.location,
    )
  }

  private activationFailure(
    fallback: AgentTeamManagerDiagnosticClass,
    error: unknown,
    sessionId: SessionId,
  ): AgentTeamManagerSessionResult {
    const stored = sessionFailureOf(error, sessionId)
    if (stored !== undefined) return this.readFailure(stored)
    const detail = messageOf(error)
    if (error instanceof ManagerSetupError) {
      const wrapped = error.cause ?? error
      const inner = sessionFailureOf(wrapped, sessionId)
      if (inner !== undefined) return this.readFailure(inner)
      if (detail.includes('Workspace') || detail.includes('workspace')) {
        return this.unavailable('workspace-unavailable', detail, sessionId)
      }
      return this.unavailable('preset-composition', detail, sessionId)
    }
    if (fallback === 'session-attach' || (detail.includes('workspace') && detail.includes('attach'))) {
      return this.unavailable('session-attach', detail, sessionId)
    }
    return this.unavailable(fallback, detail, sessionId)
  }

  private ready(input: ManagerSessionPointer): AgentTeamManagerSessionResult {
    return Object.freeze({ status: 'ready', sessionId: input.sessionId, workspaceId: input.workspaceId })
  }

  private unavailable(
    diagnosticClass: AgentTeamManagerDiagnosticClass,
    detail: string,
    sessionId?: SessionId,
    location?: AgentTeamManagerDiagnostic['location'],
  ): AgentTeamManagerSessionResult {
    return Object.freeze({
      status: 'unavailable',
      diagnostic: Object.freeze({
        class: diagnosticClass,
        detail,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(location === undefined ? {} : { location }),
        occurredAt: new Date().toISOString(),
      }),
    })
  }

  private warn(message: string): void {
    this.deps.ctx.logger.warn(`agent-team manager: ${message}`)
  }
}

class ManagerSetupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ManagerSetupError'
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
