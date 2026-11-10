/**
 * The Team-owned Worker provider: one OAR-backed external execution per delegation.
 *
 * The sequence follows the Harness OAR provider; Team owns its copy because a
 * Worker must expose its native identity, which a one-shot contract does not.
 * @module @contexera/dsh-agent-team/worker-runtime
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  FailureClass,
  FrameBody,
  InstallationSnapshot,
  RejectionCode,
  Runtime,
  Session,
  TurnOutcome,
} from '@botiverse/oar'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  assertUsableCwd,
  settleRunResult,
  subprocessRunHandle,
  type ResolvedSubagentStartRequest,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'

import type { AgentTeamWorkerStage } from './types/entities.ts'
import type { WorkerEngine } from './worker-settings.ts'

/** The registry name each engine's provider registers under. */
export const WORKER_PROVIDER_NAMES: Readonly<Record<WorkerEngine, string>> = Object.freeze({
  codex: 'team-worker-codex',
  claude: 'team-worker-claude',
})

/** The stages a Worker run can come apart in; the ledger records the same vocabulary. */
type FailureStage = AgentTeamWorkerStage
type FailureCategory = FailureClass | RejectionCode | 'not-found' | 'unsupported' | 'cancelled' | 'timeout'

const failureAdvice: Readonly<Record<FailureStage, string>> = {
  'engine-unavailable': 'The OAR library is not installed, so no Worker can start.',
  installation: 'Install and authenticate the selected engine before retrying.',
  startup: 'Check the engine installation, authentication, and launch settings.',
  turn: 'Check the selected engine and its account before retrying.',
  abort: 'The engine did not accept interruption; session disposal was requested.',
  dispose: 'The engine may still be active; check it before starting another task.',
}

export class WorkerFailure extends Error {
  constructor(readonly stage: FailureStage, readonly category: FailureCategory, options?: ErrorOptions) {
    super(`Team Worker failure (stage: ${stage}; category: ${category}). ${failureAdvice[stage]}`, options)
    this.name = 'WorkerFailure'
  }
}

/**
 * What the engine itself said about one run's own record, captured while the
 * session is still open: the identity a later read-only look-up needs, and
 * nothing else. The native record is never copied into the Team's ledger — the
 * settlement write carries these three facts and the record stays where the
 * engine put it.
 */
export interface WorkerAnchors {
  /** The engine's own session identity. */
  readonly nativeSessionId: string
  /** The engine's own identity for the turn this run drove. */
  readonly nativeTurnId?: string | undefined
  /** The absolute path of the engine's own record: reported by Codex, derived from the cwd Claude reported and the environment the run opened with. */
  readonly nativeStorage?: string | undefined
}

/**
 * The Team-private key the anchors ride on, so they travel with the one object
 * the Harness hands back instead of through a process-local map: a map would leak
 * an entry for every run whose ending never reaches the write (a sealed run, a
 * late result) and would need taking before anyone could read it. A symbol keeps
 * the property out of every ordinary view of the result — it is not enumerable
 * JSON, not a field a notice reads, and not something another provider can set by
 * accident.
 */
const WORKER_ANCHORS = Symbol('@contexera/dsh-agent-team/worker-anchors')

/** The anchors one run carried on its own result, validated so a foreign object cannot shape them. */
export function workerAnchorsOf(result: object): WorkerAnchors | undefined {
  const carried = (result as { readonly [WORKER_ANCHORS]?: unknown })[WORKER_ANCHORS]
  if (carried === null || typeof carried !== 'object') return undefined
  const anchors = carried as Partial<WorkerAnchors>
  if (typeof anchors.nativeSessionId !== 'string' || anchors.nativeSessionId === '') return undefined
  return Object.freeze({ nativeSessionId: anchors.nativeSessionId,
    ...(typeof anchors.nativeTurnId === 'string' && anchors.nativeTurnId !== '' ? { nativeTurnId: anchors.nativeTurnId } : {}),
    ...(typeof anchors.nativeStorage === 'string' && anchors.nativeStorage !== '' ? { nativeStorage: anchors.nativeStorage } : {}) })
}

/**
 * Attach what the engine said about its own record to the result it produced.
 * Capturing is a diagnostic aid: a runtime that cannot answer costs the look-up
 * and never the run's own outcome, so every failure here returns the result
 * exactly as the engine settled it.
 */
