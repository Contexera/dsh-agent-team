/**
 * The one place that counts and cuts characters: a ceiling counts code points, and a shortening honours the
 * same boundary, so no astral character is ever halved.
 */
import { describe, expect, it } from 'vitest'
import { characterLength, truncateToCharacters } from '../src/text.ts'

/** A string holding a UTF-16 surrogate that no code point produced: the trace a cut through an astral character leaves. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe('character counting and cutting', () => {
  it('counts a character that occupies two UTF-16 units as one', () => {
    expect(characterLength('🎈')).toBe(1)
    expect('🎈'.length).toBe(2)
    expect(characterLength('🎈'.repeat(200))).toBe(200)
    expect(characterLength('plain')).toBe(5)
    expect(characterLength('')).toBe(0)
  })

  it('cuts on a code-point boundary, never between the halves of one', () => {
    const balloons = '🎈'.repeat(9)
    expect(truncateToCharacters(balloons, 5)).toBe('🎈'.repeat(5))
    expect(characterLength(truncateToCharacters(balloons, 5))).toBe(5)
    // The same cut one code point earlier used to be the one that split a character, because a leading
    // ASCII unit shifts every astral character onto an odd boundary.
    const shifted = `a${balloons}`
    const cut = truncateToCharacters(shifted, 4)
    expect(cut).toBe(`a${'🎈'.repeat(3)}`)
    expect(LONE_SURROGATE.test(cut)).toBe(false)
  })

  it('leaves a string within the limit untouched, and an empty limit empty', () => {
    const body = '🎈 plain body'
    expect(truncateToCharacters(body, characterLength(body))).toBe(body)
    expect(truncateToCharacters(body, 1000)).toBe(body)
    expect(truncateToCharacters(body, 0)).toBe('')
  })
})
