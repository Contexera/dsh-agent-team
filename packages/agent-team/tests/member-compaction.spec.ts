import { describe, expect, it } from 'vitest'
import { MEMBER_COMPACT_TOKENS, memberCompactionThreshold, memberOutputTokens } from '../src/member-compaction.ts'

describe('Member request budgets', () => {
  it('caps large windows without moving a configured small budget back up', () => {
    expect(memberCompactionThreshold(MEMBER_COMPACT_TOKENS, 2_000_000)).toBe(256_000)
    expect(memberCompactionThreshold(100_000, 1_000_000)).toBe(100_000)
    expect(memberCompactionThreshold(256_000, undefined)).toBe(256_000)
  })

  it('uses the window ratio for small models, not their maximum output capability', () => {
    expect(memberCompactionThreshold(256_000, 272_000)).toBe(217_600)
    expect(memberCompactionThreshold(256_000, 262_144)).toBe(209_715)
    expect(memberCompactionThreshold(256_000, 32_768)).toBe(16_384)
  })

  it('declines a window that cannot hold its own fixed reserve', () => {
    expect(memberCompactionThreshold(256_000, 16_384)).toBeUndefined()
    expect(memberCompactionThreshold(256_000, 8_000)).toBeUndefined()
  })

  it('reduces a large output allowance without raising an explicit small one', () => {
    expect(memberOutputTokens(217_600, 272_000, 128_000)).toBe(50_304)
    expect(memberOutputTokens(217_600, 272_000, 8_192)).toBe(8_192)
    expect(() => memberOutputTokens(272_000, 272_000, 128_000)).toThrow('no safe output space')
  })
})