function carryWorkerAnchors(outcome: SubagentResult, anchors: WorkerAnchors | undefined): SubagentResult {
  if (anchors === undefined) return outcome
  try {
    const carried: SubagentResult & { readonly [WORKER_ANCHORS]?: WorkerAnchors } = { ...outcome }
    // A spread keeps every field the Harness settled with; the symbol key is
    // invisible to JSON, `Object.keys`, and any notice that reads the result.
    Object.defineProperty(carried, WORKER_ANCHORS, { value: anchors, enumerable: false })
    return carried
  } catch {
    return outcome
  }
}

/**
 * What one same-turn instruction came to. `submitted` is OAR's own deliberately
 * weak promise: the engine took the input over for the turn it is running, which
 * is not a claim that the model read it, that it landed before the turn ended, or
 * that any outcome followed. `unavailable` carries why nothing was taken over.
 */
export type WorkerSteerOutcome =
  | { readonly kind: 'submitted'; readonly turnId?: string | undefined }
  | { readonly kind: 'unavailable'; readonly code: RejectionCode | 'error'; readonly reason: string }

/** How long a native turn id may be before this Team refuses to carry it. */
const WORKER_TURN_ID_MAX_CHARACTERS = 256

/**
 * The turn the engine said it steered into, taken from its own acknowledgement.
 * An id this Team will not carry is dropped rather than shortened: a cut id names
 * a turn that does not exist.
 */
function steeredTurnId(native: unknown): string | undefined {
  if (native === null || typeof native !== 'object') return undefined
  const turnId = (native as { readonly turnId?: unknown }).turnId
  return typeof turnId === 'string' && turnId !== '' && turnId.length <= WORKER_TURN_ID_MAX_CHARACTERS ? turnId : undefined
}

/** One run's live control: add an instruction to the turn its engine is already running. */
export type WorkerSteer = (instruction: string, inputId: string) => Promise<WorkerSteerOutcome>

/** What a live session offers the Host: a steer channel, or a stated reason there is none. */
export type WorkerSteerChannel =
  | { readonly kind: 'session'; readonly steer: WorkerSteer }
  | { readonly kind: 'unsupported' }

/**
 * The Team-private key one run's steer channel rides on, for the same reason the
 * anchors do: the channel belongs to the run, so it travels on the object that
 * run published instead of through a map keyed by a session that outlives it.
 */
const WORKER_STEER = Symbol('@contexera/dsh-agent-team/worker-steer')

/** One run's steer channel, or nothing when the engine exposes no same-turn control. */
export function workerSteerOf(run: object): WorkerSteer | undefined {
  const carried = (run as { readonly [WORKER_STEER]?: unknown })[WORKER_STEER]
  return typeof carried === 'function' ? carried as WorkerSteer : undefined
}

/**
 * The native record's own path, taken from the frame in which the engine
 * reported it. Codex states it on `thread/start` and repeats it on
 * `thread/started`; a runtime that names no path yields none, and the look-up
 * then says so instead of guessing a location.
 */
function nativeThreadPath(body: FrameBody): string | undefined {
  if (body.type !== 'thread/start' && body.type !== 'thread/started') return undefined
  const native = body.native
  if (native === null || typeof native !== 'object') return undefined
  const thread = (native as { readonly thread?: unknown }).thread
  if (thread === null || typeof thread !== 'object') return undefined
  const path = (thread as { readonly path?: unknown }).path
  return typeof path === 'string' && path !== '' ? path : undefined
}

/**
 * The working directory the released Claude Code CLI reports for the session it
 * opened. It is the directory the CLI named the session's project by, which is
 * what its record path is derived from; a session that has not reported one yet
 * falls back to the directory the run was opened in.
 */
function nativeClaudeCwd(body: FrameBody): string | undefined {
  if (body.type !== 'system/init') return undefined
  const native = body.native
  if (native === null || typeof native !== 'object') return undefined
  const cwd = (native as { readonly cwd?: unknown }).cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * The environment the engine's child process actually receives: OAR starts it
 * from the Host's own environment with the row's overlay applied, where a null
 * removes a name. Claude derives its record directory from `CLAUDE_CONFIG_DIR`
 * and `HOME`, so the anchors have to read the same values the child did — the
 * Host's own `process.env` is only one half of that.
 */
function effectiveEnvironment(env: Readonly<Record<string, string | null>>): Readonly<Record<string, string | undefined>> {
  const merged: Record<string, string | undefined> = { ...process.env }
  for (const [name, value] of Object.entries(env)) {
    if (value === null) delete merged[name]
    else merged[name] = value
  }
  return merged
}

/** The spelling Node selects for one environment name, which Windows makes case-insensitive. */
function environmentValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  if (process.platform !== 'win32') return env[name]
  const key = Object.keys(env).filter(entry => entry.toUpperCase() === name).sort()[0]
  return key === undefined ? undefined : env[key]
}

