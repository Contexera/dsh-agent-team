/**
 * Unattended execution of one subscription script: which shell family the
 * mounted executor really runs, the sandbox policy the Host builds from its own
 * Workspace record, the credential injection, and the output contract applied
 * to the captured streams.
 *
 * Two facts shape this module. The Harness shell result exposes decoded text,
 * so the run forces and recovers the collect reader's bounded raw spill before
 * validating UTF-8 and the byte ceiling. And a subscription runs with no
 * Session, so nothing here may inherit the process cwd or an Agent's sandbox
 * setting: the policy is always explicit and never the escalating mode.
 * @module @contexera/dsh-agent-team/subscription-runner
 */

import { open, rm, type FileHandle } from 'node:fs/promises'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import {
  parseSubscriptionOutput,
  subscriptionRunEnvironment,
  subscriptionTestStdin,
  SUBSCRIPTION_RUN_TIMEOUT_MS,
  SUBSCRIPTION_STDOUT_MAX_BYTES,
  type SubscriptionEvent,
  type SubscriptionShell,
} from './subscriptions.ts'
import { shellMismatchReason } from './subscription-runtime.ts'
import type { AgentTeamSubscription } from './types/entities.ts'

/**
 * The executor subset a run drives — resolve, execute, and settle. Spelled out
 * rather than `Pick<ShellExecutor, …>` so a test double only has to model the
 * one call the runner makes, and a Host that mounts no executor supplies
 * `undefined`.
 */
export interface SubscriptionShellExecutor {
  resolve(request: ShellExecRequest): ShellExecSpec
  execute(spec: ShellExecSpec): Promise<{ result(): Promise<ShellRunResult> }>
}

/** The credential subset a run drives. */
export interface SubscriptionCredentials {
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
  describe(ref: CredentialRef): Promise<CredentialInfo>
}

/** Every declared reference the Host cannot resolve right now. */
export async function missingCredentials(credentials: SubscriptionCredentials | undefined,
  declared: AgentTeamSubscription['credentials']): Promise<readonly string[]> {
  if (declared.length === 0) return []
  if (credentials === undefined) return declared.map(entry => entry.ref)
  const missing: string[] = []
  for (const entry of declared) {
    const described = await credentials.describe(entry.ref as CredentialRef)
    if (!described.configured) missing.push(entry.ref)
  }
  return missing
}

/** A probe must never outlive a run's own budget, and a hung executor must not hang the scheduler. */
export const SUBSCRIPTION_PROBE_TIMEOUT_MS = 10_000

function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** How much of one stream a refusal returns: enough to fix the script, never a whole log. */
export const SUBSCRIPTION_FAILURE_TAIL_BYTES = 8 * 1024

/**
 * The shell seam exposes only decoded stdout. A one-byte collector cap forces
 * its bounded full-stream spill below the sentinel, so Team can recover and
 * validate the original bytes. If the provider's maxSpillBytes drops that
 * stream or spilling fails, a successful run is refused instead of falling
 * back to the lossy text.
 */
const RAW_STDOUT_MARKER_TEXT = '__DSH_TEAM_RAW_STDOUT__'
const RAW_STDOUT_MARKER = Buffer.from(RAW_STDOUT_MARKER_TEXT, 'ascii')
const RAW_STDOUT_COLLECTOR_BYTES = 1

function capturedCommand(command: string, shell: SubscriptionShell): string {
  if (shell === 'bash') return `printf '${RAW_STDOUT_MARKER_TEXT}'; ${command}`
  const bytes = [...RAW_STDOUT_MARKER].join(', ')
  return `[Console]::OpenStandardOutput().Write([byte[]](${bytes}), 0, ${RAW_STDOUT_MARKER.length}); & {\n${command}\n}`
}

type CapturedStdout =
  | { readonly ok: true; readonly raw: Buffer; readonly text: string; readonly tooLarge: boolean }
  | { readonly ok: false; readonly reason: string }

async function readExactly(file: FileHandle, length: number, position: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const read = await file.read(bytes, offset, length - offset, position + offset)
    if (read.bytesRead === 0) break
    offset += read.bytesRead
  }
  return bytes.subarray(0, offset)
}

