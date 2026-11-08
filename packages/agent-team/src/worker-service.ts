/**
 * Delegations the Host starts, tracks, and cancels: the Team side of one Worker run.
 *
 * Team owns authorization, the execution record, and the result destination; the
 * Harness subagent service owns admission, capacity, and the parent notice.
 * @module @contexera/dsh-agent-team/worker-service
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation, SubagentRuntime, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { AgentTeamProjectRef, AgentTeamRequestId, AgentTeamWorkerRef } from './types.ts'
import { DEFAULT_WORKER_SANDBOX, WORKER_ENGINES, type WorkerEngine } from './worker-settings.ts'
import {
  TeamWorkerProvider,
  WORKER_PROVIDER_NAMES,
  WorkerFailure,
  type WorkerRunSpec,
} from './worker-runtime.ts'

export interface WorkerEngineConfig {
  readonly enabled: boolean
  /** Absolute executable path; empty keeps the engine's own discovery. */
  readonly executable: string
  /** Codex sandbox policy; the engine's own default is never inherited silently. */
  readonly sandbox: string
}

export interface WorkerConfig {
  readonly enabled: boolean
  readonly defaultEngine: WorkerEngine
  readonly engines: Readonly<Record<WorkerEngine, WorkerEngineConfig>>
  /** Turn deadline in milliseconds; 0 means no deadline. */
  readonly timeoutMs: number
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = Object.freeze({
  enabled: false,
  defaultEngine: 'codex',
  engines: Object.freeze({
    codex: Object.freeze({ enabled: false, executable: '', sandbox: DEFAULT_WORKER_SANDBOX }),
    claude: Object.freeze({ enabled: false, executable: '', sandbox: '' }),
  }),
  timeoutMs: 0,
})

export interface AgentTeamWorkerRun {
  readonly workerRef: AgentTeamWorkerRef
  readonly projectRef: AgentTeamProjectRef
  readonly engine: WorkerEngine
  readonly state: 'running' | 'completed' | 'failed' | 'stopped' | 'unconfirmed'
  readonly startedAt: string
  readonly settledAt?: string | undefined
  /** The engine's own session identity, once one opened. */
  readonly nativeSessionId?: string | undefined
  readonly cwd: string
  /** A safe summary of a failure, never the native cause. */
  readonly diagnostic?: string | undefined
}

export interface WorkerStartRequest {
  readonly requestId: AgentTeamRequestId
  readonly projectRef: AgentTeamProjectRef
  readonly engine?: WorkerEngine | undefined
  readonly task: string
  /** Absolute working directory the Worker runs in; the caller's own directory when omitted. */
  readonly cwd?: string | undefined
}

export interface WorkerRegistryDeps {
  /** The settings as they stand when the delegation is requested. */
  readonly config: () => WorkerConfig
  /** Whether the named Project exists. */
  readonly projectExists: (projectRef: AgentTeamProjectRef) => boolean
  /** Resolve a Project's current Agent owners. */
  readonly projectOwners: (projectRef: AgentTeamProjectRef) => readonly string[]
  /** Log one safe line; the native cause never reaches it. */
  readonly warn: (message: string) => void
}

export class WorkerRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'WorkerRefusal'
  }
}

const nowIso = (): string => new Date().toISOString()

/** Executions this Host started, plus the request ids already admitted. */
export class WorkerRegistry {
  private readonly runs = new Map<AgentTeamWorkerRef, { run: AgentTeamWorkerRun; activation?: SubagentActivation | undefined; settle?: Promise<void> | undefined }>()
  private readonly byRequest = new Map<AgentTeamRequestId, AgentTeamWorkerRef>()
  private readonly providers = new Map<WorkerEngine, () => void>()
  private stopped = false

  constructor(
    private readonly ctx: Context,
    private readonly deps: WorkerRegistryDeps,
  ) {}

  list(): readonly AgentTeamWorkerRun[] {
    return [...this.runs.values()].map(entry => entry.run)
  }