/**
 * Where the released Claude Code CLI keeps one session's own record. The CLI
 * names the project directory after its working directory (every character
 * outside `[A-Za-z0-9]` becomes `-`) and the file after the session id, under
 * `CLAUDE_CONFIG_DIR` or `$HOME/.claude`. The path is derived, not reported: the
 * CLI's stream carries no record location, so the derivation reads the same
 * environment the child was opened with. A wrong guess reads nothing and the
 * look-up says the record is missing rather than searching for another file.
 */
function claudeRecordPath(cwd: string, sessionId: string,
  env: Readonly<Record<string, string | undefined>>): string {
  const home = environmentValue(env, process.platform === 'win32' ? 'USERPROFILE' : 'HOME')
  const configured = environmentValue(env, 'CLAUDE_CONFIG_DIR')
  const config = configured === undefined || configured.trim() === ''
    ? join(home === undefined || home === '' ? homedir() : resolve(cwd, home), '.claude')
    : resolve(cwd, configured)
  return join(config, 'projects', cwd.replaceAll(/[^A-Za-z0-9]/gu, '-'), `${sessionId}.jsonl`)
}

/**
 * Read one open session's anchors off its own record stream, bound to the input
 * this run submitted. Codex's turn is the one span the root agent's records after
 * that input carry: a session that also holds another root turn cannot be tied to
 * this run, so it reports no turn id rather than the last one it saw — a guessed
 * turn would send a later look-up to another run's failure. Claude has no turn
 * object: its record names the turn by the prompting user message, which OAR
 * writes with the input id this run generated, so that id is the turn anchor.
 */
function anchorsOf(session: Session, inputSeq: number | undefined, engine: WorkerEngine,
  cwd: string, inputId: string | undefined, env: Readonly<Record<string, string | undefined>>): WorkerAnchors {
  let nativeStorage: string | undefined
  let reportedCwd: string | undefined
  const turns = new Set<string>()
  for (const record of session.records()) {
    if (record.sessionId !== session.id || record.agentPath.length !== 0) continue
    if (record.kind === 'frame') {
      if (engine === 'codex') nativeStorage ??= nativeThreadPath(record.body)
      else reportedCwd ??= nativeClaudeCwd(record.body)
    }
    if (inputSeq === undefined || record.seq <= inputSeq) continue
    if (record.spanId !== undefined && record.spanId !== '') turns.add(record.spanId)
  }
  if (engine === 'claude') nativeStorage = claudeRecordPath(reportedCwd ?? cwd, session.id, env)
  const turn = engine === 'claude'
    ? (inputSeq === undefined ? undefined : inputId)
    : turns.size === 1 ? [...turns][0] : undefined
  return Object.freeze({ nativeSessionId: session.id,
    ...(turn === undefined ? {} : { nativeTurnId: turn }),
    ...(nativeStorage === undefined ? {} : { nativeStorage }) })
}

/**
 * The one diagnostic a Worker hands the Harness when the engine could not
 * confirm its own disposal. The Harness waits for teardown but keeps the result
 * it captured for the parent, so this text has to ride that result: Team reads
 * it back to report the stop as unconfirmed instead of as stopped.
 */
export const WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC = new WorkerFailure('dispose', 'unknown').message

export interface WorkerRunSpec {
  readonly engine: WorkerEngine
  /** Native model id; omitted to keep the engine's own setting. */
  readonly model?: string | undefined
  /** Explicit environment, applied after the shared credential scrub. */
  readonly env: Readonly<Record<string, string | null>>
  /** Native process arguments; OAR validates the ones it owns. */
  readonly launchArgs: readonly string[]
  /** Optional turn deadline in milliseconds; OAR starts counting once the session opens. */
  readonly timeoutMs?: number | undefined
  /** Safe summaries only; native causes can carry credentials. */
  readonly onError?: ((error: Error, stopReason: SubagentStopReason) => void) | undefined
}

