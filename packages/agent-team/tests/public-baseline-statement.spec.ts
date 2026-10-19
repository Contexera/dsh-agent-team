import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { baselineStatement } from '../../../scripts/public-baseline-statement.mjs'

const root = join(import.meta.dirname, '../../..')

describe('certified-baseline statement parser', () => {
  it('reads the first inline-code span after the marker', () => {
    expect(baselineStatement('This release is certified against DSH `0.2.0-rc.2`. Install it explicitly.', 'certified against DSH'))
      .toBe('0.2.0-rc.2')
  })

  it('tolerates prose between the marker and the token', () => {
    expect(baselineStatement('当前版本已针对 DSH `0.2.0-rc.2` 完成认证。', '针对 DSH')).toBe('0.2.0-rc.2')
  })

  it('ignores versions named after the first token, so a compatibility footnote cannot win', () => {
    const line = 'This release is certified against DSH `0.2.0-rc.2`. On DSH `0.1.7-rc.2`, stay on `0.1.15`.'
    expect(baselineStatement(line, 'certified against DSH')).toBe('0.2.0-rc.2')
  })

  it('answers undefined when the marker is gone, the token is not inline code, or nothing follows', () => {
    expect(baselineStatement('This release targets DSH `0.2.0-rc.2`.', 'certified against DSH')).toBeUndefined()
    expect(baselineStatement('This release is certified against DSH 0.2.0-rc.2.', 'certified against DSH')).toBeUndefined()
    expect(baselineStatement('This release is certified against DSH', 'certified against DSH')).toBeUndefined()
  })

  it('does not carry the marker across a line break', () => {
    expect(baselineStatement('certified against\nDSH `0.2.0-rc.2`', 'certified against DSH')).toBeUndefined()
  })

  it('reads the certified baseline the shipped README pair actually states', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { peerDependencies: Record<string, string> }
    const range = Object.entries(manifest.peerDependencies).find(([name]) => name.startsWith('@deepseek-ai/dsh-'))?.[1] ?? ''
    const baseline = /^>=([^ ]+) </.exec(range)?.[1]
    expect(baseline).toBeDefined()
    for (const [file, marker] of [['README.md', 'certified against DSH'], ['README.zh.md', '针对 DSH']] as const) {
      expect(baselineStatement(readFileSync(join(root, file), 'utf8'), marker), `${file} must state the certified baseline`).toBe(baseline)
    }
  })
})
