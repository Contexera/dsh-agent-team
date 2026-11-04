/**
 * Unattended execution of one subscription script: which shell family the
 * mounted executor really runs, the sandbox policy the Host builds from its own
 * Workspace record, the credential injection, and the output contract applied
 * to the captured streams.
 *
 * Two facts shape this module. The Harness captures output with its own byte
 * budget and hands back a decoded string, so the run must fail on the
 * collector's `truncated` flag instead of trusting a tail that happens to end
 * on a line boundary. And a subscription runs with no Session, so nothing here
 * may inherit the process cwd or an Agent's sandbox setting: the policy is
 * always explicit and never the escalating mode.
 * @module @contexera/dsh-agent-team/subscription-runner
 */

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

/** How much of one stream a refusal returns: enough to fix the script, never a whole log. */
export const SUBSCRIPTION_FAILURE_TAIL_BYTES = 8 * 1024

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

/**
 * Which shell family the mounted executor runs, decided by running each
 * family's probe and reading what came back. `undefined` means neither probe
 * answered: there is no executor this Host can run a script under.
 */
export async function detectShellFamily(executor: SubscriptionShellExecutor | undefined): Promise<SubscriptionShell | undefined> {
  if (executor === undefined) return undefined
  for (const family of ['bash', 'pwsh'] as const) {
    const result = await probe(executor, family)
    if (result !== undefined) return family
  }
  return undefined
}

async function probe(executor: SubscriptionShellExecutor, family: SubscriptionShell): Promise<ShellRunResult | undefined> {
  let spec: ShellExecSpec
  try {
    spec = executor.resolve({ command: SHELL_PROBES[family], timeoutMs: SUBSCRIPTION_PROBE_TIMEOUT_MS, stdoutMaxBytes: 128 })
  } catch {
    return undefined
  }
  try {
    const result = await (await executor.execute(spec)).result()
    if (result.timedOut || result.stdout.truncated) return undefined
    return result.exitCode === 0 && result.stdout.text.trim().length > 0 ? result : undefined
  } catch {
    // A probe that cannot even spawn is not evidence of a family; the caller
    // reports the missing executor instead of a made-up one.
    return undefined
  }
}

export interface SubscriptionRunRequest {
  readonly executor: SubscriptionShellExecutor | undefined
  readonly credentials: SubscriptionCredentials | undefined
  /** The family the mounted executor was probed as; the snapshot must agree. */
  readonly liveShell: SubscriptionShell | undefined
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
  const mismatch = shellMismatchReason(script.shell, request.liveShell)
  if (mismatch !== undefined) return failed('shell-mismatch', mismatch)
  if (request.executor === undefined) return failed('executor-missing', 'no shell executor is available for unattended runs')
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
      command: script.content,
      workdir: request.workspaceRoot,
      timeoutMs: request.timeoutMs ?? SUBSCRIPTION_RUN_TIMEOUT_MS,
      stdoutMaxBytes: request.stdoutMaxBytes ?? SUBSCRIPTION_STDOUT_MAX_BYTES,
      env: environment,
      ...(stdin === undefined ? {} : { stdin }),
      // Explicit, non-escalating, and built from the Workspace the Host itself
      // recorded: an unattended run never inherits the process cwd, and never
      // asks for a mode a person would have to approve.
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: request.workspaceRoot },
    })
  } catch (error) {
    return failed('spawn-failed', `the Host could not prepare this run: ${error instanceof Error ? error.message : String(error)}`)
  }
  let result: ShellRunResult
  try {
    result = await (await request.executor.execute(spec)).result()
  } catch (error) {
    return failed('spawn-failed', `the shell executor failed before the script produced output: ${error instanceof Error ? error.message : String(error)}`)
  }
  const stdout = result.stdout.text
  const stderr = result.stderr.text
  if (result.timedOut) {
    return failed('timeout', `the script exceeded ${Math.round((request.timeoutMs ?? SUBSCRIPTION_RUN_TIMEOUT_MS) / 1000)} seconds and was killed`,
      stdout, stderr, result.exitCode, true)
  }
  if (result.stdout.truncated) {
    return failed('stdout-truncated', `the script printed more than ${request.stdoutMaxBytes ?? SUBSCRIPTION_STDOUT_MAX_BYTES} bytes of stdout; narrow what it prints`,
      stdout, stderr, result.exitCode)
  }
  if (result.exitCode !== 0) {
    return failed('exit-code', `the script exited with code ${result.exitCode === null ? 'null' : result.exitCode}`, stdout, stderr, result.exitCode)
  }
  // The executor decodes bytes it captured, so an invalid byte already arrived
  // as U+FFFD. Treating that mark as a failed run is the only way to refuse
  // output the script never printed as UTF-8.
  if (stdout.includes('\uFFFD')) {
    return failed('invalid-utf8', 'the script printed bytes that are not valid UTF-8', stdout, stderr, result.exitCode)
  }
  const parsed = parseSubscriptionOutput(Buffer.from(stdout, 'utf8'))
  if (!parsed.ok) {
    return failed('invalid-output', parsed.reason, stdout, stderr, result.exitCode)
  }
  return Object.freeze({ ok: true, stdout, stderr, exitCode: result.exitCode, timedOut: false, events: parsed.events })
}

/** Whether a trial output should seed the deduplication baseline. */
export function baselineIdsOf(events: readonly SubscriptionEvent[]): readonly string[] {
  return Object.freeze([...new Set(events.map(event => event.id))])
}
