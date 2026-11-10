/**
 * Delegations the Host starts, tracks, and stops: the Team side of one Worker run.
 *
 * Team owns authorization, the execution record, the result destination, and the
 * stop transaction; the Harness subagent service owns admission, capacity, the
 * parent notice, and the engine handle. A bound run writes its binding to the
 * ledger before any process exists and keeps its answer private; an unbound run
 * stays the direct parent result it was. One run has exactly one terminal fact,
 * and a stop only writes it after the engine confirmed its cleanup.
 * @module @contexera/dsh-agent-team/worker-service
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation, SubagentRuntime, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {
  AgentTeamActor,
  AgentTeamMemberActor,
  AgentTeamMemberId,
  AgentTeamProjectRef,
  AgentTeamRequestId,
  AgentTeamTaskRef,
  AgentTeamThreadRef,
  AgentTeamWorkerRef,
  AgentTeamWorkerSettlement,
  AgentTeamWorkerStage,
  AgentTeamWorkerStartRecord,
  AgentTeamWorkerStartWrite,
  AgentTeamWorkerSteerResult,
  AgentTeamWorkerSettleWrite,
} from './types.ts'
import { truncateToCharacters } from './text.ts'
import { DEFAULT_WORKER_SANDBOX, WORKER_DIAGNOSTIC_MAX_CHARACTERS, WORKER_ENGINES, WORKER_OUTPUT_MAX_CHARACTERS,
  WORKER_TASK_PREVIEW_MAX_CHARACTERS, type WorkerEngine } from './worker-settings.ts'
import {
  TeamWorkerProvider,
  WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC,
  WORKER_PROVIDER_NAMES,
  WorkerFailure,
  workerAnchorsOf,
  type WorkerRunSpec,
  type WorkerSteer,
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
  /** The Member whose delegation opened this run: the only Member who may stop it. */
  readonly initiatedBy: AgentTeamMemberId
}

/**
 * Whether this Host still holds a run, and whether a stop has been asked for
 * but not confirmed. Derived from the live registry, never stored.
 */
export type WorkerLiveState = 'running' | 'stopping'

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

/** How long an engine's own refusal sentence may be before this Team reports its own. */
const WORKER_STEER_REASON_MAX_CHARACTERS = 300

/**
 * One engine refusal, bounded. The sentence is the engine's own words about a
 * control it declined — never a native record — and a report may not carry an
 * unbounded value into the Thread.
 */
function boundedSteerReason(reason: string): string {
  const text = reason.trim()
  return text === '' ? 'the engine gave no reason' : truncateToCharacters(text, WORKER_STEER_REASON_MAX_CHARACTERS)
}

/**
 * How long an unloading Host waits for an engine to report its ending before it
 * lets go. A run that outlasts it keeps its recorded start with no ending, which
 * the next read reports as unconfirmed rather than holding the Host open — and
 * the run is sealed so a late ending is never written after storage closes.
 */
const WORKER_SETTLE_DEADLINE_MS = 5_000

/** How long one stop request waits for cleanup before it reports that the run is still stopping. */
const WORKER_STOP_DEADLINE_MS = 10_000

/** Resolve to `undefined` when `promise` has not settled within `ms`; the timer never holds the process open. */
const within = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => Promise.race([
  promise,
  new Promise<undefined>(resolve => {
    const timer = setTimeout(() => { resolve(undefined) }, ms)
    timer.unref?.()
  }),
])

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
  /** Cancels the startup window; aborted by a stop request or by the Host releasing the run. */
  readonly startup: AbortController
  /** Resolves once the run's one terminal write settled, failed, or the Host sealed the run. */
  readonly terminated: PromiseWithResolvers<void>
  /** A stop has been asked for and no terminal fact has landed yet. */
  stopping: boolean
  /** The terminal write, so a confirmed stop also proves its fact is durable. */
  record?: Promise<void> | undefined
  /** The cleanup a stop asked for; its rejection is the evidence the stop is unconfirmed. */
  stopDisposal?: Promise<void> | undefined
  /** One stop transaction per run, joined by repeated requests. */
  stop?: Promise<void> | undefined
  /** The engine session this run opened, once the activation published one. */
  sessionId?: SessionId | undefined
  /**
   * Instructions this run already took, by request id, so a resend answers with the
   * first one's receipt instead of entering the turn twice.
   */
  readonly steers: Map<AgentTeamRequestId, { readonly instruction: string
    readonly outcome: Promise<AgentTeamWorkerSteerResult> }>
  activation?: SubagentActivation | undefined
  /** After the Host released a run it could not clean up, a late ending must not reach closed storage. */
  sealed: boolean
  /** The engine did not confirm the cleanup a stop asked for: the one ending is `failed`, never `stopped`. */
  cleanupUnconfirmed: boolean
}

