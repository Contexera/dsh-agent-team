/**
 * The unattended executor seam: what the Host puts into one run, and what it
 * makes of the streams that come back. The executor here is a recorder, so a
 * refused run is proved by the reason and the request, never by a real shell.
 */
import { describe, expect, it } from 'vitest'
import type { ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { failureTail, runSubscriptionScript, type SubscriptionCredentials } from '../src/subscription-runner.ts'
import { SUBSCRIPTION_RUN_TIMEOUT_MS, SUBSCRIPTION_STDOUT_MAX_BYTES, snapshotScript } from '../src/subscriptions.ts'
import type { AgentTeamSubscription, AgentTeamSubscriptionRef } from '../src/types.ts'

const WORKSPACE = '/tmp/workspace-root'

function script(content: string, shell: 'bash' | 'pwsh' = 'bash') {
  const snapshot = snapshotScript(content, shell)
  if (!snapshot.ok) throw new Error(snapshot.reason)
  return snapshot.script
}

function subscription(overrides: { readonly script?: ReturnType<typeof script>; readonly credentials?: readonly { ref: string; env: string }[] } = {}): AgentTeamSubscription {
  return {
    subscriptionRef: 'subscription:runner' as AgentTeamSubscriptionRef,
    projectRef: 'project:p' as never,
    name: 'runner',
    triggers: { interval: { minutes: 10 } },
    script: overrides.script ?? script('printf \'{"id":"a","title":"A"}\\n\'\n'),
    credentials: overrides.credentials ?? [],
    revision: 1,
    state: 'active',
    createdBy: 'member:owner' as never,
    createdAt: '2026-11-03T00:00:00.000Z',
  }
}

interface Recorded {
  readonly spec: ShellExecSpec
}

function executor(answer: (spec: ShellExecSpec) => Partial<ShellRunResult> & { readonly stdoutText?: string }) {
  const recorded: Recorded[] = []
  return {
    recorded,
    resolve(request: ShellExecSpec): ShellExecSpec {
      return request
    },
    async execute(spec: ShellExecSpec) {
      recorded.push({ spec })
      const answered = answer(spec)
      return { result: async (): Promise<ShellRunResult> => ({
        exitCode: answered.exitCode ?? 0,
        signal: null,
        timedOut: answered.timedOut ?? false,
        aborted: false,
        timeoutMs: spec.timeoutMs,
        stdout: { text: answered.stdoutText ?? '', truncated: answered.stdout?.truncated ?? false },
        stderr: { text: answered.stderr?.text ?? '', truncated: false },
      }) }
    },
  }
}

const credentials = (values: Record<string, string>): SubscriptionCredentials => ({
  resolve: async ref => values[ref] === undefined ? undefined : { value: values[ref]!, source: 'fixture' },
  describe: async ref => ({ configured: values[ref] !== undefined, writable: false }),
})

const validOutput = '{"id":"a","title":"A"}\n'

describe('what one run is handed', () => {
  it('runs in the Workspace root under an explicit, non-escalating policy', async () => {
    const shell = executor(() => ({ stdoutText: validOutput }))
    const report = await runSubscriptionScript({
      executor: shell, credentials: credentials({}), liveShell: 'bash', subscription: subscription(),
      trigger: 'interval', workspaceRoot: WORKSPACE, lastSuccessAt: undefined,
    })
    expect(report.ok).toBe(true)
    const { spec } = shell.recorded[0]!
    expect(spec.workdir).toBe(WORKSPACE)
    expect(spec.sandboxPolicy).toEqual({ mode: 'workspace-write', workspaceRoot: WORKSPACE })
    expect(spec.timeoutMs).toBe(SUBSCRIPTION_RUN_TIMEOUT_MS)
    // The Harness default is 64,000 bytes; this contract asks for its own cap.
    expect(spec.stdoutMaxBytes).toBe(SUBSCRIPTION_STDOUT_MAX_BYTES)
    expect(spec.stdin).toBeUndefined()
  })

  it('carries only the Host facts and the resolved credentials, never the ambient environment', async () => {
    const shell = executor(() => ({ stdoutText: validOutput }))
    process.env.DSH_TEAM_AMBIENT_SECRET = 'leaked'
    try {
      await runSubscriptionScript({
        executor: shell, credentials: credentials({ GH_TOKEN: 'token-value' }), liveShell: 'bash',
        subscription: subscription({ credentials: [{ ref: 'GH_TOKEN', env: 'GH_TOKEN' }] }),
        trigger: 'interval', workspaceRoot: WORKSPACE, lastSuccessAt: '2026-11-02T10:00:00.000Z',
      })
    } finally {
      delete process.env.DSH_TEAM_AMBIENT_SECRET
    }
    const { spec } = shell.recorded[0]!
    expect(Object.keys(spec.env ?? {}).sort()).toEqual(['DSH_TEAM_LAST_SUCCESS_AT', 'DSH_TEAM_PROJECT', 'DSH_TEAM_SUBSCRIPTION', 'DSH_TEAM_TRIGGER', 'GH_TOKEN'])
    expect(spec.env).toMatchObject({ DSH_TEAM_TRIGGER: 'interval', DSH_TEAM_LAST_SUCCESS_AT: '2026-11-02T10:00:00.000Z', GH_TOKEN: 'token-value' })
  })

  it('sends the trial envelope on stdin so a webhook-only script can refuse the sample', async () => {
    const shell = executor(() => ({ stdoutText: '' }))
    await runSubscriptionScript({
      executor: shell, credentials: credentials({}), liveShell: 'bash', subscription: subscription(),
      trigger: 'test', workspaceRoot: WORKSPACE, lastSuccessAt: undefined,
    })
    const { spec } = shell.recorded[0]!
    expect(JSON.parse(spec.stdin ?? '{}')).toMatchObject({ headers: { 'x-team-delivery': 'test' }, body: '{"test":true}' })
    expect(spec.env).toMatchObject({ DSH_TEAM_TRIGGER: 'test' })
  })

  it('refuses to run a snapshot recorded under another shell family', async () => {
    const shell = executor(() => ({ stdoutText: validOutput }))
    const report = await runSubscriptionScript({
      executor: shell, credentials: credentials({}), liveShell: 'pwsh', subscription: subscription({ script: script(validOutput, 'bash') }),
      trigger: 'interval', workspaceRoot: WORKSPACE, lastSuccessAt: undefined,
    })
    expect(report.ok).toBe(false)
    expect(report.reason).toMatch(/created for bash, but the Host runs pwsh/)
    expect(shell.recorded).toHaveLength(0)
  })

  it('fails the run when a declared credential is not configured', async () => {
    const shell = executor(() => ({ stdoutText: validOutput }))
    const report = await runSubscriptionScript({
      executor: shell, credentials: credentials({}), liveShell: 'bash',
      subscription: subscription({ credentials: [{ ref: 'GH_TOKEN', env: 'GH_TOKEN' }] }),
      trigger: 'interval', workspaceRoot: WORKSPACE, lastSuccessAt: undefined,
    })
    expect(report.ok).toBe(false)
    expect(report.reason).toMatch(/'GH_TOKEN'/)
    expect(shell.recorded).toHaveLength(0)
  })
})

describe('what the streams have to prove', () => {
  it('fails on a truncated stdout instead of accepting a valid-looking tail', async () => {
    const shell = executor(() => ({ stdoutText: validOutput, stdout: { truncated: true } as never }))
    const report = await runSubscriptionScript({
      executor: shell, credentials: credentials({}), liveShell: 'bash', subscription: subscription(),
      trigger: 'interval', workspaceRoot: WORKSPACE, lastSuccessAt: undefined,
    })
    expect(report.ok).toBe(false)
    expect(report.reason).toMatch(/65536 bytes of stdout/)
  })

  it('fails a killed run, and names how long it was allowed to live', async () => {
    const shell = executor(() => ({ stdoutText: validOutput, timedOut: true, exitCode: null }))
    const report = await runSubscriptionScript({
      executor: shell, credentials: credentials({}), liveShell: 'bash', subscription: subscription(),
      trigger: 'interval', workspaceRoot: WORKSPACE, lastSuccessAt: undefined,
    })
    expect(report.ok).toBe(false)
    expect(report.timedOut).toBe(true)
    expect(report.reason).toMatch(/exceeded 60 seconds/)
  })

  it('fails a non-zero exit, keeping both stream tails for the owner', async () => {
    const shell = executor(() => ({ exitCode: 3, stdoutText: 'partial\n', stderr: { text: 'boom' } as never }))
    const report = await runSubscriptionScript({
      executor: shell, credentials: credentials({}), liveShell: 'bash', subscription: subscription(),
      trigger: 'interval', workspaceRoot: WORKSPACE, lastSuccessAt: undefined,
    })
    expect(report.ok).toBe(false)
    expect(report.exitCode).toBe(3)
    expect(report.stdout).toBe('partial\n')
    expect(report.stderr).toBe('boom')
    expect(report.reason).toMatch(/exited with code 3/)
  })

  it('takes a replacement character as data instead of refusing the run', async () => {
    const shell = executor(() => ({ stdoutText: '{"id":"a\uFFFD","title":"A"}\n' }))
    const report = await runSubscriptionScript({
      executor: shell, credentials: credentials({}), liveShell: 'bash', subscription: subscription(),
      trigger: 'interval', workspaceRoot: WORKSPACE, lastSuccessAt: undefined,
    })
    expect(report.ok).toBe(true)
    expect(report.ok && report.events.map(event => event.id)).toEqual(['a\uFFFD'])
  })

  it('accepts a complete event stream and reports every event', async () => {
    const shell = executor(() => ({ stdoutText: '{"id":"a","title":"A"}\n{"id":"b","title":"B","url":"https://example.test/b"}\n' }))
    const report = await runSubscriptionScript({
      executor: shell, credentials: credentials({}), liveShell: 'bash', subscription: subscription(),
      trigger: 'interval', workspaceRoot: WORKSPACE, lastSuccessAt: undefined,
    })
    expect(report.ok).toBe(true)
    expect(report.events.map(event => event.id)).toEqual(['a', 'b'])
  })

  it('fails a workspace that is gone instead of falling back to the process cwd', async () => {
    const shell = executor(() => ({ stdoutText: validOutput }))
    const report = await runSubscriptionScript({
      executor: shell, credentials: credentials({}), liveShell: 'bash', subscription: subscription(),
      trigger: 'interval', workspaceRoot: undefined, lastSuccessAt: undefined,
    })
    expect(report.ok).toBe(false)
    expect(report.reason).toMatch(/Workspace directory does not exist/)
    expect(shell.recorded).toHaveLength(0)
  })
})

describe('the failure tail', () => {
  it('keeps the last bytes of a stream, never a split character', () => {
    expect(failureTail('short')).toBe('short')
    const long = `${'a'.repeat(10)}ä${'b'.repeat(20)}`
    const tail = failureTail(long, 8)
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(8)
    expect(tail).not.toContain('\uFFFD')
    expect(long.endsWith(tail)).toBe(true)
  })
})
