import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('comment hygiene gate', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'comment-gate-'))
    for (const path of ['scripts', 'packages/example/src', 'packages/example/tests']) {
      mkdirSync(join(root, path), { recursive: true })
    }
    copyFileSync(resolve('scripts/check-comments.mjs'), join(root, 'scripts/check-comments.mjs'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const run = (source: string, path = 'packages/example/src/example.ts') => {
    writeFileSync(join(root, path), source)
    return spawnSync(process.execPath, [join(root, 'scripts/check-comments.mjs')], { encoding: 'utf8' })
  }

  it.each(['TODO', 'FIXME', 'XXX', 'HACK', 'TBD'])('rejects the %s work marker in tests', marker => {
    const result = run(`/** ${marker}: follow up */`, 'packages/example/tests/example.ts')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('leftover work marker: file an issue or do it')
  })

  it.each(['const x = 1;', 'let x = 1;', 'var x = 1;', 'import x from "x";',
    'export { x };', 'return x;', 'await run();', 'throw error;', 'if (x) {',
    'for (;;) {', 'while (x)', 'foo.bar(x);', 'run()', 'x.y = 1;'])('rejects disabled code: %s', code => {
    const result = run(`// ${code}`)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('commented-out code')
  })

  it.each(['// eslint-disable-next-line no-console', '/* oxlint-disable rule */',
    '// @ts-ignore', '// @ts-nocheck', '// @ts-expect-error', '// @ts-expect-error:'])('rejects unexplained suppressions: %s', comment => {
    expect(run(comment).status).toBe(1)
  })

  it.each(['// Read the task names', '/** Read the task names */'])('rejects a restating label: %s', comment => {
    const result = run(`${comment}\nreadTaskName()`)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('comment restates the next line')
  })

  it('accepts empty files and explanations, preserving test and vendor exclusions', () => {
    expect(run('').status).toBe(0)
    expect(run([
      '// let you address.',
      '// TODOISH is not a marker; todo is ordinary prose.',
      '// eslint-disable-next-line no-console -- The CLI reports to stdout.',
      '/* oxlint-disable rule -- This boundary needs the exception. */',
      '// @ts-expect-error: The fixture exercises an invalid request.',
      'invalidRequest()',
      '// @ts-expect-error -- The fixture also exercises the alternate boundary.',
      'invalidBoundary()',
      '',
      '// The protocol requires an explicit sentinel.',
      'return null',
      '',
      '// Read task names',
      '// Keep the ordering stable across reconnects.',
      'readTaskNames()',
    ].join('\n')).status).toBe(0)
    expect(run('// Read task names\nreadTaskNames()', 'packages/example/tests/example.ts').status).toBe(0)
    mkdirSync(join(root, 'packages/example/src/vendor'))
    expect(run('// TODO', 'packages/example/src/vendor/ignored.ts').status).toBe(0)
  })

  it('preserves reference checks and reports budgets without deciding', () => {
    expect(run('// See .scratch/active/example').stderr).toContain('cites a reference that cannot resolve')
    const output = execFileSync(process.execPath, [join(root, 'scripts/check-comments.mjs'), '--budgets'], { encoding: 'utf8' })
    expect(output).toContain('packages/example/src')
    expect(output).not.toContain('packages/example/tests')
  })
})