async function readCapturedStdout(result: ShellRunResult, maxBytes: number): Promise<CapturedStdout> {
  const path = result.stdout.spillPath
  if (path === undefined) {
    return { ok: false, reason: 'the shell executor did not preserve the complete raw stdout stream' }
  }
  let file: FileHandle | undefined
  try {
    file = await open(path, 'r')
    const stat = await file.stat()
    if (!stat.isFile()) return { ok: false, reason: 'the shell executor published no regular stdout spill file' }
    const prefix = await readExactly(file, RAW_STDOUT_MARKER.length, 0)
    if (!prefix.equals(RAW_STDOUT_MARKER)) {
      return { ok: false, reason: 'the shell executor did not preserve the expected raw stdout stream' }
    }
    const outputBytes = stat.size - RAW_STDOUT_MARKER.length
    if (outputBytes > maxBytes) {
      const tailBytes = Math.min(outputBytes, SUBSCRIPTION_FAILURE_TAIL_BYTES)
      const raw = await readExactly(file, tailBytes, stat.size - tailBytes)
      return { ok: true, raw, text: raw.toString('utf8'), tooLarge: true }
    }
    const raw = await readExactly(file, outputBytes, RAW_STDOUT_MARKER.length)
    if (raw.length !== outputBytes) {
      return { ok: false, reason: 'the shell executor did not preserve the complete raw stdout stream' }
    }
    return { ok: true, raw, text: raw.toString('utf8'), tooLarge: false }
  } catch (error) {
    return {
      ok: false,
      reason: `the shell executor could not expose raw stdout: ${failureDetail(error)}`,
    }
  } finally {
    try {
      await file?.close()
    } catch {
      // Cleanup still owns the temporary raw stream when close reports an I/O failure.
    }
    await rm(path, { force: true }).catch(() => {})
  }
}

/**
 * The structured outcome of one run. The first two are successes; the rest name
 * what the owner has to change, so a Main stream line or a record never has to
 * parse prose to tell a timeout from a rejected script.
 */
export type SubscriptionRunCategory =
  | 'accepted'
  | 'empty'
  /** A trial run the caller asked for: its output was valid, and it published nothing. */
  | 'verified'
  | 'timeout'
  | 'exit-code'
  | 'stdout-truncated'
  /** Persisted run records from older releases may carry this category; current runs do not produce it. */
  | 'invalid-utf8'
  | 'invalid-output'
  | 'executor-missing'
  | 'shell-mismatch'
  | 'workspace-missing'
  | 'credentials-missing'
  | 'spawn-failed'
  | 'backlog-full'

export const SUBSCRIPTION_RUN_CATEGORIES: readonly SubscriptionRunCategory[] = Object.freeze([
  'accepted', 'empty', 'verified', 'timeout', 'exit-code', 'stdout-truncated', 'invalid-utf8', 'invalid-output',
  'executor-missing', 'shell-mismatch', 'workspace-missing', 'credentials-missing', 'spawn-failed', 'backlog-full',
])

/** A success is a run whose output was durably accepted, an empty one accepted nothing new, and a trial one published nothing at all. */
export function runSucceeded(category: SubscriptionRunCategory): boolean {
  return category === 'accepted' || category === 'empty' || category === 'verified'
}

/**
 * The exit-code-free proof of a shell family. Each command is valid in exactly
 * one family and a plain error in the other, so a mounted executor answers by
 * behavior rather than by class name.
 */
const SHELL_PROBES: Readonly<Record<SubscriptionShell, string>> = Object.freeze({
  bash: 'printf %s "${BASH_VERSION:-}"',
  pwsh: "if ($null -ne $PSVersionTable) { [Console]::Out.Write('pwsh') }",
})

export interface SubscriptionRunReport {
  /** True only when the script exited 0 with a complete, valid event stream. */
  readonly ok: boolean
  /** Set by every failure path: what the owner has to change. A success has none. */
  readonly category?: SubscriptionRunCategory | undefined
  /** Why the run failed, in the words an owner reads in the Main stream or a refusal. */
  readonly reason?: string | undefined
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly events: readonly SubscriptionEvent[]
}

/** The category a failed run must carry; a failure without one is a bug, not a default. */
export function failureCategory(report: SubscriptionRunReport): SubscriptionRunCategory {
  if (report.category === undefined) throw new Error('a failed run must name the category an owner acts on')
  return report.category
}

function failed(category: SubscriptionRunCategory, reason: string, stdout = '', stderr = '',
  exitCode: number | null = null, timedOut = false): SubscriptionRunReport {
  return Object.freeze({ ok: false, category, reason, stdout, stderr, exitCode, timedOut, events: [] })
}

