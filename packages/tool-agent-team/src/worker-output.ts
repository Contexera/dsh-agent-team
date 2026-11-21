import type { DefineToolOptions } from '@deepseek-ai/dsh-tools'
import { formatTeamTimestamp } from '@contexera/dsh-agent-team/time-format'

/**
 * What a stop call can honestly say about the run it addressed: only a
 * confirmed stop reports cleanup, an ending the run already had is reported as
 * that ending, and the Host's own diagnostic rides along when it has one.
 */
function stopReceipt(state: string, diagnostic: string | undefined): string {
  const caveat = diagnostic === undefined ? [] : [diagnostic]
  if (state === 'stopped') {
    return ['The engine confirmed this run\'s cleanup, so it is no longer running. '
      + 'Its ending appears in the Thread it reports into, if it has one.', ...caveat].join('\n')
  }
  if (state === 'completed' || state === 'failed') {
    return [`The run ended as ${state}; this stop did not change its ending.`, ...caveat].join('\n')
  }
  return [`The run is ${state}.`, ...caveat].join('\n')
}

/**
 * What a steer call can honestly say: the native session accepted the input for
 * this execution, or a linked execution started by resuming that same native
 * session. Neither receipt claims the model has read it.
 */
function steerReceipt(value: { readonly state: string; readonly workerRef: string; readonly landed?: string | undefined
  readonly turnId?: string | undefined
  readonly continuedFrom?: string | undefined; readonly runState?: string | undefined }): string {
  if (value.state === 'started') {
    return [
      `The previous execution ${value.continuedFrom ?? ''} had ended, so this instruction started a new execution in the same native session.`,
      `New Worker: ${value.workerRef}`,
      ...(value.runState === undefined
        ? [`The receipt does not record the run state; inspect Worker ${value.workerRef} for its current ending.`]
        : [`When this receipt was written, that run was ${value.runState}.`]),
      'The instruction is submitted, not confirmed read.',
    ].join('\n')
  }
  return [
    'The native session accepted the instruction into this execution. It may join the running turn or be queued for its next turn in the same native session.',
    ...(value.landed === undefined ? [] : [`Delivery: ${value.landed}.`]),
    ...(value.turnId === undefined ? [] : [`Turn: ${value.turnId}`]),
    'It is submitted, not confirmed read: the receipt does not promise which model request consumes it.',
    ...(value.runState === undefined || value.runState === 'running' ? []
      : [`By the time this answer was written the run was ${value.runState}, so the instruction may never have been read.`]),
  ].join('\n')
}

/** Keep native identities whole while bounding their share of the diagnostic. */
function workerIdentityList(ids: readonly string[]): string {
  const shown: string[] = []
  let length = 0
  for (const id of ids) {
    const next = length + id.length + (shown.length === 0 ? 0 : 2)
    if (next > 2_048) break
    shown.push(id)
    length = next
  }
  const omitted = ids.length - shown.length
  return shown.join(', ') + (omitted === 0 ? '' : ` … (${omitted} retained ids omitted)`)
}

