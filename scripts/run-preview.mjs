import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { harnessDir } from './harness-dir.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = harnessDir
if (process.env.DEEPSEEK_API_KEY?.trim() === '') {
  throw new Error('npm run preview requires DEEPSEEK_API_KEY; export a valid credential before launching the live Team preview')
}
if (process.env.DEEPSEEK_API_KEY === undefined) {
  throw new Error('npm run preview requires DEEPSEEK_API_KEY; export a valid credential before launching the live Team preview')
}
const temporary = await mkdtemp(join(tmpdir(), 'dsh-agent-team-preview-'))
const home = join(temporary, 'home')
const test = join(harness, 'apps/web/tests/__external-agent-team-preview.e2e.ts')
const quote = value => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")

try {
  await access(join(harness, 'apps/web/dist/index.html'), constants.R_OK)
  const rendered = (await readFile(join(root, 'scripts/team-ui.preview.ts'), 'utf8'))
    .replace('__TEAM_ROOT__', quote(root)).replace('__HOME__', quote(home))
  await writeFile(test, rendered)
  // Windows: bare-name corepack spawns hit .cmd ENOENT/EINVAL, so go through the shell.
  const child = process.platform === 'win32'
    ? spawn(`corepack pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/__external-agent-team-preview.e2e.ts --reporter=verbose`, {
        cwd: harness, stdio: 'inherit', env: { ...process.env, DSH_SNAPSHOT: 'record' }, shell: true,
      })
    : spawn('corepack', ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.web.config.ts', 'apps/web/tests/__external-agent-team-preview.e2e.ts', '--reporter=verbose'], {
        cwd: harness, stdio: 'inherit', env: { ...process.env, DSH_SNAPSHOT: 'record' },
      })
  const stop = () => { child.kill('SIGTERM') }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 || code === null || code === 143 ? resolveExit() : reject(new Error(`preview exited with ${code}`)))
  })
} finally {
  await rm(test, { force: true })
  await rm(temporary, { recursive: true, force: true })
}