/** The last bytes of one stream, decoded on a character boundary. */
export function failureTail(text: string, maxBytes: number = SUBSCRIPTION_FAILURE_TAIL_BYTES): string {
  if (text.length === 0) return ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  // Slice from the start of the cap and drop a split multi-byte sequence: a
  // half character would render as a replacement mark the script never printed.
  let start = buffer.length - maxBytes
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1
  return buffer.subarray(start).toString('utf8')
}

/** The family the executor answered as, or the refusal an owner can act on. */
export interface ShellFamilyProbe {
  readonly family?: SubscriptionShell | undefined
  readonly failure?: string | undefined
}

/** The first family that answers, or the first refusal's own words. */
export async function probeShellFamily(executor: SubscriptionShellExecutor | undefined): Promise<ShellFamilyProbe> {
  if (executor === undefined) return {}
  let failure: string | undefined
  for (const family of ['bash', 'pwsh'] as const) {
    const answered = await probe(executor, family)
    if (answered.family !== undefined) return answered
    failure ??= answered.failure
  }
  return failure === undefined ? {} : { failure }
}

/** The family the executor runs, or undefined when no probe answered at all. */
export async function detectShellFamily(executor: SubscriptionShellExecutor | undefined): Promise<SubscriptionShell | undefined> {
  return (await probeShellFamily(executor)).family
}

async function probe(executor: SubscriptionShellExecutor, family: SubscriptionShell): Promise<ShellFamilyProbe> {
  let spec: ShellExecSpec
  try {
    spec = executor.resolve({ command: SHELL_PROBES[family], timeoutMs: SUBSCRIPTION_PROBE_TIMEOUT_MS, stdoutMaxBytes: 128 })
  } catch (error) {
    return { failure: `the Host could not prepare a ${family} probe: ${failureDetail(error)}` }
  }
  try {
    const result = await (await executor.execute(spec)).result()
    if (result.timedOut) return { failure: `the ${family} probe exceeded ${SUBSCRIPTION_PROBE_TIMEOUT_MS} ms` }
    if (result.stdout.truncated) return { failure: `the ${family} probe printed a truncated answer` }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.text.trim()
      return { failure: `the ${family} probe exited with code ${String(result.exitCode)}${stderr.length === 0 ? '' : `: ${stderr}`}` }
    }
    if (result.stdout.text.trim().length === 0) return { failure: `the ${family} probe printed no family proof` }
    return { family }
  } catch (error) {
    return { failure: `the ${family} probe could not run: ${failureDetail(error)}` }
  }
}

export interface SubscriptionRunRequest {
  readonly executor: SubscriptionShellExecutor | undefined
  readonly credentials: SubscriptionCredentials | undefined
  /** The family the mounted executor was probed as; the snapshot must agree. */
  readonly liveShell: SubscriptionShell | undefined
  /** Why the family probe answered nothing; a refused run hands this to the owner. */
  readonly liveShellFailure?: string | undefined
  readonly subscription: AgentTeamSubscription
  /** What triggered this run: a timer, a webhook delivery, or an owner's trial. */
  readonly trigger: 'interval' | 'webhook' | 'test'
  /** The Project Workspace root from the Host's own registry record; absent when the directory is gone. */
  readonly workspaceRoot: string | undefined
  readonly lastSuccessAt: string | undefined
  /** The stdin a webhook run replays, already shaped as `{headers, body}`. */
  readonly stdin?: string | undefined
  /** The admission id a webhook run hands the script, so it can tell a retry from a redelivery. */
  readonly deliveryId?: string | undefined
  readonly stdoutMaxBytes?: number | undefined
  readonly timeoutMs?: number | undefined
}

/** Resolve the declared credential references, or name every one the Host cannot find. */
async function resolveCredentials(
  credentials: SubscriptionCredentials | undefined,
  declared: AgentTeamSubscription['credentials'],
): Promise<{ readonly resolved: Record<string, string> } | { readonly missing: readonly string[] }> {
  if (declared.length === 0) return { resolved: {} }
  const resolved: Record<string, string> = {}
  const missing: string[] = []
  for (const entry of declared) {
    const value = credentials === undefined ? undefined : await credentials.resolve(entry.ref as CredentialRef)
    if (value === undefined) missing.push(entry.ref)
    else resolved[entry.env] = value.value
  }
  return missing.length > 0 ? { missing } : { resolved }
}

/**
 * Run one snapshot under the Host's own policy and apply the output contract.
 * The report's `category` distinguishes what the owner must change: the
 * executor, the credentials, the Workspace, the script's exit, its output, or
 * the size it printed.
 */