function inspectionReport(value: {
  readonly workerRef: string; readonly state: string; readonly engine?: string | undefined
  readonly projectRef?: string | undefined; readonly threadRef?: string | undefined
  readonly startedAt?: string | undefined; readonly settledAt?: string | undefined
  readonly summary?: string | undefined; readonly stage?: string | undefined
  readonly nativeThreadId?: string | undefined; readonly nativeTurnId?: string | undefined
  readonly nativeTurnIds?: readonly string[] | undefined; readonly nativeInputIds?: readonly string[] | undefined
  readonly nativeStorage?: string | undefined; readonly nativeRecord?: string | undefined
  readonly nativeReason?: string | undefined; readonly nativeWithheld?: number | undefined
  readonly nativeTruncated?: boolean | undefined
  readonly nativeFragments?: readonly { readonly kind: string; readonly text: string }[] | undefined
}): string {
  const lines = [
    `Worker ${value.workerRef} · ${value.engine ?? 'Worker'} · ${value.state}`,
    ...(value.projectRef === undefined ? [] : [`Project: ${value.projectRef}`]),
    ...(value.threadRef === undefined ? [] : [`Thread: ${value.threadRef}`]),
    ...(value.startedAt === undefined ? [] : [`Started at: ${formatTeamTimestamp(value.startedAt)}`]),
    ...(value.settledAt === undefined ? [] : [`Ended at: ${formatTeamTimestamp(value.settledAt)}`]),
    `Summary: ${value.summary ?? 'none recorded'}`,
    ...(value.stage === undefined ? [] : [`Failed at: ${value.stage}`]),
    ...(value.nativeThreadId === undefined ? [] : [`Native thread: ${value.nativeThreadId}`]),
    ...(value.nativeTurnId === undefined ? [] : [`Native turn: ${value.nativeTurnId}`]),
    ...(value.nativeTurnIds === undefined ? [] : [`Native turns: ${workerIdentityList(value.nativeTurnIds)}`]),
    ...(value.nativeInputIds === undefined ? [] : [`Native inputs: ${workerIdentityList(value.nativeInputIds)}`]),
    ...(value.nativeStorage === undefined ? [] : [`Native record: ${value.nativeStorage}`]),
  ]
  if (value.nativeRecord !== 'read') {
    lines.push(`No native fragment to show: ${value.nativeReason ?? 'the engine named no record this Team reads.'}`)
    return lines.join('\n')
  }
  const fragments = value.nativeFragments ?? []
  lines.push(fragments.length === 0
    ? 'The engine\'s record holds nothing this Team reads for that turn.'
    : 'The engine\'s own record:')
  for (const fragment of fragments) lines.push(`- ${fragment.kind}: ${fragment.text}`)
  if (value.nativeWithheld !== undefined) lines.push(`(${value.nativeWithheld} fragment(s) withheld: their text looks like a credential.)`)
  if (value.nativeTruncated === true) lines.push('(The native-history read or its fragment limit omitted content.)')
  return lines.join('\n')
}

const TEAM_WORKER_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  workerRef: { type: 'string', required: true }, state: { type: 'string', required: true },
  continuedFrom: { type: 'string' },
  landed: { type: 'string' },
  mode: { type: 'string' },
  projectRef: { type: 'string' }, engine: { type: 'string' },
  cwd: { type: 'string' }, startedAt: { type: 'string' }, settledAt: { type: 'string' },
  threadRef: { type: 'string' }, diagnostic: { type: 'string' },
  summary: { type: 'string' }, stage: { type: 'string' },
  nativeThreadId: { type: 'string' }, nativeTurnId: { type: 'string' },
  nativeTurnIds: { type: 'array', items: { type: 'string' } },
  nativeInputIds: { type: 'array', items: { type: 'string' } },
  nativeStorage: { type: 'string' },
  nativeRecord: { type: 'string' }, nativeReason: { type: 'string' },
  turnId: { type: 'string' }, runState: { type: 'string' },
  nativeWithheld: { type: 'number' }, nativeTruncated: { type: 'boolean' },
  nativeFragments: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', required: true }, text: { type: 'string', required: true } } } },
} } as const

export const teamWorkerOutput = {
  schema: TEAM_WORKER_SCHEMA,
  render: (_args, value) => [{
    type: 'text',
    text: value.mode === 'inspect' ? inspectionReport(value)
      : value.mode === 'steer' ? steerReceipt(value) : [
      `Worker ${value.workerRef} · ${value.engine ?? 'Worker'} · ${value.state}`,
      ...(value.projectRef === undefined ? [] : [`Project: ${value.projectRef}`]),
      ...(value.threadRef === undefined ? [] : [`Thread: ${value.threadRef} — the run's start, ending, and answer report there`]),
      ...(value.cwd === undefined ? [] : [`Working directory: ${value.cwd}`]),
      ...(value.startedAt === undefined ? [] : [`Started at: ${formatTeamTimestamp(value.startedAt)}`]),
      ...(value.settledAt === undefined ? [] : [`Ended at: ${formatTeamTimestamp(value.settledAt)}`]),
      value.startedAt === undefined
        ? stopReceipt(value.state, value.diagnostic)
        : value.threadRef === undefined
          ? 'The execution runs in the background and reports back to this session when it ends. Keep working; there is nothing to poll.'
          : 'The execution runs in the background. Its ending appears in that Thread and its answer reaches your Inbox; keep working, there is nothing to poll.',
    ].join('\n'),
  }],
} satisfies DefineToolOptions<{}, typeof TEAM_WORKER_SCHEMA>['output']
