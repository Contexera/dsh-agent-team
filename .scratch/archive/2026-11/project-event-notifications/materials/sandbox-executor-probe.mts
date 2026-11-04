// Probe: what the REAL Harness executor does with a per-call sandboxPolicy, the caller env, and
// the working directory — the facts issue 02 §4.3 rests on. Run with
//   node --import tsx .scratch/active/project-event-notifications/materials/sandbox-executor-probe.mts
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'

const workspace = await mkdtemp(join(tmpdir(), 'probe-ws-'))
const outside = await mkdtemp(join(tmpdir(), 'probe-outside-'))

// Ambient facts the child must NOT inherit implicitly.
process.env.DSH_AMBIENT_PROBE = 'ambient-dsh'
process.env.PROBE_API_TOKEN = 'ambient-secret'

const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
await ctx.plugin(LocalSandboxProvider, {})
await ctx.plugin(SessionProjectionRegistry)
// Deployment policy is read-only with a DIFFERENT root: a per-call policy must override both.
await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: outside })
await ctx.plugin(SandboxBashExecutor, { cwd: workspace, timeoutMs: 30_000 })
const shell = ctx.shell

const report: Record<string, unknown> = {}

async function run(command: string, extra: Record<string, unknown> = {}) {
  const spec = shell.resolve({
    command,
    workdir: workspace,
    timeoutMs: 30_000,
    sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workspace },
    ...extra,
  } as never)
  const result = await (await shell.execute(spec)).result()
  return { spec, result }
}

// A. per-call policy reaches the spec, and the executor reports the mode it used.
{
  const { spec, result } = await run(`printf 'ok' > ${workspace}/inside.txt`)
  report.specPolicy = (spec as { sandboxPolicy?: unknown }).sandboxPolicy
  report.insideWrite = { exitCode: result.exitCode, sandbox: result.sandbox, exists: existsSync(join(workspace, 'inside.txt')) }
}

// B. the same policy must deny a write beside the workspace root.
{
  const { result } = await run(`printf 'nope' > ${outside}/outside.txt`)
  report.outsideWrite = { exitCode: result.exitCode, sandbox: result.sandbox, exists: existsSync(join(outside, 'outside.txt')), stderrTail: result.stderr.text.slice(-160) }
}

// C. cwd is the requested workdir.
{
  const { result } = await run(`pwd -P`)
  report.cwd = { stdout: result.stdout.text.trim(), expected: workspace }
}

// D. caller env survives; ambient DSH_* and credential-shaped names do not.
{
  const { spec, result } = await run(`env | sort`, {
    env: { DSH_TEAM_SUBSCRIPTION_REF: 'subscription:probe', DEMO_API_KEY: 'caller-supplied' },
  })
  const specEnv = (spec as { env?: Record<string, string> }).env ?? {}
  const childEnv = result.stdout.text.split('\n')
  report.envSpecKeys = Object.keys(specEnv)
  report.envChild = childEnv.filter(line => /^(DSH_|DEMO_|PROBE_)/.test(line))
}

// E. shell-family probes behave like the Host's detection expects.
{
  const bash = await run(`printf %s "\${BASH_VERSION:-}"`)
  const pwsh = await run(`if ($null -ne $PSVersionTable) { [Console]::Out.Write('pwsh') }`)
  report.family = { bash: bash.result.stdout.text.trim(), pwsh: { stdout: pwsh.result.stdout.text, exitCode: pwsh.result.exitCode } }
}

// F. stdout cap and truncation bookkeeping (tail semantics the runner relies on).
{
  const { result } = await run(`printf 'a%.0s' $(seq 1 4096)`, { stdoutMaxBytes: 1024 })
  report.truncation = { length: result.stdout.text.length, truncated: result.stdout.truncated, spillPath: result.stdout.spillPath ?? null }
}

console.log(JSON.stringify(report, null, 2))
await ctx.fiber.dispose()
await rm(workspace, { recursive: true, force: true })
await rm(outside, { recursive: true, force: true })
