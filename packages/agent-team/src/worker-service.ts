/**
 * Delegations the Host starts, tracks, and cancels: the Team side of one Worker run.
 *
 * Team owns authorization, the execution record, and the result destination; the
 * Harness subagent service owns admission, capacity, and the parent notice. A
 * bound run writes its binding to the ledger before any process exists and keeps
 * its answer private; an unbound run stays the direct parent result it was.
 * @module @contexera/dsh-agent-team/worker-service
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation, SubagentRuntime, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {
  AgentTeamMemberActor,
  AgentTeamMemberId,
  AgentTeamProjectRef,
  AgentTeamRequestId,
  AgentTeamTaskRef,
  AgentTeamThreadRef,
  AgentTeamWorkerRef,
  AgentTeamWorkerSettlement,
  AgentTeamWorkerStartRecord,
  AgentTeamWorkerStartWrite,
  AgentTeamWorkerSettleWrite,
} from './types.ts'
import { truncateToCharacters } from './text.ts'
import { DEFAULT_WORKER_SANDBOX, WORKER_DIAGNOSTIC_MAX_CHARACTERS, WORKER_ENGINES, WORKER_OUTPUT_MAX_CHARACTERS,
  type WorkerEngine } from './worker-settings.ts'
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
  /** The Thread the run reports into; absent on a Project-only delegation. */
  readonly threadRef?: AgentTeamThreadRef | undefined
  readonly taskRef?: AgentTeamTaskRef | undefined
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
  /** The Workspace the resolved target lives in; the ledger re-checks it on write. */
  readonly workspaceId: WorkspaceId
  /** Derived from the Thread or Task the delegation was bound to, never a caller's claim. */
  readonly projectRef: AgentTeamProjectRef
  readonly threadRef?: AgentTeamThreadRef | undefined
  readonly taskRef?: AgentTeamTaskRef | undefined
  readonly engine?: WorkerEngine | undefined
  readonly task: string
  /** Absolute working directory the Worker runs in; the caller's own directory when omitted. */
  readonly cwd?: string | undefined
}

/** What one delegation asks for before the Host resolves it: a target, and the task text. */
export interface WorkerDelegationRequest {
  readonly requestId: AgentTeamRequestId
  readonly projectRef?: AgentTeamProjectRef | undefined
  readonly threadRef?: AgentTeamThreadRef | undefined
  readonly taskRef?: AgentTeamTaskRef | undefined
  readonly engine?: WorkerEngine | undefined
  readonly task: string
  /** Absolute working directory the Worker runs in; the caller's own directory when omitted. */
  readonly cwd?: string | undefined
}

/** Who delegates and whose session would have received the result on an unbound run. */
export interface WorkerCaller {
  readonly actor: AgentTeamMemberActor
  readonly parent: Agent
}

export interface WorkerRegistryDeps {
  /** The settings as they stand when the delegation is requested. */
  readonly config: () => WorkerConfig
  /** Whether the named Project exists; the ledger re-checks it on write. */
  readonly projectExists: (projectRef: AgentTeamProjectRef) => boolean
  /** Resolve a Project's current Agent owners. */
  readonly projectOwners: (projectRef: AgentTeamProjectRef) => readonly string[]
  /**
   * Write a run's opening binding. It must be durable before any process
   * starts, and it resolves the record as the ledger holds it.
   */
  readonly recordStarted: (write: AgentTeamWorkerStartWrite) => Promise<AgentTeamWorkerStartRecord>
  /** Write a run's one terminal fact. */
  readonly recordSettled: (write: AgentTeamWorkerSettleWrite) => Promise<void>
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

/**
 * How long an unloading Host waits for an engine to report its ending before it
 * lets go. A run that outlasts it keeps its recorded start with no ending, which
 * the next read reports as unconfirmed rather than holding the Host open.
 */
const WORKER_SETTLE_DEADLINE_MS = 5_000

/** The text of an engine's final answer; any other content block is not an answer to carry. */
const answerTextOf = (output: readonly { readonly type: string; readonly text?: string | undefined }[]): string | undefined => {
  const text = output.filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text ?? '').join('\n').trim()
  return text === '' ? undefined : truncateToCharacters(text, WORKER_OUTPUT_MAX_CHARACTERS)
}

