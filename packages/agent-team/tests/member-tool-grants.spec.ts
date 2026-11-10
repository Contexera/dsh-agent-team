import z from '@deepseek-ai/schemastery'
import { describe, expect, it } from 'vitest'
import { extraToolGrantsFrom, sanitizeExtraToolGrants } from '../src/member-tool-grants.ts'
import {
  HOST_ROW_FIELDS, TEAM_HOST_ROW_SETTINGS_SCHEMA, planHostRowWrite, type Config,
} from '../src/host-row-settings.ts'

function row(input: unknown): Config {
  return TEAM_HOST_ROW_SETTINGS_SCHEMA(input as never) as unknown as Config
}

function serializedRow(input: unknown): Config {
  // The Host reconstructs a schema while deriving its editable form, then
  // serializes that copy for the Client; one JSON round trip misses this path.
  const hostSchema: z = TEAM_HOST_ROW_SETTINGS_SCHEMA
  const editable = new z(hostSchema.toJSON())
  const serialized = JSON.parse(JSON.stringify(editable.toJSON()))
  return new z(serialized)(input as never) as unknown as Config
}

const EXACT_NAMES = ['Beta', 'beta', 'has space', 'has\u007fcontrol', ' tool ', '𠮷'.repeat(201)]
const MANY_NAMES = Array.from({ length: 201 }, (_, index) => `tool_${index}`)

describe('profile extra tool-name grants', () => {
  it('keeps exact case, collapses duplicates, and returns an immutable owned list', () => {
    const names = sanitizeExtraToolGrants(['Beta', 'beta', 'Beta', 'project_list'])
    expect(names).toEqual(['Beta', 'beta', 'project_list'])
    expect(Object.isFrozen(names)).toBe(true)
    expect(extraToolGrantsFrom(['Beta', 'beta'])).toEqual(['Beta', 'beta'])
  })

  it.each([{ names: EXACT_NAMES }, { names: MANY_NAMES }])('does not invent a name grammar or grant quota', ({ names }) => {
    expect(sanitizeExtraToolGrants(names)).toEqual(names)
    expect(extraToolGrantsFrom(names)).toEqual(names)
    expect(row({ extraToolGrants: names }).extraToolGrants.get()).toEqual(names)
    expect(serializedRow({ extraToolGrants: names }).extraToolGrants.get()).toEqual(names)
  })

  it('refuses malformed and empty names', () => {
    expect(() => sanitizeExtraToolGrants([''])).toThrow()
    for (const extraToolGrants of ['Alpha', ['valid', 7], ['']]) {
      expect(extraToolGrantsFrom(extraToolGrants)).toBeUndefined()
      expect(() => row({ extraToolGrants })).toThrow()
      expect(() => serializedRow({ extraToolGrants })).toThrow()
    }
    expect(extraToolGrantsFrom(undefined)).toBeUndefined()
    expect(extraToolGrantsFrom(null)).toBeUndefined()
  })

  it('resolves an absent row field to an empty volatile list', () => {
    expect(row({}).extraToolGrants.get()).toEqual([])
    expect(TEAM_HOST_ROW_SETTINGS_SCHEMA.dict?.extraToolGrants?.meta.volatile).toBe(true)
    expect(TEAM_HOST_ROW_SETTINGS_SCHEMA.dict?.extraToolGrants?.meta.default).toEqual([])
  })

  it('validates the settings write with the same exact-name rules', () => {
    const input = { extraToolGrants: ['Beta', 'beta', 'Beta'] }
    const stored = row(input).extraToolGrants.get()
    expect(stored).toEqual(input.extraToolGrants)
    expect(serializedRow(input).extraToolGrants.get()).toEqual(stored)
    expect(sanitizeExtraToolGrants(stored)).toEqual(['Beta', 'beta'])
  })

  it.each([
    { label: 'absent', input: {}, expected: [] },
    { label: 'empty', input: { extraToolGrants: [] }, expected: [] },
    { label: 'nonempty', input: { extraToolGrants: ['Alpha'] }, expected: ['Alpha'] },
  ])('keeps the serialized settings row readable with $label grants', ({ input, expected }) => {
    const parsed = serializedRow(input)
    expect(parsed.extraToolGrants.get()).toEqual(expected)
    expect(parsed.worker.get()).toEqual(row(input).worker.get())
    expect(parsed.memberCompaction.get()).toEqual(row(input).memberCompaction.get())
    expect(parsed.wakeRecycle.get()).toEqual(row(input).wakeRecycle.get())
  })

  it('carries only a valid legacy list into a current row gap', () => {
    expect(HOST_ROW_FIELDS).toContain('extraToolGrants')
    expect(planHostRowWrite({}, { extraToolGrants: ['Beta', 'Beta'] }))
      .toEqual({ extraToolGrants: ['Beta'] })
    expect(planHostRowWrite({}, { extraToolGrants: [] })).toEqual({ extraToolGrants: [] })
    expect(planHostRowWrite({ extraToolGrants: [] }, { extraToolGrants: ['Beta'] })).toBeUndefined()
    expect(planHostRowWrite({}, { extraToolGrants: [''] })).toBeUndefined()
  })
})