/**
 * OAR is loaded on demand: the Host boots, and every ordinary Session works,
 * without the library or the Node version it requires.
 */
let observeModule: typeof import('@botiverse/oar/observe') | undefined

async function awaitTurnEndOf(): Promise<typeof import('@botiverse/oar/observe').awaitTurnEnd> {
  observeModule ??= await import('@botiverse/oar/observe')
  return observeModule.awaitTurnEnd
}

export async function engineRuntime(engine: WorkerEngine): Promise<Runtime> {
  let oar: typeof import('@botiverse/oar')
  try {
    oar = await import('@botiverse/oar')
  } catch (error: unknown) {
    throw new WorkerFailure('engine-unavailable', 'unsupported', { cause: error })
  }
  return engine === 'codex' ? oar.codexRuntime : oar.claudeRuntime
}

/** The task text, refused before a native session exists when it is not plain text. */
export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) throw new Error('team-worker: the task must not be empty')
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') throw new Error('team-worker: the task must contain only text')
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) throw new Error('team-worker: the task must not be empty')
  return texts.join('')
}

function cancellationFailure(): WorkerFailure {
  return new WorkerFailure('startup', 'cancelled')
}

function completedTurn(outcome: TurnOutcome, output: readonly ContentBlock[]): SubagentResult {
  switch (outcome.kind) {
    case 'completed': return { output, stopReason: 'completed' }
    case 'aborted': return { output, stopReason: 'aborted' }
    case 'failed': return { output, stopReason: 'error', diagnostic: new WorkerFailure('turn', outcome.failure).message }
  }
}

async function disposeSession(session: Session, spec: WorkerRunSpec): Promise<void> {
  try {
    await session.dispose()
  } catch (error: unknown) {
    const failure = new WorkerFailure('dispose', 'unknown', { cause: error })
    spec.onError?.(failure, 'error')
    throw failure
  }
}