export async function runSubscriptionScript(request: SubscriptionRunRequest): Promise<SubscriptionRunReport> {
  const script = request.subscription.script
  if (request.executor === undefined) return failed('executor-missing', 'no shell executor is available for unattended runs')
  if (request.liveShell === undefined) {
    // An unattended run cannot widen its own policy, so a mounted executor that
    // cannot spawn the pinned mode runs nothing: name its own refusal.
    return failed('spawn-failed',
      `the Host's shell executor could not answer a probe, so this run never started: ${request.liveShellFailure ?? 'no reason was recorded'}`)
  }
  const mismatch = shellMismatchReason(script.shell, request.liveShell)
  if (mismatch !== undefined) return failed('shell-mismatch', mismatch)
  if (request.workspaceRoot === undefined) {
    return failed('workspace-missing', 'the Project Workspace directory does not exist, so the script has nowhere to run')
  }
  const credentials = await resolveCredentials(request.credentials, request.subscription.credentials)
  if ('missing' in credentials) {
    return failed('credentials-missing',
      `the Host has no configured credential for ${credentials.missing.map(ref => `'${ref}'`).join(', ')}`)
  }
  const environment = subscriptionRunEnvironment({
    projectRef: request.subscription.projectRef,
    subscriptionRef: request.subscription.subscriptionRef,
    trigger: request.trigger,
    ...(request.lastSuccessAt === undefined ? {} : { lastSuccessAt: request.lastSuccessAt }),
    ...(request.deliveryId === undefined ? {} : { deliveryId: request.deliveryId }),
    resolved: credentials.resolved,
  })
  const stdin = request.stdin ?? (request.trigger === 'test' ? subscriptionTestStdin() : undefined)
  let spec: ShellExecSpec
  try {
    spec = request.executor.resolve({
      command: capturedCommand(script.content, script.shell),
      workdir: request.workspaceRoot,
      timeoutMs: request.timeoutMs ?? SUBSCRIPTION_RUN_TIMEOUT_MS,
      stdoutMaxBytes: RAW_STDOUT_COLLECTOR_BYTES,
      env: environment,
      ...(stdin === undefined ? {} : { stdin }),
      // Explicit, non-escalating, and built from the Workspace the Host itself
      // recorded: an unattended run never inherits the process cwd, and never
      // asks for a mode a person would have to approve.
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: request.workspaceRoot },
    })
  } catch (error) {
    return failed('spawn-failed', `the Host could not prepare this run: ${failureDetail(error)}`)
  }
  let result: ShellRunResult
  try {
    result = await (await request.executor.execute(spec)).result()
  } catch (error) {
    return failed('spawn-failed', `the shell executor failed before the script produced output: ${failureDetail(error)}`)
  }
  const stdoutMaxBytes = request.stdoutMaxBytes ?? SUBSCRIPTION_STDOUT_MAX_BYTES
  const captured = await readCapturedStdout(result, stdoutMaxBytes)
  const stdout = captured.ok ? captured.text : result.stdout.text
  const stderr = result.stderr.text
  if (result.timedOut) {
    return failed('timeout', `the script exceeded ${Math.round((request.timeoutMs ?? SUBSCRIPTION_RUN_TIMEOUT_MS) / 1000)} seconds and was killed`,
      stdout, stderr, result.exitCode, true)
  }
  if (captured.ok && captured.tooLarge) {
    return failed('stdout-truncated', `the script printed more than ${stdoutMaxBytes} bytes of stdout; narrow what it prints`,
      stdout, stderr, result.exitCode)
  }
  if (result.exitCode !== 0) {
    return failed('exit-code', `the script exited with code ${result.exitCode === null ? 'null' : result.exitCode}`, stdout, stderr, result.exitCode)
  }
  if (!captured.ok) {
    return failed('invalid-output', captured.reason, stdout, stderr, result.exitCode)
  }
  const parsed = parseSubscriptionOutput(captured.raw)
  if (!parsed.ok) {
    return failed('invalid-output', parsed.reason, stdout, stderr, result.exitCode)
  }
  return Object.freeze({ ok: true, stdout, stderr, exitCode: result.exitCode, timedOut: false, events: parsed.events })
}

/** Whether a trial output should seed the deduplication baseline. */
export function baselineIdsOf(events: readonly SubscriptionEvent[]): readonly string[] {
  return Object.freeze([...new Set(events.map(event => event.id))])
}
