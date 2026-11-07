/**
 * The unattended executor seam: what the Host puts into one run, and what it
 * makes of the streams that come back. The executor here is a recorder, so a
 * refused run is proved by the reason and the request, never by a real shell.
 */
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterAll, describe, expect, it } from 'vitest'
import type { ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { failureTail, probeShellFamily, runSubscriptionScript, type SubscriptionCredentials } from '../src/subscription-runner.ts'
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
  spillPath?: string | undefined
}

const fakeSpillRoot = mkdtempSync(join(tmpdir(), 'dsh-team-runner-fake-'))
let fakeSpillId = 0

afterAll(() => {
  rmSync(fakeSpillRoot, { recursive: true, force: true })
})

type ExecutorAnswer = Partial<ShellRunResult> & {
  readonly stdoutText?: string
  /** A regular file is the provider contract; the broken link exercises cleanup after a read failure. */
  readonly spill?: 'file' | 'unreadable' | 'missing'
}

function executor(answer: (spec: ShellExecSpec) => ExecutorAnswer) {
  const recorded: Recorded[] = []
  return {
    recorded,
    resolve(request: ShellExecSpec): ShellExecSpec {
      return request
    },
    async execute(spec: ShellExecSpec) {
      const record: Recorded = { spec }
      recorded.push(record)
      const answered = answer(spec)
      const spillPath = join(fakeSpillRoot, `${fakeSpillId++}.log`)
      record.spillPath = spillPath
      if (answered.spill === 'unreadable') symlinkSync(join(fakeSpillRoot, 'missing'), spillPath)
      else if (answered.spill !== 'missing') writeFileSync(spillPath, `__DSH_TEAM_RAW_STDOUT__${answered.stdoutText ?? ''}`)
      return { result: async (): Promise<ShellRunResult> => ({
        exitCode: answered.exitCode ?? 0,
        signal: null,
        timedOut: answered.timedOut ?? false,
        aborted: false,
        timeoutMs: spec.timeoutMs,
        stdout: {
          text: answered.stdoutText ?? '',
          truncated: answered.stdout?.truncated ?? false,
          ...(answered.spill === 'missing' ? {} : { spillPath }),
        },
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

function paddedOutputScript(totalBytes: number): string {
  const head = '{"id":"a","title":"A","pad":"'
  const tail = '"}\n'
  const padding = totalBytes - Buffer.byteLength(head + tail)
  return `printf '${head}'; head -c ${padding} /dev/zero | tr '\\0' x; printf '${tail}'`
}

class PassthroughSandboxProvider extends SandboxProvider {
  async confine(argv: readonly string[]) {
    return { argv: [...argv], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }
  }
}

async function realSandboxBash() {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-team-runner-'))
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(PassthroughSandboxProvider)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxBashExecutor, { graceMs: 200 })
  return {
    executor: ctx.shell as SandboxBashExecutor,
    workspace,
    async dispose() {
      await ctx.fiber.dispose()
      await rm(workspace, { recursive: true, force: true })
    },
  }
}

describe('what one run is handed', () => {
  it('runs in the Workspace root under an explicit, non-escalating policy', async () => {
    const shell = executor(() => ({ stdoutText: validOutput }))
    const report = await runSubscriptionScript({
      executor: shell, credentials: credentials({}), liveShell: 'bash', subscription: subscription(),
      trigger: 'interval', workspaceRoot: WORKSPACE, lastSuccessAt: undefined,
    })
    expect(report.ok).toBe(true)
    const { spec } = shell.recorded[0]!
    expect(existsSync(shell.recorded[0]!.spillPath!)).toBe(false)
    expect(spec.workdir).toBe(WORKSPACE)
    expect(spec.sandboxPolicy).toEqual({ mode: 'workspace-write', workspaceRoot: WORKSPACE })
    expect(spec.timeoutMs).toBe(SUBSCRIPTION_RUN_TIMEOUT_MS)
    // The public collector spills the raw stream; Team applies its 65,536-byte contract after recovery.
    expect(spec.stdoutMaxBytes).toBe(1)
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

  it('names the mounted executor refusal when no probe can run, instead of a missing executor', async () => {
    const refusal = 'sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host'
    const refusing = {
      resolve: (request: ShellExecSpec) => request,
      execute: async (): Promise<{ result(): Promise<ShellRunResult> }> => { throw new Error(refusal) },
    }
    await expect(probeShellFamily(refusing)).resolves.toEqual({ failure: expect.stringContaining(refusal) })
    const report = await runSubscriptionScript({
      executor: refusing, credentials: credentials({}), liveShell: undefined,
      liveShellFailure: `the bash probe could not run: ${refusal}`,
      subscription: subscription(), trigger: 'interval', workspaceRoot: WORKSPACE, lastSuccessAt: undefined,
    })
    expect(report.ok).toBe(false)
    expect(report.category).toBe('spawn-failed')
    expect(report.reason).toContain(refusal)
    expect(report.reason).not.toMatch(/no shell executor/)
  })

  it('keeps the missing-executor reason for a Host that mounts no executor at all', async () => {
    const report = await runSubscriptionScript({
      executor: undefined, credentials: credentials({}), liveShell: undefined,
      subscription: subscription(), trigger: 'interval', workspaceRoot: WORKSPACE, lastSuccessAt: undefined,
    })
    expect(report).toMatchObject({ ok: false, category: 'executor-missing' })
    expect(report.reason).toMatch(/no shell executor/)
  })

  it('answers a probe with the family the executor really runs', async () => {
    const bash = executor(() => ({ stdoutText: '5.2.15' }))
    await expect(probeShellFamily(bash)).resolves.toEqual({ family: 'bash' })
    await expect(probeShellFamily(undefined)).resolves.toEqual({})
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
    const shell = executor(() => ({ stdoutText: 'x'.repeat(SUBSCRIPTION_STDOUT_MAX_BYTES + 1), stdout: { truncated: true } as never }))
    const report = await runSubscriptionScript({
      executor: shell, credentials: credentials({}), liveShell: 'bash', subscription: subscription(),
      trigger: 'interval', workspaceRoot: WORKSPACE, lastSuccessAt: undefined,
    })
    expect(report.ok).toBe(false)
    expect(report.reason).toMatch(/65536 bytes of stdout/)
    expect(existsSync(shell.recorded[0]!.spillPath!)).toBe(false)
  })

  it('reports missing raw stdout instead of inferring a size overrun', async () => {
    const shell = executor(() => ({ stdoutText: validOutput, stdout: { truncated: true } as never, spill: 'missing' }))
    const report = await runSubscriptionScript({
      executor: shell, credentials: credentials({}), liveShell: 'bash', subscription: subscription(),
      trigger: 'interval', workspaceRoot: WORKSPACE, lastSuccessAt: undefined,
    })
    expect(report).toMatchObject({ ok: false, category: 'invalid-output', events: [] })
    expect(report.reason).toMatch(/did not preserve the complete raw stdout stream/)
    expect(report.reason).not.toMatch(/65536 bytes/)
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
    expect(existsSync(shell.recorded[0]!.spillPath!)).toBe(false)
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

  it.skipIf(process.platform === 'win32')('accepts a legal replacement character and a UTF-8 character split across output chunks', async () => {
    const real = await realSandboxBash()
    try {
      const report = await runSubscriptionScript({
        executor: real.executor, credentials: credentials({}), liveShell: 'bash',
        subscription: subscription({ script: script(String.raw`printf '{"id":"a\357\277\275","title":"A"}\n'
printf '{"id":"b\342'; sleep 0.01; printf '\202'; sleep 0.01; printf '\254","title":"B"}\n'`) }),
        trigger: 'interval', workspaceRoot: real.workspace, lastSuccessAt: undefined,
      })
      expect(report.ok).toBe(true)
      expect(report.ok && report.events.map(event => event.id)).toEqual(['a\uFFFD', 'b\u20AC'])
    } finally {
      await real.dispose()
    }
  })

  it.skipIf(process.platform === 'win32')('rejects illegal raw stdout bytes from the real sandbox bash executor', async () => {
    const real = await realSandboxBash()
    try {
      for (const [octal, title] of [['377', 'FF'], ['376', 'FE']] as const) {
        const report = await runSubscriptionScript({
          executor: real.executor, credentials: credentials({}), liveShell: 'bash',
          subscription: subscription({ script: script(`printf '{"id":"a\\${octal}","title":"${title}"}\n'`) }),
          trigger: 'interval', workspaceRoot: real.workspace, lastSuccessAt: undefined,
        })
        expect(report).toMatchObject({ ok: false, category: 'invalid-output', events: [] })
        expect(report.reason).toMatch(/not valid UTF-8/)
      }
    } finally {
      await real.dispose()
    }
  })

  it.skipIf(process.platform === 'win32')('applies the output limit to the recovered raw bytes at the exact boundary', async () => {
    const real = await realSandboxBash()
    try {
      const exact = await runSubscriptionScript({
        executor: real.executor, credentials: credentials({}), liveShell: 'bash',
        subscription: subscription({ script: script(paddedOutputScript(SUBSCRIPTION_STDOUT_MAX_BYTES)) }),
        trigger: 'interval', workspaceRoot: real.workspace, lastSuccessAt: undefined,
      })
      expect(exact.ok).toBe(true)
      expect(Buffer.byteLength(exact.stdout)).toBe(SUBSCRIPTION_STDOUT_MAX_BYTES)

      const over = await runSubscriptionScript({
        executor: real.executor, credentials: credentials({}), liveShell: 'bash',
        subscription: subscription({ script: script(paddedOutputScript(SUBSCRIPTION_STDOUT_MAX_BYTES + 1)) }),
        trigger: 'interval', workspaceRoot: real.workspace, lastSuccessAt: undefined,
      })
      expect(over).toMatchObject({ ok: false, category: 'stdout-truncated', events: [] })
    } finally {
      await real.dispose()
    }
  })

  it.skipIf(process.platform === 'win32')('preserves stdin, exit status, and stderr through raw capture', async () => {
    const real = await realSandboxBash()
    try {
      const report = await runSubscriptionScript({
        executor: real.executor, credentials: credentials({}), liveShell: 'bash',
        subscription: subscription({ script: script(`IFS= read -r input || true
printf '%s' "$input" >&2
printf '{"id":"a","title":"A"}\n'
exit 7`) }),
        trigger: 'webhook', workspaceRoot: real.workspace, lastSuccessAt: undefined, stdin: 'webhook-input',
      })
      expect(report).toMatchObject({ ok: false, category: 'exit-code', exitCode: 7, stdout: validOutput })
      expect(report.stderr).toContain('webhook-input')
    } finally {
      await real.dispose()
    }
  })

  it.skipIf(process.platform === 'win32')('keeps a real executor timeout ahead of raw-output classification', async () => {
    const real = await realSandboxBash()
    try {
      const report = await runSubscriptionScript({
        executor: real.executor, credentials: credentials({}), liveShell: 'bash',
        subscription: subscription({ script: script('sleep 1') }),
        trigger: 'interval', workspaceRoot: real.workspace, lastSuccessAt: undefined, timeoutMs: 100,
      })
      expect(report).toMatchObject({ ok: false, category: 'timeout', timedOut: true })
    } finally {
      await real.dispose()
    }
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

  it('removes the raw spill after invalid output and after a read failure', async () => {
    const empty = executor(() => ({}))
    const emptyReport = await runSubscriptionScript({
      executor: empty, credentials: credentials({}), liveShell: 'bash', subscription: subscription(),
      trigger: 'interval', workspaceRoot: WORKSPACE, lastSuccessAt: undefined,
    })
    expect(emptyReport).toMatchObject({ ok: true, events: [] })
    expect(existsSync(empty.recorded[0]!.spillPath!)).toBe(false)

    const invalid = executor(() => ({ stdoutText: 'not json\n' }))
    const invalidReport = await runSubscriptionScript({
      executor: invalid, credentials: credentials({}), liveShell: 'bash', subscription: subscription(),
      trigger: 'interval', workspaceRoot: WORKSPACE, lastSuccessAt: undefined,
    })
    expect(invalidReport).toMatchObject({ ok: false, category: 'invalid-output' })
    expect(existsSync(invalid.recorded[0]!.spillPath!)).toBe(false)

    if (process.platform === 'win32') return
    const unreadable = executor(() => ({ spill: 'unreadable' }))
    const unreadableReport = await runSubscriptionScript({
      executor: unreadable, credentials: credentials({}), liveShell: 'bash', subscription: subscription(),
      trigger: 'interval', workspaceRoot: WORKSPACE, lastSuccessAt: undefined,
    })
    expect(unreadableReport).toMatchObject({ ok: false, category: 'invalid-output' })
    expect(existsSync(unreadable.recorded[0]!.spillPath!)).toBe(false)
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