function publishRun(session: Session, prompt: string, request: ResolvedSubagentStartRequest, spec: WorkerRunSpec,
  cwd: string): SubagentRun {
  const stopped = Promise.withResolvers<SubagentResult>()
  const messages = new Map<string, string>()
  let streamedText = ''
  let phase: 'running' | 'cancelled' | 'timeout' | 'settled' = 'running'
  let disposal: Promise<void> | undefined
  // The anchors this run owns, captured while its session is still open: an
  // engine closes its record stream as it tears down, so a capture taken after
  // the abort or the cleanup would find nothing left to read.
  let inputSeq: number | undefined
  let promptInputId: string | undefined
  let anchors: WorkerAnchors | undefined
  // The environment this run's engine was opened with, read once: the anchors
  // derive Claude's record directory from it after the session is gone.
  const childEnv = effectiveEnvironment(spec.env)
  const captureAnchors = (): void => {
    if (anchors !== undefined) return
    try {
      anchors = anchorsOf(session, inputSeq, spec.engine, cwd, promptInputId, childEnv)
    } catch {
      // A session that cannot answer costs the look-up, never the run's ending.
    }
  }

  const collectOutput = (): readonly ContentBlock[] => {
    let answer = streamedText
    for (const text of messages.values()) {
      if (text.length > 0) answer = text
    }
    return answer.length === 0 ? [] : [{ type: 'text', text: answer }]
  }
  const dispose = (): Promise<void> => disposal ??= disposeSession(session, spec)
  const interrupt = (reason: 'cancelled' | 'timeout'): void => {
    if (phase !== 'running') return
    // Before the abort and the disposal below: this is the last moment the
    // engine's own record stream is still there to answer.
    captureAnchors()
    phase = reason
    stopped.resolve({
      output: collectOutput(),
      stopReason: reason === 'cancelled' ? 'aborted' : 'error',
      ...reason === 'timeout' ? { diagnostic: 'The Worker exceeded its execution timeout.' } : {},
    })
    void session.abort().catch(() => {})
    void dispose().catch(() => {})
  }
  const onAbort = (): void => { interrupt('cancelled') }
  /**
   * The run's live same-turn control. It never opens a turn, never queues, and
   * never reaches another session: the engine's own `steer` addresses the turn it
   * is running right now, and a session that exposes none says so instead of
   * falling back to a queue. A refusal keeps the engine's own code so the Host can
   * tell "nothing is running" from "the engine would not take it".
   */
  const steer: WorkerSteer = async (instruction, inputId) => {
    if (phase !== 'running') return { kind: 'unavailable', code: 'no_active_turn', reason: 'the run is no longer running' }
    const control = session.steer
    if (control === undefined) return { kind: 'unavailable', code: 'unsupported', reason: 'this engine session exposes no same-turn control' }
    try {
      const answer = await control.call(session, instruction, { inputId })
      if (answer.kind === 'accepted') {
        const turnId = steeredTurnId(answer.response.body.kind === 'accepted' ? answer.response.body.native : undefined)
        return { kind: 'submitted', ...(turnId === undefined ? {} : { turnId }) }
      }
      return { kind: 'unavailable', code: answer.code, reason: answer.reason }
    } catch (error: unknown) {
      return { kind: 'unavailable', code: 'error', reason: error instanceof Error ? error.message : String(error) }
    }
  }
  const unsubscribe = session.events((event) => {
    if (event.sessionId !== session.id || event.agentPath.length !== 0 || event.kind !== 'text_delta') return
    streamedText += event.text
    if (event.messageId !== undefined) messages.set(event.messageId, (messages.get(event.messageId) ?? '') + event.text)
  }, { cursor: { sessionId: session.id, afterSeq: -1 } })
  request.signal.addEventListener('abort', onAbort, { once: true })
  if (request.signal.aborted) onAbort()
  const timer = spec.timeoutMs === undefined ? undefined : setTimeout(() => { interrupt('timeout') }, spec.timeoutMs)
  const runTurn = async (): Promise<SubagentResult> => {
    promptInputId = randomUUID()
    const admitted = await session.prompt(prompt, { inputId: promptInputId })
    if (admitted.kind === 'rejected') {
      return { output: collectOutput(), stopReason: 'error', diagnostic: new WorkerFailure('turn', admitted.code).message }
    }
    // The turn this run drives is the one after its own input, so the capture
    // reads the record from here on and never another root turn's span.
    inputSeq = admitted.seq
    const awaitTurnEnd = await awaitTurnEndOf()
    const outcome = await awaitTurnEnd(session, admitted.seq, promptInputId)
    // A native handled receipt is not a turn end: keep waiting for the turn it belongs to.
    const turn = completedTurn(outcome.kind === 'handled' ? await awaitTurnEnd(session, outcome.seq) : outcome, collectOutput())
    captureAnchors()
    return turn
  }
  const settled = settleRunResult({
    attempt: async () => {
      if (phase !== 'running') return stopped.promise
      try {
        return await Promise.race([runTurn(), stopped.promise])
      } catch (error: unknown) {
        throw new WorkerFailure('turn', 'unknown', { cause: error })
      }
    },
    collectOutput,
    collectDiagnostic: () => new WorkerFailure('turn', 'unknown').message,
    cancelled: () => phase === 'cancelled',
    ...spec.onError === undefined ? {} : { onError: spec.onError },
    signal: request.signal,
    onAbort,
  }).finally(() => {
    clearTimeout(timer)
    unsubscribe()
    if (phase === 'running') phase = 'settled'
    // Every settlement path passes here, and it is still before the Harness's
    // teardown: a turn whose own wait threw, a prompt the engine refused, and a
    // transport that failed all keep the native identities the session could
    // still name. The cancel path captured earlier, and this is idempotent.
    captureAnchors()
  })
  // The Harness hands the parent the result it captured here, and a teardown
  // failure never edits it. So a cancelled run settles only after disposal had
  // its say: a failed cleanup rides this one result, keeping the output so far.
  const result = settled.then(async (outcome) => {
    if (outcome.stopReason !== 'aborted') return outcome
    try {
      await dispose()
      return outcome
    } catch {
      return { output: outcome.output, stopReason: 'error' as const, diagnostic: WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC }
    }
  })
  const handle = subprocessRunHandle({
    // The external child's id is the engine's own session identity: the execution
    // record reports it, and a later read-only diagnostic can reopen that history.
    id: SessionId(session.id),
    // The snapshot this run took while its session was open rides the result the
    // Harness hands back to the Host; nothing is read after teardown.
    result: result.then(outcome => carryWorkerAnchors(outcome, anchors)),
    signal: request.signal,
    onAbort,
    requestCancel: onAbort,
    teardown: async () => {
      await dispose()
      await settled
    },
  })
  // The control belongs to this run and dies with it: the provider offers it only
  // while the session is open, and the symbol keeps it off every ordinary view of
  // the handle.
  Object.defineProperty(handle, WORKER_STEER, { value: steer, enumerable: false })
  return handle
}