/** Whether this Host still holds the entry: a sealed run was released without a confirmed ending. */
function held(entry: RunEntry): boolean {
  return !entry.sealed
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
  private readonly providers = new Map<WorkerEngine, { readonly release: () => void
    readonly provider: TeamWorkerProvider }>()
  /**
   * The same-turn control of every session this Host still holds, by the engine's
   * own session id. This is live state, not a record: an entry exists only while
   * its session does, it is removed when that run ends, and unloading clears what
   * is left. Nothing outside this registry can reach an engine session.
   */
  private readonly sessions = new Map<SessionId, WorkerSteer | undefined>()
  /** Terminal writes still in flight, so unloading the Host waits for them. */
  private readonly writes = new Set<Promise<void>>()
  private stopped = false

  constructor(
    private readonly ctx: Context,
    private readonly deps: WorkerRegistryDeps,
  ) {}

  list(): readonly AgentTeamWorkerRun[] {
    return [...this.runs.values()].filter(held).map(entry => entry.run)
  }

  /** Every run one Member started, in start order: the Member's own stop surface. */
  runsOf(memberId: AgentTeamMemberId): readonly AgentTeamWorkerRun[] {
    return [...this.runs.values()].filter(held).filter(entry => entry.run.initiatedBy === memberId).map(entry => entry.run)
  }

  get(workerRef: AgentTeamWorkerRef): AgentTeamWorkerRun | undefined {
    const entry = this.runs.get(workerRef)
    return entry === undefined || !held(entry) ? undefined : entry.run
  }

  /** Whether this Host still holds the run: `running` with no live entry here is a previous Host's. */
  isLive(workerRef: AgentTeamWorkerRef): boolean {
    const entry = this.runs.get(workerRef)
    return entry !== undefined && held(entry) && entry.run.state === 'running'
  }

  /** How a run this Host holds stands right now, or `undefined` when it holds no live execution. */
  liveState(workerRef: AgentTeamWorkerRef): WorkerLiveState | undefined {
    const entry = this.runs.get(workerRef)
    if (entry === undefined || !held(entry) || entry.run.state !== 'running') return undefined
    return entry.stopping ? 'stopping' : 'running'
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
    readonly provider: TeamWorkerProvider
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
      startup: new AbortController(),
      terminated: Promise.withResolvers<void>(),
      stopping: false,
      sealed: false,
      cleanupUnconfirmed: false,
      steers: new Map(),
      run: Object.freeze({ workerRef, projectRef: started.projectRef, engine, state: 'running' as const,
        startedAt: started.startedAt, cwd: started.cwd, initiatedBy: started.initiatedBy,
        ...(started.threadRef === undefined ? {} : { threadRef: started.threadRef }),
        ...(started.taskRef === undefined ? {} : { taskRef: started.taskRef }) }),
    }
    this.runs.set(workerRef, entry)
    this.byRequest.set(request.requestId, workerRef)
    if (this.stopped) {
      // The Host began unloading while this run was writing its opening record:
      // no engine opens, and the record stays running for a later read to report
      // as unconfirmed instead of receiving an ending after storage closes.
      this.seal(entry)
      throw new WorkerRefusal('worker_unavailable', 'The Team released this Worker before it opened its engine.')
    }
    try {
      const activation = await subagents.startActivation({
        provider: provider.name,
        label: `${engine} worker`,
        request: { parent: caller.parent, prompt: [{ type: 'text', text: request.task }], cwd },
        // A stop asked for during startup cancels through this signal; once the
        // activation is published, its own disposal is the channel.
        signal: entry.startup.signal,
        // A bound run's result belongs to its Thread and its initiator's Inbox,
        // so the parent Session must not also receive a full copy of it.
        delivery: entry.run.threadRef === undefined ? 'parent' : 'caller',
      })
      if (entry.sealed) {
        // The Host released this run before its engine opened: clean the late
        // handle up and never let it publish a start the Host no longer holds.
        void activation.dispose().catch(() => {})
        throw new WorkerRefusal('worker_unavailable', 'The Team released this Worker while it was still starting.')
      }
      entry.activation = activation
      // The engine's own session id is what its live control is keyed by; a run
      // whose activation never published one has nothing to steer.
      entry.sessionId = activation.childId
      if (entry.stopping) {
        const disposal = activation.dispose()
        entry.stopDisposal ??= disposal
        void disposal.catch(() => {})
      }
      // An external child's id is the engine's own session identity, which is what
      // the record reports and a later read-only diagnostic reopens.
      const nativeSessionId = String(activation.childId)
      void activation.result.then(
        (result) => this.finish(entry, result, nativeSessionId),
        (error: unknown) => this.finish(entry, { output: [], stopReason: 'error',
          diagnostic: error instanceof WorkerFailure ? error.message : 'The Worker ended with an unreported failure.' }, nativeSessionId),
      )
      return this.require(workerRef)
    } catch (error: unknown) {
      await this.finishFromStartFailure(entry, error)
      // A start cancelled by its own stop answers with the run it recorded
      // instead of an error: the caller asked for this ending and needs the ref.
      if (entry.stopping && entry.run.state !== 'running') return entry.run
      throw error
    }
  }

  /**
   * Stop one execution this Host holds. Only the Member who delegated it and the
   * Human may ask; the settings switch and current ownership are start conditions
   * and are deliberately not re-checked here. A run that already ended answers
   * with its real terminal state instead of stopping it twice.
   */
  async stop(workerRef: AgentTeamWorkerRef, stopper: AgentTeamActor): Promise<AgentTeamWorkerRun> {
    const entry = this.runs.get(workerRef)
    if (entry === undefined) throw new WorkerRefusal('worker_unknown', `No Worker '${workerRef}' was started by this Host.`)
    this.assertMayStop(entry, stopper)
    if (entry.run.state !== 'running') return entry.run
    const transaction = entry.stop ??= this.stopRun(entry)
    // The transaction outlives this wait: a caller that gave up must not cancel
    // the cleanup the engine is already carrying out.
    const done = await within(transaction.then(() => true), WORKER_STOP_DEADLINE_MS)
    if (done === undefined || entry.run.state === 'running') {
      throw new WorkerRefusal('worker_stop_pending', `Worker '${workerRef}' was asked to stop, but the engine has not confirmed `
        + `its cleanup within ${WORKER_STOP_DEADLINE_MS}ms; it is still stopping. Check the engine's process before starting another task.`)
    }
    if (entry.cleanupUnconfirmed) {
      throw new WorkerRefusal('worker_stop_unconfirmed', `Worker '${workerRef}' was asked to stop, but the engine did not `
        + 'confirm its cleanup, so it cannot be confirmed stopped. Check the engine\'s process before starting another task.')
    }
    try {
      await entry.record
    } catch {
      throw new WorkerRefusal('worker_stop_unrecorded', `Worker '${workerRef}' stopped, but its ending could not be recorded; `
        + 'the Thread reports the result as unconfirmed.')
    }
    return entry.run
  }

  /**
   * Add one instruction to the turn a run is already executing. Only the Member
   * who delegated the run may ask; nothing here opens a turn, queues an input, or
   * reaches another run. A run that ended, is stopping, or has not opened its
   * engine session answers with that state instead of sending anything, and a
   * resent request id answers with the receipt the first call produced.
   */
  async steer(workerRef: AgentTeamWorkerRef, steerer: AgentTeamActor,
    request: { readonly requestId: AgentTeamRequestId; readonly instruction: string }): Promise<AgentTeamWorkerSteerResult> {
    const entry = this.runs.get(workerRef)
    if (entry === undefined) throw new WorkerRefusal('worker_unknown', `No Worker '${workerRef}' was started by this Host.`)
    this.assertMaySteer(entry, steerer)
    const instruction = request.instruction.trim()
    if (instruction === '') throw new WorkerRefusal('worker_steer_required', 'A steer needs the instruction the Worker should take on.')
    // The idempotency answer comes before the state checks: a resend answers with
    // the receipt the first call produced whether the run is still going or has
    // ended, and a changed instruction under that id is refused either way. Only a
    // request this run has never seen can reach the engine.
    const admitted = entry.steers.get(request.requestId)
    if (admitted !== undefined) {
      if (admitted.instruction !== instruction) {
        throw new WorkerRefusal('worker_steer_conflict', `Request id '${request.requestId}' already carried another instruction `
          + 'to this Worker; send a changed instruction under a new request id.')
      }
      return admitted.outcome
    }
    // The same sentence is one instruction: a retry that arrives under a fresh
    // request id must not enter the live turn a second time.
    for (const previous of entry.steers.values()) {
      if (previous.instruction === instruction) return previous.outcome
    }
    if (entry.run.state !== 'running') {
      throw new WorkerRefusal('worker_steer_ended', `Worker '${workerRef}' already ended: ${entry.run.state}; there is no turn to add to.`)
    }
    if (entry.stopping) {
      throw new WorkerRefusal('worker_steer_stopping', `Worker '${workerRef}' is stopping, so nothing was sent: a turn that is ending `
        + 'will not carry another instruction.')
    }
    const outcome = this.steerRun(entry, instruction, request.requestId)
    entry.steers.set(request.requestId, { instruction, outcome })
    return outcome
  }

  /**
   * The one steer transaction: ask the control this Host holds for that session,
   * then report what the engine took over and how the run stood at that moment.
   */
  private async steerRun(entry: RunEntry, instruction: string, requestId: AgentTeamRequestId): Promise<AgentTeamWorkerSteerResult> {
    const { workerRef, engine } = entry.run
    const sessionId = entry.sessionId
    // This version opens same-turn steering for Codex only: its control carries
    // the turn the engine is driving, which is what makes the receipt's turn id
    // and the "current turn" claim checkable. Claude's control accepts while the
    // turn is still open, and its input can still be scheduled as the next turn,
    // so that path waits for its own ticket rather than borrowing this guarantee.
    if (engine !== 'codex') {
      throw new WorkerRefusal('worker_steer_unsupported', `Worker '${workerRef}' runs on an engine whose same-turn control `
        + 'this Team does not open yet, so no instruction was sent.')
    }
    if (sessionId === undefined) {
      throw new WorkerRefusal('worker_steer_not_ready', `Worker '${workerRef}' has not opened its engine session yet, so it has no `
        + 'turn to add to; try again once it is running.')
    }
    if (!this.sessions.has(sessionId)) {
      throw new WorkerRefusal('worker_steer_no_active_turn', `Worker '${workerRef}' holds no live engine session any more, so there is `
        + 'no turn to add to.')
    }
    const steer = this.sessions.get(sessionId)
    if (steer === undefined) {
      throw new WorkerRefusal('worker_steer_unsupported', `Worker '${workerRef}' runs on an engine session that exposes no same-turn `
        + 'control, so this Team cannot add an instruction to it.')
    }
    const outcome = await steer(instruction, requestId)
    if (outcome.kind === 'unavailable') {
      throw new WorkerRefusal('worker_steer_refused', `Worker '${workerRef}' did not take the instruction over (${outcome.code}): `
        + boundedSteerReason(outcome.reason))
    }
    return Object.freeze({ workerRef, engine, state: 'submitted' as const,
      ...(outcome.turnId === undefined ? {} : { turnId: outcome.turnId }),
      runState: this.liveState(workerRef) ?? entry.run.state })
  }

  /** Refuse a steer by anyone but the Member who delegated the run. */
  private assertMaySteer(entry: RunEntry, steerer: AgentTeamActor): void {
    if (steerer.kind === 'member' && steerer.memberId === entry.run.initiatedBy) return
    throw new WorkerRefusal('worker_steer_forbidden', `Only the Member who delegated Worker '${entry.run.workerRef}' may add an `
      + 'instruction to it.')
  }

  /**
   * Release the Team: refuse new starts, cancel every start still opening, stop
   * the runs this provider holds, wait for their endings, then release the
   * providers. A run that cannot confirm its ending within the deadline stays
   * `running` — which a later read reports as unconfirmed — and is sealed so no
   * late ending is written after the Host closes its storage.
   */
  async dispose(): Promise<void> {
    this.stopped = true
    // A start still writing its opening record is not in `runs` yet, so the
    // request is made twice: once now, and once after those writes land.
    this.requestStops()
    // Let starts that are already opening reach their own rollback first: a late
    // handle must be disposed while the providers are still registered.
    const opening = [...this.starting.values()].map(start => start.started)
    await within(Promise.allSettled(opening), WORKER_SETTLE_DEADLINE_MS)
    this.requestStops()
    // A start that lands after this snapshot is sealed by `open` itself: it opens
    // no engine, so it needs no disposal here.
    const held = [...this.runs.values()]
    for (const entry of held) {
      if (entry.run.state !== 'running' || entry.sealed) continue
      const activation = entry.activation
      if (activation !== undefined) {
        const disposal = activation.dispose()
        entry.stopDisposal ??= disposal
        void disposal.catch(() => {})
      }
      const ended = await within(entry.terminated.promise.then(() => true), WORKER_SETTLE_DEADLINE_MS)
      if (ended === undefined && entry.run.state === 'running') this.seal(entry)
    }
    await Promise.allSettled(this.writes)
    for (const { release } of this.providers.values()) release()
    this.providers.clear()
    // Nothing this Host held can be steered after it releases its runs.
    this.sessions.clear()
  }

  /** Ask every run this Host still holds to stop; a sealed run already has its one ending decided. */
  private requestStops(): void {
    for (const entry of this.runs.values()) {
      if (entry.run.state !== 'running' || entry.sealed) continue
      entry.stopping = true
      entry.startup.abort()
    }
  }

  /** Refuse a stop by anyone but the Member who delegated the run and the Human. */
  private assertMayStop(entry: RunEntry, stopper: AgentTeamActor): void {
    if (stopper.kind === 'human') return
    if (stopper.kind === 'member' && stopper.memberId === entry.run.initiatedBy) return
    throw new WorkerRefusal('worker_stop_forbidden', `Only the Member who delegated Worker '${entry.run.workerRef}' `
      + 'or the Human may stop it.')
  }

  /**
   * The one stop transaction: cancel a startup that has not published, dispose a
   * published activation, and wait for the settlement its own evidence decides.
   */
  private async stopRun(entry: RunEntry): Promise<void> {
    entry.stopping = true
    // Before publication the request signal is the only cancellation channel.
    entry.startup.abort()
    const activation = entry.activation
    if (activation !== undefined) {
      const disposal = activation.dispose()
      entry.stopDisposal ??= disposal
      // The result handler awaits this same promise for its verdict; a natural
      // ending that landed first does not need to surface it a second time.
      void disposal.catch(() => {})
    }
    await entry.terminated.promise
  }

  /** Seal a run the Host released without an ending: its start stays, and no later write may claim one. */
  private seal(entry: RunEntry): void {
    if (entry.sealed) return
    entry.sealed = true
    this.deps.warn(`worker (${entry.run.engine}) ${entry.run.workerRef} was released without a confirmed ending; `
      + 'it stays unconfirmed and no late ending will be written after the Host closed its storage')
    entry.terminated.resolve()
  }

  /**
   * Decide one run's ending from the engine's own result. A stop that the engine
   * did not confirm is not reported as stopped: an aborted result whose disposal
   * rejected is the existing `failed` state with a reason that says what is
   * unknown, and a natural completion or failure that landed first keeps its
   * real state.
   */
  private async finish(entry: RunEntry, result: { readonly output: readonly { readonly type: string; readonly text?: string | undefined }[]
    readonly stopReason: SubagentStopReason; readonly diagnostic?: string | undefined }, nativeSessionId: string): Promise<void> {
    if (entry.sealed) {
      entry.terminated.resolve()
      return
    }
    const output = answerTextOf(result.output)
    let state: 'completed' | 'failed' | 'stopped' = result.stopReason === 'completed'
      ? 'completed' : result.stopReason === 'aborted' ? 'stopped' : 'failed'
    let diagnostic = result.stopReason === 'completed' || typeof result.diagnostic !== 'string' ? undefined : result.diagnostic
    // The engine opened a session here, so a failure is either the turn itself or
    // the cleanup that followed it — never a start that never happened.
    let stage: AgentTeamWorkerStage | undefined = state === 'failed'
      ? diagnostic === WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC ? 'dispose' : 'turn'
      : undefined
    if (diagnostic === WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC) entry.cleanupUnconfirmed = true
    if (state === 'stopped' && entry.stopping && await this.disposalFailed(entry)) {
      state = 'failed'
      stage = 'dispose'
      entry.cleanupUnconfirmed = true
      diagnostic = 'The stop was requested, but the engine did not confirm its cleanup, so the run cannot be '
        + 'confirmed stopped. Check the engine\'s process before starting another task.'
        + (diagnostic === undefined ? '' : ` (${diagnostic})`)
    }
    // The run's own anchors ride its ending: what a later read-only look-up needs
    // to find the engine's record, and where that record failed if it did. They
    // came back on the result object itself, so a run whose ending never reaches
    // this write leaves nothing behind to collect.
    const anchors = workerAnchorsOf(result)
    await this.settle(entry, state, {
      nativeSessionId,
      ...(anchors?.nativeTurnId === undefined ? {} : { nativeTurnId: anchors.nativeTurnId }),
      ...(anchors?.nativeStorage === undefined ? {} : { nativeStorage: anchors.nativeStorage }),
      ...(stage === undefined ? {} : { stage }),
      ...(output === undefined ? {} : { output }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    })?.catch(() => {})
  }

  /** Decide the ending of a run whose engine never published: a cancelled start is a stop, everything else its real failure. */
  private async finishFromStartFailure(entry: RunEntry, error: unknown): Promise<void> {
    if (entry.sealed) {
      entry.terminated.resolve()
      return
    }
    const cancelled = error instanceof WorkerFailure && error.stage === 'startup' && error.category === 'cancelled'
    const aborted = error instanceof Error && error.name === 'AbortError'
    const diagnostic = error instanceof Error ? error.message : 'The Worker could not start.'
    if (cancelled) {
      await this.settle(entry, 'stopped', {})?.catch(() => {})
      return
    }
    // The manager can reject with the abort reason after rolling back a start it
    // owns; the engine may have opened, so a stop is not confirmed from that alone.
    const uncertain = entry.stopping && aborted
    // The ending carries no native identity — a start that failed this way is
    // never handed one — so it names the stage it came apart in. A read can then
    // say the record holds no native session instead of guessing one back out of
    // the sentence, and it never claims the engine opened nothing.
    await this.settle(entry, 'failed', {
      ...(error instanceof WorkerFailure ? { stage: error.stage } : {}),
      diagnostic: uncertain
        ? `${diagnostic} The stop was requested while the Worker was starting, but the Host could not confirm `
          + 'the engine stopped. Check the engine\'s process before starting another task.'
        : diagnostic,
    })?.catch(() => {})
  }

  /** Whether the cleanup a stop asked for ended in a rejection: the one piece of evidence that a stop is unconfirmed. */
  private async disposalFailed(entry: RunEntry): Promise<boolean> {
    const disposal = entry.stopDisposal
    if (disposal === undefined) return false
    try {
      await disposal
      return false
    } catch {
      return true
    }
  }

  /**
   * Record one run's ending: the live view first, so the run stops reading as
   * live immediately, then the durable fact. A failed write leaves the record
   * `running`, which is exactly what a later read reports as unconfirmed.
   */
  private settle(entry: RunEntry, state: Exclude<AgentTeamWorkerRun['state'], 'running' | 'unconfirmed'>, facts: {
    readonly nativeSessionId?: string | undefined
    readonly nativeTurnId?: string | undefined
    readonly nativeStorage?: string | undefined
    readonly stage?: AgentTeamWorkerStage | undefined
    readonly output?: string | undefined
    readonly diagnostic?: string | undefined
  }): Promise<void> | undefined {
    if (entry.sealed) {
      entry.terminated.resolve()
      return undefined
    }
    if (entry.run.state !== 'running') return undefined
    const settledAt = nowIso()
    // The record's own ceilings are what the schema admits; a failure summary the
    // provider did not bound is cut here rather than refused on write.
    const diagnostic = facts.diagnostic === undefined
      ? undefined : truncateToCharacters(facts.diagnostic, WORKER_DIAGNOSTIC_MAX_CHARACTERS)
    const anchors = {
      ...facts.nativeSessionId === undefined ? {} : { nativeSessionId: facts.nativeSessionId },
      ...facts.nativeTurnId === undefined ? {} : { nativeTurnId: facts.nativeTurnId },
      ...facts.nativeStorage === undefined ? {} : { nativeStorage: facts.nativeStorage },
      ...facts.stage === undefined ? {} : { stage: facts.stage },
    }
    entry.run = Object.freeze({
      ...entry.run, state, settledAt, ...anchors,
      ...diagnostic === undefined ? {} : { diagnostic },
    })
    const settlement: AgentTeamWorkerSettlement = Object.freeze({ workerRef: entry.run.workerRef, state, settledAt, ...anchors,
      ...(facts.output === undefined ? {} : { output: facts.output }),
      ...(diagnostic === undefined ? {} : { diagnostic }) })
    const write = this.deps.recordSettled({ requestId: entry.settleRequestId, settlement })
    entry.record = write
    const guarded = write.catch((error: unknown) => {
      this.deps.warn(`worker (${entry.run.engine}) ${entry.run.workerRef} ended without a recorded result: `
        + `${error instanceof Error ? error.message : String(error)}; the Thread reports it as unconfirmed`)
    })
    this.writes.add(guarded)
    void guarded.finally(() => {
      this.writes.delete(guarded)
      entry.terminated.resolve()
    })
    return write
  }

  private require(workerRef: AgentTeamWorkerRef): AgentTeamWorkerRun {
    const entry = this.runs.get(workerRef)
    if (entry === undefined) throw new WorkerRefusal('worker_unknown', `No Worker '${workerRef}' was started by this Host.`)
    return entry.run
  }

  private subagents(): SubagentRuntime | undefined {
    return this.ctx.get('subagents') as SubagentRuntime | undefined
  }

  private providerFor(engine: WorkerEngine, subagents: SubagentRuntime): TeamWorkerProvider {
    const existing = this.providers.get(engine)
    if (existing !== undefined) return existing.provider
    // The row is read when a session opens, not when the provider registers: a
    // saved executable, engine switch, or policy must reach the next delegation.
    const provider = new TeamWorkerProvider(WORKER_PROVIDER_NAMES[engine],
      () => workerRunSpec(engine, this.deps.config(), this.deps.warn), {
        opened: (sessionId, steer) => { this.sessions.set(sessionId, steer) },
        closed: (sessionId) => { this.sessions.delete(sessionId) },
      })
    const release = subagents.registerProvider(provider)
    this.providers.set(engine, { release, provider })
    return provider
  }
}

