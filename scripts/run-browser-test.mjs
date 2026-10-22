import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { harnessDir } from './harness-dir.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = harnessDir
const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
const temporary = await mkdtemp(join(tmpdir(), 'dsh-agent-team-browser-'))
const home = join(temporary, 'home')
const test = join(harness, 'apps/web/tests/__external-agent-team.e2e.ts')

const quote = value => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")

const run = (command, args, cwd) => new Promise((resolveRun, reject) => {
  // Windows: bare-name pnpm shim spawns fail (.cmd ENOENT, and Node 22+ refuses shell-less .cmd spawns), so go through cmd.exe with the argument string quoted.
  const child = process.platform === 'win32'
    ? spawn(`${command} ${args.join(' ')}`, { cwd, stdio: 'inherit', env: process.env, shell: true })
    : spawn(command, args, { cwd, stdio: 'inherit', env: process.env })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)))
})

try {
  await access(join(harness, 'apps/web/dist/index.html'), constants.R_OK)
  await access(chrome, constants.X_OK)
  const template = await readFile(join(root, 'scripts/team-ui.e2e.ts'), 'utf8')
  const rendered = template
    .replace('__TEAM_ROOT__', quote(root))
    .replace('__HOME__', quote(home))
    .replace('__CHROME__', quote(chrome))
  await writeFile(test, rendered)
  await run('corepack', ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.web.config.ts', 'apps/web/tests/__external-agent-team.e2e.ts', '--reporter=verbose', ...process.argv.slice(2)], harness)
} finally {
  await rm(test, { force: true })
  await rm(temporary, { recursive: true, force: true })
}
