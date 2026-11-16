import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { harnessDir } from './harness-dir.mjs'
import { assertScreenshotEvidence, readScreenshots } from './browser-evidence.mjs'
import {
  LANE_ALIASES,
  buildSummary,
  formatLaneList,
  formatSummaryText,
  parseLaneContracts,
  parseRunnerArgs,
  resolveLanes,
} from './browser-runner.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = harnessDir
const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
// The webhook entry listens on its own port. This lane never needs a fixed one — no
// scenario posts to it from outside — so it takes an ephemeral port instead of
// fighting a running `dsh web` instance, or the previous scenario, for the default.
process.env.DSH_TEAM_WEBHOOK_PORT = process.env.DSH_TEAM_WEBHOOK_PORT ?? '0'
const artifacts = join(root, 'artifacts', 'browser')
const summaryPath = join(artifacts, 'summary.json')
const evidenceWidths = [1440, 390]

const { list, fileFilters, vitestFlags, narrowed } = parseRunnerArgs(process.argv.slice(2))
const sourceDir = join(root, 'scripts', 'e2e')
const allE2eFiles = (await readdir(sourceDir)).filter(name => name.endsWith('.e2e.ts')).sort()
const catalogText = await readFile(join(root, 'docs', 'development', 'e2e-lanes.md'), 'utf8')
const contracts = parseLaneContracts(catalogText)

if (list) {
  console.log(formatLaneList(allE2eFiles, contracts, LANE_ALIASES))
  process.exit(0)
}

const { matchedE2eFiles, selectedLanes } = resolveLanes({
  allE2eFiles,
  fileFilters,
  aliases: LANE_ALIASES,
  contracts,
})
const scenarios = ['support.ts', ...matchedE2eFiles]
const mode = narrowed ? 'targeted' : 'full'

console.log(`[test:browser] mode=${mode} lanes=${selectedLanes.map(lane => lane.name).join(',')}`)
for (const lane of selectedLanes) {
  console.log(`[test:browser] contract(${lane.name}): ${lane.contract}`)
}

const temporary = await mkdtemp(join(tmpdir(), 'dsh-agent-team-browser-'))
const bundleTemplate = join(temporary, 'bundle-template', '@contexera', 'dsh-agent-team')
const phaseFile = join(temporary, 'scenario-phase.json')
const vitestReportFile = join(temporary, 'vitest-report.json')

const quote = value => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")

const run = (command, args, cwd, env = process.env) => new Promise((resolveRun, reject) => {
  // Windows: bare-name pnpm shim spawns fail (.cmd ENOENT, and Node 22+ refuses shell-less .cmd spawns), so go through cmd.exe with the argument string quoted.
  const child = process.platform === 'win32'
    ? spawn(`${command} ${args.join(' ')}`, { cwd, stdio: 'inherit', env, shell: true })
    : spawn(command, args, { cwd, stdio: 'inherit', env })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)))
})

const runPnpm = async (args, cwd, env = process.env) => {
  try {
    await run('corepack', ['pnpm', ...args], cwd, env)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      await run('pnpm', args, cwd, env)
      return
    }
    throw error
  }
}

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

const readJsonIfPresent = async path => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

const phases = {}
const rendered = []
let currentPhase = 'preflight'
let failedPhase = null
let environmentBlocker = null
let screenshots = 0
let testsSummary = null
let runError = null

try {
  // Clear artifacts once before the run, then recreate directory for summary.json.
  await rm(artifacts, { recursive: true, force: true })
  await mkdir(artifacts, { recursive: true })

  const preflightStart = Date.now()
  try {
    await access(join(harness, 'apps/web/dist/index.html'), constants.R_OK)
  } catch (error) {
    environmentBlocker = `Missing built Harness web app at ${join(harness, 'apps/web/dist/index.html')}`
    throw error
  }
  try {
    await access(chrome, constants.X_OK)
  } catch (error) {
    environmentBlocker = `Missing executable Chrome at ${chrome} (set CHROME_PATH if installed elsewhere)`
    throw error
  }
  phases.preflight = Date.now() - preflightStart

  currentPhase = 'staging'
  const stagingStart = Date.now()
  await stageBundleTemplate()
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
  phases.staging = Date.now() - stagingStart

  currentPhase = 'vitest'
  const vitestStart = Date.now()
  await runPnpm(['exec', 'vitest', 'run', '--config', 'vitest.web.config.ts',
    ...rendered.filter(path => path.endsWith('.e2e.ts')).map(path => path.slice(harness.length + 1).replaceAll('\\', '/')),
    '--reporter=verbose', '--reporter=json', `--outputFile.json=${vitestReportFile}`, ...vitestFlags],
  harness,
  { ...process.env, DSH_E2E_PHASE_FILE: phaseFile })
  phases.vitest = Date.now() - vitestStart

  currentPhase = 'evidence'
  const evidenceStart = Date.now()
  if (!narrowed) {
    screenshots = await assertScreenshotEvidence(artifacts, evidenceWidths)
    console.log(`browser evidence: ${screenshots} screenshots`)
  } else {
    const hasArtifacts = await access(artifacts).then(() => true, () => false)
    screenshots = hasArtifacts ? await assertScreenshotEvidence(artifacts, []) : 0
    console.log(`browser evidence (filtered): ${screenshots} screenshots`)
  }
  phases.evidence = Date.now() - evidenceStart
} catch (error) {
  failedPhase = currentPhase
  runError = error
} finally {
  const cleanupStart = Date.now()
  try {
    await Promise.all(rendered.map(path => rm(path, { force: true })))
    const phaseMarker = await readJsonIfPresent(phaseFile)
    const vitestReport = await readJsonIfPresent(vitestReportFile)
    if (vitestReport && typeof vitestReport.numTotalTests === 'number') {
      testsSummary = {
        total: vitestReport.numTotalTests,
        passed: vitestReport.numPassedTests ?? 0,
        failed: vitestReport.numFailedTests ?? 0,
      }
    }
    if (failedPhase === null && screenshots === 0) {
      const existing = await readScreenshots(artifacts).catch(() => [])
      screenshots = existing.length
    }
    await rm(temporary, { recursive: true, force: true })
    phases.cleanup = Date.now() - cleanupStart

    const summary = buildSummary({
      status: failedPhase === null ? 'passed' : 'failed',
      mode,
      selectedLanes,
      phases,
      failedPhase,
      scenarioPhase: failedPhase === 'vitest' ? (phaseMarker?.phase ?? null) : null,
      tests: testsSummary,
      screenshots,
      artifactPath: artifacts,
      environmentBlocker,
      error: runError instanceof Error ? runError.message : (runError ? String(runError) : null),
    })
    await mkdir(artifacts, { recursive: true })
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    console.log(formatSummaryText(summary))
  } catch (cleanupError) {
    if (runError === null) {
      failedPhase = 'cleanup'
      runError = cleanupError
    } else {
      console.error('Cleanup error:', cleanupError)
    }
  }
}

if (runError !== null) {
  throw runError
}