/**
 * The most runs one Member's surface lists. The record keeps every run; the list
 * is a window, so a Member with months of delegations still gets one bounded
 * read. Five is what a reader scans without scrolling the dialog, and the ledger
 * still holds every record. A live run takes a seat in the window rather than
 * being added on top of it, and is never dropped for an ended one — it is the
 * only row that can still be stopped — so more than five live runs make the list
 * longer than the window.
 */
export const WORKER_RUN_LIST_LIMIT = 5

/**
 * The window of one Member's ended runs the Human's list shows: the newest
 * endings, not the newest starts. A run that began early and failed only now is
 * exactly the record the Human is looking for, so it must outrank a short run
 * that started later and ended long before it.
 */
export function newestEndedRuns<T extends { readonly startedAt: string; readonly settledAt?: string | undefined }>(
  executions: readonly T[], limit: number,
): readonly T[] {
  return Object.freeze([...executions]
    .sort((left, right) => endingAt(right) - endingAt(left))
    .slice(0, limit))
}

/** When a run ended. A settled record always carries it; the start is only a fallback for one that does not. */
function endingAt(execution: { readonly startedAt: string; readonly settledAt?: string | undefined }): number {
  return Date.parse(execution.settledAt ?? execution.startedAt)
}

/** A single-line, bounded preview of a run's task for the Human's run list; the record keeps the full text. */
export function workerTaskPreview(task: string): string {
  return truncateToCharacters(task.replaceAll(/\s+/gu, ' ').trim(), WORKER_TASK_PREVIEW_MAX_CHARACTERS)
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
