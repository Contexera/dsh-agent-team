import { afterEach, describe, expect, it } from 'vitest'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

// scripts/harness-dir.mjs is the single source of truth for the sibling
// harness checkout. It runs at import time, so each case exercises it in a
// fresh node process with a controlled environment.
const run = (env: Record<string, string | undefined>): { stdout: string; stderr: string } => {
  const environment = { ...process.env, ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value ?? ''])) }
  for (const key of Object.keys(env)) if (env[key] === undefined) delete environment[key]
  try {
    const stdout = execFileSync(process.execPath, ['-e', "import('./scripts/harness-dir.mjs').then(m => console.log(m.harnessName + ' ' + m.harnessDir))"], {
      cwd: process.cwd(),
      env: environment,
      encoding: 'utf8',
      // Pin stdio: execFileSync otherwise forwards a failing child's stderr to
      // this process, dumping the expected failure text into the runner log.
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { stdout, stderr: '' }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string }
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

describe('harness checkout pointer', () => {
  it('resolves the daily sibling by default with no env and no marker', () => {
    // The repository carries no .generated-harness in git; a clean checkout
    // resolves the documented default name.
    const result = run({ DSH_HARNESS_DIR: undefined })
    expect(result.stdout).toContain('deepseek-harness')
    expect(result.stderr).toBe('')
  })

  it('fails fast with actionable guidance when the env override names a missing checkout', () => {
    const result = run({ DSH_HARNESS_DIR: 'deepseek-harness-does-not-exist' })
    expect(result.stderr).toContain('deepseek-harness-does-not-exist')
    // The error must point at the fix instead of surfacing as a far-away
    // runtime symptom: it names the daily default, lists the harness
    // checkouts that do exist, and references the compatibility doc. The
    // daily sibling is the stable listing anchor; cert copies come and go.
    expect(result.stderr).toContain('deepseek-harness')
    expect(result.stderr).toContain('Harness checkouts that DO exist as siblings')
    expect(result.stderr).toContain('docs/dsh-release-compatibility.md')
  })

  describe('generated marker precedence', () => {
    const roots: string[] = []
    afterEach(async () => {
      await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
    })

    // The marker is read at import time against the script's own project
    // root, so each case runs a copy from a throwaway root with hand-built
    // sibling checkouts instead of touching the repo's untracked marker
    // while parallel workers resolve their imports.
    const runIsolated = async (options: { marker?: string; checkouts?: readonly string[]; env?: Record<string, string> }) => {
      const root = await mkdtemp(join(tmpdir(), 'harness-dir-'))
      roots.push(root)
      const projectRoot = join(root, 'repo')
      await mkdir(join(projectRoot, 'scripts'), { recursive: true })
      await copyFile(join(process.cwd(), 'scripts', 'harness-dir.mjs'), join(projectRoot, 'scripts', 'harness-dir.mjs'))
      for (const name of options.checkouts ?? []) await mkdir(join(root, name))
      if (options.marker !== undefined) await writeFile(join(projectRoot, '.generated-harness'), options.marker)
      const environment: Record<string, string> = { PATH: process.env.PATH ?? '' }
      for (const [key, value] of Object.entries(options.env ?? {})) environment[key] = value
      // A file URL survives the -e string literal on every platform; a raw
      // Windows path's backslashes would be read as escapes.
      const scriptUrl = pathToFileURL(join(projectRoot, 'scripts', 'harness-dir.mjs')).href
      try {
        const stdout = execFileSync(process.execPath, ['-e', `import(${JSON.stringify(scriptUrl)}).then(m => console.log(m.harnessName))`], {
          env: environment,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        return { stdout, stderr: '' }
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string }
        return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
      }
    }

    it('resolves the checkout the marker names before the daily default', async () => {
      const result = await runIsolated({ marker: 'checkout-from-marker', checkouts: ['checkout-from-marker'] })
      expect(result.stdout).toContain('checkout-from-marker')
    })

    it('prefers the env override over a marker naming an existing checkout', async () => {
      const result = await runIsolated({
        marker: 'checkout-from-marker', checkouts: ['checkout-from-marker'],
        env: { DSH_HARNESS_DIR: 'checkout-from-env-missing' },
      })
      expect(result.stderr).toContain('DSH_HARNESS_DIR points the harness resolution')
      expect(result.stderr).toContain('checkout-from-env-missing')
    })

    it('fails fast when the marker names a checkout that no longer exists', async () => {
      const result = await runIsolated({ marker: 'checkout-from-marker-missing' })
      expect(result.stderr).toContain("The tsconfig facades were generated against 'checkout-from-marker-missing'")
    })
  })
})
