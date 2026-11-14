import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { harnessDir } from './harness-dir.mjs'
import { assertScreenshotEvidence } from './browser-evidence.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = harnessDir
const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
// The webhook entry listens on its own port. This lane never needs a fixed one — no
// scenario posts to it from outside — so it takes an ephemeral port instead of
// fighting a running `dsh web` instance, or the previous scenario, for the default.
process.env.DSH_TEAM_WEBHOOK_PORT = process.env.DSH_TEAM_WEBHOOK_PORT ?? '0'
const temporary = await mkdtemp(join(tmpdir(), 'dsh-agent-team-browser-'))
const bundleTemplate = join(temporary, 'bundle-template', '@contexera', 'dsh-agent-team')
/** The screenshots this run leaves for review: desktop and the 390×844 narrow lane. */
const artifacts = join(root, 'artifacts', 'browser')
const evidenceWidths = [1440, 390]
// Extra arguments narrow the run (a filename, or a `-t` pattern), so it owes no
// whole-run evidence set; the full run is what the acceptance lane stands on.
const narrowed = process.argv.slice(2).some(argument => !argument.startsWith('-') || /^--?(t|testNamePattern|test-name-pattern)(=|$)/.test(argument))
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

const stageBundleTemplate = async () => {
  const startedAt = Date.now()
  await mkdir(dirname(bundleTemplate), { recursive: true })
  // Match both separators: on Windows cp walks backslash paths.
  await cp(root, bundleTemplate, {
    recursive: true,
    filter: source => {
      const normalized = source.replaceAll('\\', '/')
      // .hoplite and .git hold agent-workspace state (runtime FIFOs kill fs.cp), and no installed bundle carries either.
      return !normalized.includes('/node_modules') && !normalized.includes('/src') && !normalized.includes('/artifacts') && !normalized.includes('/.hoplite')
        && !/\/\.git(\/|$)/.test(normalized)
    },
  })
  // Stage regular dependencies inside the bundle dir, as the production installer
  // would; the shared profiles/node_modules root is dsh-managed and rejects
  // foreign entries.
  const { dependencies } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const bundleModules = join(bundleTemplate, 'node_modules')
  for (const name of Object.keys(dependencies)) {
    const target = join(bundleModules, ...name.split('/'))
    if (name === '@botiverse/oar') {
      // The engine library reaches its own runtime packages through the store
      // this profile does not have, and a copy would leave them unresolvable. A
      // link keeps the real path, so its dependencies resolve as they do here.
      await mkdir(dirname(target), { recursive: true })
      await symlink(join(root, 'node_modules', name), target, 'junction')
      continue
    }
    // No filter: the source root itself lives under node_modules, and store
    // packages never nest their own node_modules.
    await cp(join(root, 'node_modules', name), target, {
      recursive: true,
      dereference: true,
    })
  }
  console.log(`staged read-only bundle template once in ${Date.now() - startedAt}ms`)
}

const rendered = []
try {
  await access(join(harness, 'apps/web/dist/index.html'), constants.R_OK)
  await access(chrome, constants.X_OK)
  await stageBundleTemplate()
  // The run owns its screenshots, so the one clear happens here, before the
  // first scenario writes one. A scenario that cleared them would delete
  // evidence another scenario already produced, and vitest decides that order.
  await rm(artifacts, { recursive: true, force: true })
  for (const scenario of scenarios) {
    const template = await readFile(join(sourceDir, scenario), 'utf8')
    const target = join(harness, 'apps/web', 'tests', scenario === 'support.ts' ? '__external-agent-team-support.ts' : `__external-agent-team-${scenario}`)
    await writeFile(target, template
      .replaceAll('__TEAM_ROOT__', quote(root))
      .replaceAll('__BUNDLE_TEMPLATE__', quote(bundleTemplate))
      .replaceAll('__CHROME__', quote(chrome)))
    // Every rendered file is removed again, support included: a leftover in the
    // Harness checkout is a stray untracked file in a repository this bundle
    // must not modify.
    rendered.push(target)
  }
  await run('corepack', ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.web.config.ts',
    ...rendered.filter(path => path.endsWith('.e2e.ts')).map(path => path.slice(harness.length + 1).replaceAll('\\', '/')),
    '--reporter=verbose', ...process.argv.slice(2)], harness)
  // A green suite whose directory is empty or unreadable is the failure this
  // gate exists for: the screenshots are the acceptance evidence.
  if (!narrowed) console.log(`browser evidence: ${await assertScreenshotEvidence(artifacts, evidenceWidths)} screenshots`)
} finally {
  await Promise.all(rendered.map(path => rm(path, { force: true })))
  await rm(temporary, { recursive: true, force: true })
}
