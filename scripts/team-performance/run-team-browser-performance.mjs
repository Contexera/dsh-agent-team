import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { harnessDir } from '../harness-dir.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const harness = harnessDir
const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
const temporary = await mkdtemp(join(tmpdir(), 'dsh-agent-team-browser-perf-'))
const home = join(temporary, 'home')
const source = join(root, 'scripts/team-performance/team-performance.e2e.ts')
const support = join(root, 'scripts/e2e/support.ts')
const renderedScenario = join(harness, 'apps/web/stress-tests/__external-agent-team-performance.stress.ts')
const renderedSupport = join(harness, 'apps/web/tests/__external-agent-team-support.ts')
const execFile = promisify(execFileCallback)

const quote = value => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
const run = (command, args, cwd, extraEnv = {}) => new Promise((resolveRun, reject) => {
  const env = { ...process.env, ...extraEnv }
  const child = process.platform === 'win32'
    ? spawn(`${command} ${args.join(' ')}`, { cwd, stdio: 'inherit', env, shell: true })
    : spawn(command, args, { cwd, stdio: 'inherit', env })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)))
})

try {
  await access(join(harness, 'apps/web/dist/index.html'), constants.R_OK)
  await access(chrome, constants.X_OK)
  const [teamCommit, harnessCommit] = await Promise.all([
    execFile('git', ['-C', root, 'rev-parse', 'HEAD']).then(result => result.stdout.trim()).catch(() => 'unknown'),
    execFile('git', ['-C', harness, 'rev-parse', 'HEAD']).then(result => result.stdout.trim()).catch(() => 'unknown'),
  ])
  const [scenarioSource, supportSource] = await Promise.all([readFile(source, 'utf8'), readFile(support, 'utf8')])
  await writeFile(renderedScenario, scenarioSource
    .replaceAll('__TEAM_ROOT__', quote(root))
    .replaceAll('__HOME__', quote(home))
    .replaceAll('__CHROME__', quote(chrome)))
  await writeFile(renderedSupport, supportSource
    .replaceAll('__TEAM_ROOT__', quote(root))
    .replaceAll('__HOME__', quote(home))
    .replaceAll('__CHROME__', quote(chrome)))
  await run('corepack', ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.web-stress.config.ts', 'apps/web/stress-tests/__external-agent-team-performance.stress.ts', '--reporter=verbose', ...process.argv.slice(2)], harness, {
    DSH_TEAM_COMMIT: teamCommit, DSH_HARNESS_COMMIT: harnessCommit,
  })
} finally {
  await Promise.all([rm(renderedScenario, { force: true }), rm(renderedSupport, { force: true }), rm(temporary, { recursive: true, force: true })])
}