/** What one admitted request id asked for: enough to tell a resend from a second delegation. */
interface DelegationShape {
  readonly initiator: AgentTeamMemberId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly threadRef?: AgentTeamThreadRef | undefined
  readonly taskRef?: AgentTeamTaskRef | undefined
  readonly engine: WorkerEngine
  readonly task: string
  readonly cwd: string
}

const delegationOf = (caller: WorkerCaller, request: WorkerStartRequest,
  resolved: { readonly engine: WorkerEngine; readonly cwd: string }): DelegationShape => Object.freeze({
  initiator: caller.actor.memberId, workspaceId: request.workspaceId, projectRef: request.projectRef,
  ...(request.threadRef === undefined ? {} : { threadRef: request.threadRef }),
  ...(request.taskRef === undefined ? {} : { taskRef: request.taskRef }),
  engine: resolved.engine, task: request.task, cwd: resolved.cwd,
})

/**
 * Refuse a request id reused for a different delegation. A Worker run answers only
 * the request and the Member that started it, so an id never becomes a handle to
 * somebody else's execution, and a changed task under an old id is refused rather
 * than silently answered with the run that id already made.
 */
const assertSameDelegation = (admitted: DelegationShape, caller: WorkerCaller, request: WorkerStartRequest): void => {
  const engine = request.engine ?? admitted.engine
  if (admitted.initiator === caller.actor.memberId && admitted.workspaceId === request.workspaceId
    && admitted.projectRef === request.projectRef && admitted.threadRef === request.threadRef
    && admitted.taskRef === request.taskRef && admitted.task === request.task && engine === admitted.engine
    && (request.cwd === undefined || request.cwd === admitted.cwd)) return
  throw new WorkerRefusal('worker_request_conflict', `Request id '${request.requestId}' already opened a `
    + `${admitted.engine} run for another delegation; a Worker run answers only the request that started it, `
    + 'so delegate again with a new request id.')
}

interface RunEntry {
  run: AgentTeamWorkerRun
  /** The idempotency key of the run's one terminal write, distinct from the start's. */
  readonly settleRequestId: AgentTeamRequestId
  /** The delegation this run answers, as {@link assertSameDelegation} compares a resend against it. */
  readonly delegation: DelegationShape
  activation?: SubagentActivation | undefined
  settle?: Promise<void> | undefined
}

/** Executions this Host started, plus the request ids already admitted. */
export class WorkerRegistry {
  private readonly runs = new Map<AgentTeamWorkerRef, RunEntry>()
  private readonly byRequest = new Map<AgentTeamRequestId, AgentTeamWorkerRef>()
  /** The ref one request id started, held before the write so a retry opens that run, not a twin. */
  private readonly attempts = new Map<AgentTeamRequestId, AgentTeamWorkerRef>()
  /** The start each request id is opening right now, so a concurrent resend joins it. */
  private readonly starting = new Map<AgentTeamRequestId, { readonly delegation: DelegationShape
    readonly started: Promise<AgentTeamWorkerRun> }>()
  private readonly providers = new Map<WorkerEngine, () => void>()
  /** Terminal writes still in flight, so unloading the Host waits for them. */
  private readonly writes = new Set<Promise<void>>()
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

  /** Whether this Host still holds the run: `running` with no live entry here is a previous Host's. */
  isLive(workerRef: AgentTeamWorkerRef): boolean {
    return this.runs.get(workerRef)?.run.state === 'running'
  }

