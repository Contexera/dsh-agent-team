import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The boundary gate reads real source trees, so it is driven through its own CLI against a fixture
 * repository: a passing fixture must exit 0 and a failing one must exit 1 naming the escaping file and
 * line. Running the checker as a child process is what makes a fixture meaningful — importing it would
 * let a shared module cache or an in-process `process.exit` decide the result.
 */
const run = promisify(execFile)
const script = fileURLToPath(new URL('../../../scripts/check-package-boundaries.mjs', import.meta.url))

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'package-boundaries-'))
  await mkdir(join(root, 'packages', 'a', 'src'), { recursive: true })
  await mkdir(join(root, 'packages', 'b', 'src'), { recursive: true })
  await writeFile(join(root, 'packages', 'b', 'src', 'dep.ts'), 'export const dependency = 1\n')
  await writeFile(join(root, 'packages', 'a', 'src', 'sibling.ts'), 'export const sibling = 1\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const source = (name: string, text: string): Promise<void> =>
  writeFile(join(root, 'packages', 'a', 'src', name), text)

// The checker prints paths through `node:path`, so a violation names the file with the platform
// separator. Comparing against a literal forward-slash string passes on Linux and fails on Windows.
const violation = (file: string): string => `packages${sep}a${sep}src${sep}${file}`

const check = async (): Promise<{ code: number; output: string }> => {
  try {
    const { stdout } = await run(process.execPath, [script, '--root', root])
    return { code: 0, output: stdout }
  } catch (error) {
    const failure = error as { code?: number; stderr?: string; stdout?: string }
    return { code: failure.code ?? -1, output: failure.stderr ?? failure.stdout ?? '' }
  }
}

describe('package boundary check', () => {
  it('refuses a relative import that leaves its own package', async () => {
    await source('plain.ts', "import { dependency } from '../../b/src/dep'\nexport const used = dependency\n")
    const result = await check()
    expect(result.code).toBe(1)
    expect(result.output).toContain(`${violation('plain.ts')}:1 imports '../../b/src/dep'`)
  })

  it('refuses a re-export that leaves its own package', async () => {
    await source('reexport.ts', "export { dependency } from '../../b/src/dep'\n")
    expect(await check()).toMatchObject({ code: 1 })
  })

  it('refuses a star re-export that leaves its own package', async () => {
    await source('star.ts', "export * from '../../b/src/dep'\n")
    expect(await check()).toMatchObject({ code: 1 })
  })

  it('refuses a side-effect import that leaves its own package', async () => {
    await source('side-effect.ts', "import '../../b/src/dep'\n")
    expect(await check()).toMatchObject({ code: 1 })
  })

  it('refuses a dynamic import that leaves its own package', async () => {
    await source('dynamic.ts', "export const loaded = import('../../b/src/dep')\n")
    const result = await check()
    expect(result.code).toBe(1)
    expect(result.output).toContain(`${violation('dynamic.ts')}:1 imports '../../b/src/dep'`)
  })

  it('scans the module extensions TypeScript also emits', async () => {
    await source('module.mts', "import { dependency } from '../../b/src/dep'\nexport const used = dependency\n")
    const result = await check()
    expect(result.code).toBe(1)
    expect(result.output).toContain(`${violation('module.mts')}:1`)
  })

  it('allows a relative specifier that stays inside its own package', async () => {
    await source('internal.ts', "import { sibling } from './sibling.ts'\nexport const used = sibling\n")
    await source('climbs.ts', "import { sibling } from '../src/sibling.ts'\nexport const used = sibling\n")
    // The scanned count is the fixture's own, so a checker that ignored --root and walked this
    // repository instead cannot pass by finding nothing to refuse.
    const result = await check()
    expect(result).toMatchObject({ code: 0 })
    expect(result.output).toContain('4 source file(s) in 2 package(s)')
  })

  it('allows a declaration that binds no value', async () => {
    await source('type-only.ts', "import type { Missing } from '../../b/src/dep'\nexport const used: Missing = 1 as never\n")
    await source('inline-type.ts', "import { type Missing } from '../../b/src/dep'\nexport const used = 1\n")
    await source('type-reexport.ts', "export type { Missing } from '../../b/src/dep'\n")
    await source('namespace-type.ts', "import type * as everything from '../../b/src/dep'\nexport const used = everything\n")
    const result = await check()
    expect(result).toMatchObject({ code: 0 })
    expect(result.output).toContain('6 source file(s) in 2 package(s)')
  })

  it('refuses a mixed import that binds a value alongside a type', async () => {
    await source('mixed.ts', "import { dependency, type Missing } from '../../b/src/dep'\nexport const used = dependency\n")
    const result = await check()
    expect(result.code).toBe(1)
    expect(result.output).toContain(`${violation('mixed.ts')}:1`)
  })

  it('reads references from the syntax tree, not from text that quotes one', async () => {
    await source('comment.ts', "// import { dependency } from '../../b/src/dep'\nexport const used = 1\n")
    await source('block-comment.ts', "/*\nimport { dependency } from '../../b/src/dep'\n*/\nexport const used = 1\n")
    await source('string.ts', "const quoted = \"import { dependency } from '../../b/src/dep'\"\nexport const used = quoted\n")
    const result = await check()
    expect(result).toMatchObject({ code: 0 })
    expect(result.output).toContain('5 source file(s) in 2 package(s)')
  })
})
