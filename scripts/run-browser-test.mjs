import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
// Every scenario is its own file under scripts/e2e/, so the runner renders and
// runs each one inside the harness checkout. Keeping them separate means one
// slow journey cannot widen another's budget, and a failure names its file.
// `support.ts` rides along as a sibling, because the rendered files import it
// relatively — exactly where the one monolithic script used to sit.
const sourceDir = join(root, 'scripts', 'e2e')
const scenarios = (await readdir(sourceDir)).filter(name => name.endsWith('.e2e.ts') || name === 'support.ts').sort()

const quote = value => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")

const run = (command, args, cwd) => new Promise((resolveRun, reject) => {
  // Windows: bare-name pnpm shim spawns fail (.cmd ENOENT, and Node 22+ refuses shell-less .cmd spawns), so go through cmd.exe with the argument string quoted.
  const child = process.platform === 'win32'
    ? spawn(`${command} ${args.join(' ')}`, { cwd, stdio: 'inherit', env: process.env, shell: true })
    : spawn(command, args, { cwd, stdio: 'inherit', env: process.env })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)))
})

/** The staged copy every scenario runs against; the alphabetically-first scenario creates it, and the rest reuse it. */
const staged = join(home, 'profiles', 'node_modules', '@contexera', 'dsh-agent-team')
const rendered = []
try {
  await access(join(harness, 'apps/web/dist/index.html'), constants.R_OK)
  await access(chrome, constants.X_OK)
  for (const scenario of scenarios) {
    const template = await readFile(join(sourceDir, scenario), 'utf8')
    const target = join(harness, 'apps/web', 'tests', scenario === 'support.ts' ? '__external-agent-team-support.ts' : `__external-agent-team-${scenario}`)
    await writeFile(target, template
      .replaceAll('__TEAM_ROOT__', quote(root))
      .replaceAll('__HOME__', quote(home))
      .replaceAll('__CHROME__', quote(chrome)))
    // Every rendered file is removed again, support included: a leftover in the
    // Harness checkout is a stray untracked file in a repository this bundle
    // must not modify.
    rendered.push(target)
  }
  await run('corepack', ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.web.config.ts',
    ...rendered.filter(path => path.endsWith('.e2e.ts')).map(path => path.slice(harness.length + 1).replaceAll('\\', '/')),
    '--reporter=verbose', ...process.argv.slice(2)], harness)
} finally {
  await Promise.all(rendered.map(path => rm(path, { force: true })))
  await rm(temporary, { recursive: true, force: true })
}