/**
 * OAR 0.95.1 reads Codex's permission mode from the Host's own
 * `OAR_CODEX_SANDBOX` when a session opens — `SessionOptions.env` only reaches
 * the child process — and the pinned library exposes no per-session channel. So
 * the row's policy rides the open call and is restored before the run goes on,
 * which bounds the one window in which another Codex open could see it.
 * @param env - the Worker's launch environment, which names the policy.
 * @param open - the runtime's session open, run while the policy is in place.
 * @returns whatever the open resolves to.
 */
export async function withCodexSandbox<T>(env: Readonly<Record<string, string | null>>, open: () => Promise<T>): Promise<T> {
  const sandbox = env.OAR_CODEX_SANDBOX
  if (typeof sandbox !== 'string' || sandbox === '') return open()
  const previous = process.env.OAR_CODEX_SANDBOX
  process.env.OAR_CODEX_SANDBOX = sandbox
  try {
    return await open()
  } finally {
    if (previous === undefined) delete process.env.OAR_CODEX_SANDBOX
    else process.env.OAR_CODEX_SANDBOX = previous
  }
}

/**
 * Open one native session and return a one-shot run. OAR cannot interrupt session
 * startup, so a cancellation during that await disposes the session before rejecting.
 */
export async function startWorkerRun(request: ResolvedSubagentStartRequest, spec: WorkerRunSpec): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (request.signal.aborted) throw cancellationFailure()
  const cwd = assertUsableCwd('team-worker', 'worker cwd', request.cwd)
  const runtime = await engineRuntime(spec.engine)
  if (request.signal.aborted) throw cancellationFailure()

  let installation: InstallationSnapshot | undefined
  try {
    installation = await runtime.installation?.({ env: spec.env })
  } catch (error: unknown) {
    const failure = new WorkerFailure('installation', 'unknown', { cause: error })
    spec.onError?.(failure, 'error')
    throw failure
  }
  if (request.signal.aborted) throw cancellationFailure()
  if (installation === undefined || installation.kind === 'unsupported') throw new WorkerFailure('installation', 'unsupported')
  if (installation.kind === 'not_found') throw new WorkerFailure('installation', 'not-found')

  let session: Session
  try {
    session = await withCodexSandbox(spec.env, () => runtime.session(installation, {
      cwd,
      ...spec.model === undefined ? {} : { model: spec.model },
      env: spec.env,
      launchArgs: spec.launchArgs,
    }))
  } catch (error: unknown) {
    if (request.signal.aborted) throw cancellationFailure()
    const failure = new WorkerFailure('startup', 'unknown', { cause: error })
    spec.onError?.(failure, 'error')
    throw failure
  }
  if (request.signal.aborted) {
    await disposeSession(session, spec)
    throw cancellationFailure()
  }
  return publishRun(session, prompt, request, spec, cwd)
}

/**
 * What the Host's live-run registry is told about a session as it opens and
 * closes. The provider holds no table of its own: the registry that owns every
 * live execution owns the control that belongs to them, so one unload, one
 * ending, and one place to look are all the same place.
 */
export interface WorkerSessionSink {
  /** The session opened, with the same-turn control it carries or nothing when it has none. */
  opened(sessionId: SessionId, steer: WorkerSteer | undefined): void
  /** The session is gone: its run ended, was released, or the provider closed it. */
  closed(sessionId: SessionId): void
}

export class TeamWorkerProvider implements SubagentProvider {
  readonly capabilities = Object.freeze({ agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false })
  readonly inheritsParentContext = false

  /**
   * @param name - the registry name the Host registered the provider under.
   * @param spec - reads the settings row as it stands when a session opens, so a
   * saved executable, engine switch, or policy reaches the next delegation.
   * @param sink - the Host's live-run registry, told when a session opens and closes.
   */
  constructor(
    readonly name: string,
    private readonly spec: () => WorkerRunSpec,
    private readonly sink: WorkerSessionSink,
  ) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const run = await startWorkerRun(request, this.spec())
    // The control rides the run this provider just published; the registry holds
    // it exactly as long as that run's session lives.
    this.sink.opened(run.id, workerSteerOf(run))
    void run.result.then(() => { this.sink.closed(run.id) }, () => { this.sink.closed(run.id) })
    return run
  }
}
