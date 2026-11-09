/**
 * The Team-owned Worker provider: one OAR-backed external execution per delegation.
 *
 * The sequence follows the Harness OAR provider; Team owns its copy because a
 * Worker must expose its native identity, which a one-shot contract does not.
 * @module @contexera/dsh-agent-team/worker-runtime
 */

import { randomUUID } from 'node:crypto'
import type {
  FailureClass,
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

import type { WorkerEngine } from './worker-settings.ts'

/** The registry name each engine's provider registers under. */
export const WORKER_PROVIDER_NAMES: Readonly<Record<WorkerEngine, string>> = Object.freeze({
  codex: 'team-worker-codex',
  claude: 'team-worker-claude',
})

type FailureStage = 'engine-unavailable' | 'installation' | 'startup' | 'turn' | 'abort' | 'dispose'
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

function publishRun(session: Session, prompt: string, request: ResolvedSubagentStartRequest, spec: WorkerRunSpec): SubagentRun {
  const stopped = Promise.withResolvers<SubagentResult>()
  const messages = new Map<string, string>()
  let streamedText = ''
  let phase: 'running' | 'cancelled' | 'timeout' | 'settled' = 'running'
  let disposal: Promise<void> | undefined

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
  const unsubscribe = session.events((event) => {
    if (event.sessionId !== session.id || event.agentPath.length !== 0 || event.kind !== 'text_delta') return
    streamedText += event.text
    if (event.messageId !== undefined) messages.set(event.messageId, (messages.get(event.messageId) ?? '') + event.text)
  }, { cursor: { sessionId: session.id, afterSeq: -1 } })
  request.signal.addEventListener('abort', onAbort, { once: true })
  if (request.signal.aborted) onAbort()
  const timer = spec.timeoutMs === undefined ? undefined : setTimeout(() => { interrupt('timeout') }, spec.timeoutMs)
  const runTurn = async (): Promise<SubagentResult> => {
    const inputId = randomUUID()
    const admitted = await session.prompt(prompt, { inputId })
    if (admitted.kind === 'rejected') {
      return { output: collectOutput(), stopReason: 'error', diagnostic: new WorkerFailure('turn', admitted.code).message }
    }
    const awaitTurnEnd = await awaitTurnEndOf()
    const outcome = await awaitTurnEnd(session, admitted.seq, inputId)
    // A native handled receipt is not a turn end: keep waiting for the turn it belongs to.
    return completedTurn(outcome.kind === 'handled' ? await awaitTurnEnd(session, outcome.seq) : outcome, collectOutput())
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
  return subprocessRunHandle({
    // The external child's id is the engine's own session identity: the execution
    // record reports it, and a later read-only diagnostic can reopen that history.
    id: SessionId(session.id),
    result,
    signal: request.signal,
    onAbort,
    requestCancel: onAbort,
    teardown: async () => {
      await dispose()
      await settled
    },
  })
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
  return publishRun(session, prompt, request, spec)
}

export class TeamWorkerProvider implements SubagentProvider {
  readonly capabilities = Object.freeze({ agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false })
  readonly inheritsParentContext = false

  /**
   * @param name - the registry name the Host registered the provider under.
   * @param spec - reads the settings row as it stands when a session opens, so a
   * saved executable, engine switch, or policy reaches the next delegation.
   */
  constructor(
    readonly name: string,
    private readonly spec: () => WorkerRunSpec,
  ) {}

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    return startWorkerRun(request, this.spec())
  }
}