  get(workerRef: AgentTeamWorkerRef): AgentTeamWorkerRun | undefined {
    return this.runs.get(workerRef)?.run
  }

  /**
   * Start one delegation, or return the execution a resent request already made.
   * Every refusal happens before a native process exists.
   * @param callerMemberId - the Member id the authorization was checked for.
   * @param parent - the live Agent whose session receives the completion notice.
   * @param request - project, engine, task text, and working directory.
   * @returns the execution as it stands now.
   */
  async start(callerMemberId: string, parent: Agent, request: WorkerStartRequest): Promise<AgentTeamWorkerRun> {
    const replayed = this.byRequest.get(request.requestId)
    if (replayed !== undefined) return this.require(replayed)
    const config = this.deps.config()
    if (this.stopped) throw new WorkerRefusal('worker_unavailable', 'The Team is unloading, so no Worker can start.')
    if (!config.enabled) throw new WorkerRefusal('worker_disabled', 'Worker delegation is switched off in the Team settings.')
    if (!this.deps.projectExists(request.projectRef)) throw new WorkerRefusal('worker_project_unknown', `${request.projectRef} is not a Project in this Team.`)
    if (!this.deps.projectOwners(request.projectRef).includes(callerMemberId)) {
      throw new WorkerRefusal('worker_owner_required', `Only a current owner of ${request.projectRef} may delegate a Worker.`)
    }
    const engine = request.engine ?? config.defaultEngine
    if (!WORKER_ENGINES.includes(engine)) throw new WorkerRefusal('worker_engine_unknown', `'${engine}' is not a Worker engine; use one of ${WORKER_ENGINES.join(', ')}.`)
    const engineConfig = config.engines[engine]
    if (!engineConfig.enabled) throw new WorkerRefusal('worker_engine_disabled', `Engine '${engine}' is not enabled in the Team settings.`)
    if (request.task.trim() === '') throw new WorkerRefusal('worker_task_required', 'A delegation needs the task text the Worker should carry out.')
    const cwd = request.cwd
    if (cwd === undefined || !isAbsolute(cwd)) throw new WorkerRefusal('worker_cwd_required', 'A delegation needs an absolute working directory; this Session has none to inherit.')
    const subagents = this.subagents()
    if (subagents === undefined) throw new WorkerRefusal('worker_unavailable', 'The Harness subagent service is not mounted, so no Worker can start.')
    const provider = this.providerFor(engine, subagents)

    const workerRef = `worker:${randomUUID()}` as AgentTeamWorkerRef
    const startedAt = nowIso()
    const record: AgentTeamWorkerRun = {
      workerRef, projectRef: request.projectRef, engine, state: 'running', startedAt, cwd,
    }
    const entry: { run: AgentTeamWorkerRun; activation?: SubagentActivation | undefined; settle?: Promise<void> | undefined } = { run: record }
    this.runs.set(workerRef, entry)
    this.byRequest.set(request.requestId, workerRef)
    try {
      const activation = await subagents.startActivation({
        provider,
        label: `${engine} worker`,
        request: { parent, prompt: [{ type: 'text', text: request.task }], cwd },
        signal: new AbortController().signal,
        delivery: 'parent',
      })
      entry.activation = activation
      // An external child's id is the engine's own session identity, which is what
      // the record reports and a later read-only diagnostic reopens.
      const nativeSessionId = String(activation.childId)
      entry.settle = activation.result.then(
        (result) => {
          this.settle(workerRef, result.stopReason === 'completed' ? 'completed' : result.stopReason === 'aborted' ? 'stopped' : 'failed', {
            nativeSessionId,
            ...result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic },
          })
        },
        (error: unknown) => {
          this.settle(workerRef, 'failed', {
            nativeSessionId,
            diagnostic: error instanceof WorkerFailure ? error.message : 'The Worker ended with an unreported failure.',
          })
        },
      )
      return this.require(workerRef)
    } catch (error: unknown) {
      this.byRequest.delete(request.requestId)
      if (error instanceof WorkerFailure && error.stage === 'startup' && error.category === 'cancelled') {
        this.settle(workerRef, 'stopped', {})
      } else {
        this.settle(workerRef, 'failed', { diagnostic: error instanceof Error ? error.message : 'The Worker could not start.' })
      }
      throw error
    }
  }

  async stop(workerRef: AgentTeamWorkerRef): Promise<AgentTeamWorkerRun> {
    const entry = this.runs.get(workerRef)
    if (entry === undefined) throw new WorkerRefusal('worker_unknown', `No Worker '${workerRef}' was started by this Host.`)
    if (entry.run.state !== 'running') return entry.run
    await entry.activation?.dispose()
    await entry.settle
    return this.require(workerRef)
  }

  async dispose(): Promise<void> {
    this.stopped = true
    const live = [...this.runs.values()].filter(entry => entry.run.state === 'running')
    for (const entry of live) {
      await entry.activation?.dispose().catch(() => {})
      await entry.settle?.catch(() => {})
    }
    for (const release of this.providers.values()) release()
    this.providers.clear()
  }

  private settle(workerRef: AgentTeamWorkerRef, state: AgentTeamWorkerRun['state'], facts: { nativeSessionId?: string | undefined; diagnostic?: string | undefined }): void {
    const entry = this.runs.get(workerRef)
    if (entry === undefined || entry.run.state !== 'running') return
    entry.run = Object.freeze({
      ...entry.run, state, settledAt: nowIso(),
      ...facts.nativeSessionId === undefined ? {} : { nativeSessionId: facts.nativeSessionId },
      ...facts.diagnostic === undefined ? {} : { diagnostic: facts.diagnostic },
    })
  }

  private require(workerRef: AgentTeamWorkerRef): AgentTeamWorkerRun {
    const entry = this.runs.get(workerRef)
    if (entry === undefined) throw new WorkerRefusal('worker_unknown', `No Worker '${workerRef}' was started by this Host.`)
    return entry.run
  }

  private subagents(): SubagentRuntime | undefined {
    return this.ctx.get('subagents') as SubagentRuntime | undefined
  }

  private providerFor(engine: WorkerEngine, subagents: SubagentRuntime): string {
    const name = WORKER_PROVIDER_NAMES[engine]
    if (!this.providers.has(engine)) {
      // The row is read when a session opens, not when the provider registers: a
      // saved executable, engine switch, or policy must reach the next delegation.
      const provider = new TeamWorkerProvider(name, () => workerRunSpec(engine, this.deps.config(), this.deps.warn))
      const release = subagents.registerProvider(provider)
      this.providers.set(engine, release)
    }
    return name
  }
}

/** The run one delegation starts on an engine, read from the row as it stands at that open. */
export function workerRunSpec(engine: WorkerEngine, config: WorkerConfig, warn: (message: string) => void): WorkerRunSpec {
  return {
    engine,
    env: workerEnvironment(engine, config.engines[engine]),
    launchArgs: [],
    ...config.timeoutMs > 0 ? { timeoutMs: config.timeoutMs } : {},
    onError: (error: Error, stopReason: SubagentStopReason) => { warn(`worker (${engine}) ${stopReason}: ${error.message}`) },
  }
}

/** What the Worker's launch carries: the executable OAR resolves the installation by, and the Codex policy the runtime provider applies at open. */
export function workerEnvironment(engine: WorkerEngine, config: WorkerEngineConfig): Readonly<Record<string, string | null>> {
  const env: Record<string, string | null> = {}
  if (config.executable.trim() !== '') env[engine === 'codex' ? 'OAR_CODEX_BIN' : 'OAR_CLAUDE_BIN'] = config.executable.trim()
  if (engine === 'codex' && config.sandbox.trim() !== '') env.OAR_CODEX_SANDBOX = config.sandbox.trim()
  return Object.freeze(env)
}