  /**
   * Start one delegation, or return the execution a resent request already made.
   * Every refusal precedes any write, and the opening record precedes the process.
   * A request id answers the Member and delegation that opened it, never another's.
   */
  async start(caller: WorkerCaller, request: WorkerStartRequest): Promise<AgentTeamWorkerRun> {
    // A resend that arrives while the first call is still opening joins that start:
    // one request id never opens two engines, not even concurrently.
    const opening = this.starting.get(request.requestId)
    if (opening !== undefined) {
      assertSameDelegation(opening.delegation, caller, request)
      return opening.started
    }
    const replayedRef = this.byRequest.get(request.requestId)
    const replayed = replayedRef === undefined ? undefined : this.runs.get(replayedRef)
    if (replayed !== undefined) {
      // A resend answers with the run this Host admitted, and only when it asks the
      // same thing of the same Member: a request id is an idempotency key, not a
      // handle one caller can use to collect another's execution.
      assertSameDelegation(replayed.delegation, caller, request)
      return replayed.run
    }
    const config = this.deps.config()
    if (this.stopped) throw new WorkerRefusal('worker_unavailable', 'The Team is unloading, so no Worker can start.')
    if (!config.enabled) throw new WorkerRefusal('worker_disabled', 'Worker delegation is switched off in the Team settings.')
    if (!this.deps.projectExists(request.projectRef)) throw new WorkerRefusal('worker_project_unknown', `${request.projectRef} is not a Project in this Team.`)
    if (!this.deps.projectOwners(request.projectRef).includes(caller.actor.memberId)) {
      throw new WorkerRefusal('worker_owner_required', `Only a current owner of ${request.projectRef} may delegate a Worker, so the target of this delegation belongs to no Project you own.`)
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

    const workerRef = this.attempts.get(request.requestId) ?? `worker:${randomUUID()}` as AgentTeamWorkerRef
    this.attempts.set(request.requestId, workerRef)
    const delegation = delegationOf(caller, request, { engine, cwd })
    const started = this.open(caller, request, { workerRef, engine, cwd, provider, subagents, delegation })
    // Registered before anything awaits, so the second of two concurrent calls finds
    // this start and joins it instead of writing a second opening and opening a
    // second engine under one request id.
    this.starting.set(request.requestId, { delegation, started })
    try {
      return await started
    } finally {
      this.starting.delete(request.requestId)
    }
  }

  /** Open one admitted run: the durable binding first, the engine process second. */
  private async open(caller: WorkerCaller, request: WorkerStartRequest, admitted: {
    readonly workerRef: AgentTeamWorkerRef
    readonly engine: WorkerEngine
    readonly cwd: string
    readonly provider: string
    readonly subagents: SubagentRuntime
    readonly delegation: DelegationShape
  }): Promise<AgentTeamWorkerRun> {
    const { workerRef, engine, cwd, provider, subagents } = admitted
    // Written before the process opens: a Host that dies here leaves a run the
    // Thread reports as unconfirmed, not one nobody can see.
    const started = await this.deps.recordStarted({
      requestId: request.requestId, actor: caller.actor, workspaceId: request.workspaceId,
      execution: Object.freeze({ workerRef, projectRef: request.projectRef,
        ...(request.threadRef === undefined ? {} : { threadRef: request.threadRef }),
        ...(request.taskRef === undefined ? {} : { taskRef: request.taskRef }),
        initiatedBy: caller.actor.memberId, engine, task: request.task, cwd, startedAt: nowIso() }),
    })
    const entry: RunEntry = {
      settleRequestId: `${request.requestId}:settled` as AgentTeamRequestId,
      delegation: admitted.delegation,
      run: Object.freeze({ workerRef, projectRef: started.projectRef, engine, state: 'running' as const,
        startedAt: started.startedAt, cwd: started.cwd,
        ...(started.threadRef === undefined ? {} : { threadRef: started.threadRef }),
        ...(started.taskRef === undefined ? {} : { taskRef: started.taskRef }) }),
    }
    this.runs.set(workerRef, entry)
    this.byRequest.set(request.requestId, workerRef)
    try {
      const activation = await subagents.startActivation({
        provider,
        label: `${engine} worker`,
        request: { parent: caller.parent, prompt: [{ type: 'text', text: request.task }], cwd },
        signal: new AbortController().signal,
        // A bound run's result belongs to its Thread and its initiator's Inbox,
        // so the parent Session must not also receive a full copy of it.
        delivery: entry.run.threadRef === undefined ? 'parent' : 'caller',
      })
      entry.activation = activation
      // An external child's id is the engine's own session identity, which is what
      // the record reports and a later read-only diagnostic reopens.
      const nativeSessionId = String(activation.childId)
      entry.settle = activation.result.then(
        (result) => {
          const completed = result.stopReason === 'completed'
          // What the engine said before it stopped is still the answer it produced:
          // a bound run suppresses the parent's copy, so dropping it would lose it.
          const output = answerTextOf(result.output)
          const diagnostic = !completed && typeof result.diagnostic === 'string' ? result.diagnostic : undefined
          return this.settle(entry, completed ? 'completed' : result.stopReason === 'aborted' ? 'stopped' : 'failed', {
            nativeSessionId,
            ...(diagnostic === undefined ? {} : { diagnostic }),
            ...(output === undefined ? {} : { output }),
          })
        },
        (error: unknown) => this.settle(entry, 'failed', {
          nativeSessionId,
          diagnostic: error instanceof WorkerFailure ? error.message : 'The Worker ended with an unreported failure.',
        }),
      )
      return this.require(workerRef)
    } catch (error: unknown) {
      const cancelled = error instanceof WorkerFailure && error.stage === 'startup' && error.category === 'cancelled'
      // The refusal reaches the caller only after the ending is durable, so the
      // Thread never shows a start that ended with nothing.
      await this.settle(entry, cancelled ? 'stopped' : 'failed',
        cancelled ? {} : { diagnostic: error instanceof Error ? error.message : 'The Worker could not start.' })
      throw error
    }
  }

  async stop(workerRef: AgentTeamWorkerRef): Promise<AgentTeamWorkerRun> {
    const entry = this.runs.get(workerRef)
    if (entry === undefined) throw new WorkerRefusal('worker_unknown', `No Worker '${workerRef}' was started by this Host.`)
    if (entry.run.state !== 'running') return entry.run
    await entry.activation?.dispose()
    await this.settledWithin(entry)
    return this.require(workerRef)
  }

  async dispose(): Promise<void> {
    this.stopped = true
    const live = [...this.runs.values()].filter(entry => entry.run.state === 'running')
    for (const entry of live) {
      await entry.activation?.dispose().catch(() => {})
      await this.settledWithin(entry)
    }
    await Promise.allSettled([...this.writes])
    for (const release of this.providers.values()) release()
    this.providers.clear()
  }

  /**
   * Record one run's ending: the live view first, so the run stops reading as
   * live immediately, then the durable fact. A failed write leaves the record
   * `running`, which is exactly what a later read reports as unconfirmed.
   */
  private settle(entry: RunEntry, state: Exclude<AgentTeamWorkerRun['state'], 'running' | 'unconfirmed'>, facts: {
    readonly nativeSessionId?: string | undefined
    readonly output?: string | undefined
    readonly diagnostic?: string | undefined
  }): Promise<void> | undefined {
    if (entry.run.state !== 'running') return undefined
    const settledAt = nowIso()
    // The record's own ceilings are what the schema admits; a failure summary the
    // provider did not bound is cut here rather than refused on write.
    const diagnostic = facts.diagnostic === undefined
      ? undefined : truncateToCharacters(facts.diagnostic, WORKER_DIAGNOSTIC_MAX_CHARACTERS)
    entry.run = Object.freeze({
      ...entry.run, state, settledAt,
      ...facts.nativeSessionId === undefined ? {} : { nativeSessionId: facts.nativeSessionId },
      ...diagnostic === undefined ? {} : { diagnostic },
    })
    const settlement: AgentTeamWorkerSettlement = Object.freeze({ workerRef: entry.run.workerRef, state, settledAt,
      ...(facts.nativeSessionId === undefined ? {} : { nativeSessionId: facts.nativeSessionId }),
      ...(facts.output === undefined ? {} : { output: facts.output }),
      ...(diagnostic === undefined ? {} : { diagnostic }) })
    const write = this.deps.recordSettled({ requestId: entry.settleRequestId, settlement }).catch((error: unknown) => {
      this.deps.warn(`worker (${entry.run.engine}) ${entry.run.workerRef} ended without a recorded result: `
        + `${error instanceof Error ? error.message : String(error)}; the Thread reports it as unconfirmed`)
    })
    this.writes.add(write)
    void write.finally(() => { this.writes.delete(write) })
    return write
  }

  /** Wait for one run's ending, but never hold the Host open on an engine that will not end. */
  private async settledWithin(entry: RunEntry): Promise<void> {
    const pending = entry.settle
    if (pending === undefined) return
    await Promise.race([pending.catch(() => {}), new Promise<void>(resolve => {
      const timer = setTimeout(resolve, WORKER_SETTLE_DEADLINE_MS)
      timer.unref?.()
    })])
    if (entry.run.state === 'running') {
      this.deps.warn(`worker (${entry.run.engine}) ${entry.run.workerRef} reported no ending within `
        + `${WORKER_SETTLE_DEADLINE_MS}ms of the Host releasing it; its Thread will report the result as unconfirmed`)
    }
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
