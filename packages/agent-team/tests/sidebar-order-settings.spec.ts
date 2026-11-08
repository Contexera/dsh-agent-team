/**
 * The sidebar row order as a Host-row setting: one versioned map of list keys to
 * refs, written by the Human's own drag and read back by the Client. Presentation
 * only — never a Team fact, never an Agent tool's argument.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIDEBAR_ORDER,
  SIDEBAR_ORDER_KINDS,
  SIDEBAR_ORDER_MAX_REFS,
  SIDEBAR_ORDER_SETTINGS_SCHEMA,
  readableSidebarOrders,
  sanitizeSidebarOrderRefs,
  sidebarOrderKey,
  sidebarOrderKeyProblem,
} from '../src/sidebar-order.ts'
import { HOST_ROW_FIELDS, TEAM_HOST_ROW_SETTINGS_SCHEMA, planHostRowWrite, type Config } from '../src/host-row-settings.ts'

const row = (input: unknown): Config => TEAM_HOST_ROW_SETTINGS_SCHEMA(input as never) as unknown as Config

describe('the sidebar order setting', () => {
  it('resolves an unwritten row to an empty order and keeps both list kinds addressable', () => {
    expect(row({}).sidebarOrder.get()).toEqual(DEFAULT_SIDEBAR_ORDER)
    expect(DEFAULT_SIDEBAR_ORDER).toEqual({ version: 1, lists: {} })
    expect(SIDEBAR_ORDER_KINDS).toEqual(['projects', 'agents'])
    // Volatile: one live wrapper per row, so a write reaches the running Host without a remount.
    expect(typeof row({}).sidebarOrder.get).toBe('function')
    expect(SIDEBAR_ORDER_SETTINGS_SCHEMA.meta.volatile).toBe(true)
    expect(SIDEBAR_ORDER_SETTINGS_SCHEMA.dict?.lists?.meta.default).toEqual({})
    expect(SIDEBAR_ORDER_SETTINGS_SCHEMA.dict?.version?.meta.default).toBe(1)
  })

  it('stores what the Human dragged, per Workspace and per list kind', () => {
    const lists = { 'ws-1|projects': ['project:b', 'project:a'], 'ws-1|agents': ['member:2', 'member:1'] }
    expect(row({ sidebarOrder: { version: 1, lists } }).sidebarOrder.get().lists).toEqual(lists)
    // An unknown future version is carried as stored: nothing here reinterprets it.
    expect(row({ sidebarOrder: { version: 7, lists } }).sidebarOrder.get().version).toBe(7)
  })

  it('names one list with a key both sides can judge', () => {
    expect(sidebarOrderKey('ws-1', 'projects')).toBe('ws-1|projects')
    expect(sidebarOrderKey('ws-1', 'agents')).toBe('ws-1|agents')
    expect(sidebarOrderKeyProblem('ws-1|projects')).toBeUndefined()
    expect(sidebarOrderKeyProblem('ws-1|agents')).toBeUndefined()
    expect(sidebarOrderKeyProblem('ws-1|channels')).toMatch(/unknown list kind/)
    expect(sidebarOrderKeyProblem('ws-1')).toMatch(/must be/)
    expect(sidebarOrderKeyProblem('|projects')).toMatch(/must be '<workspaceId>\|<list kind>'/)
    expect(sidebarOrderKeyProblem('ws 1|projects')).toMatch(/unusable Workspace id/)
    expect(sidebarOrderKeyProblem(`${'w'.repeat(200)}|projects`)).toMatch(/over-long Workspace id/)
    expect(sidebarOrderKeyProblem(7)).toMatch(/must be a string/)
  })

  it('accepts an ordered array of short refs and refuses anything else', () => {
    expect(sanitizeSidebarOrderRefs(['project:a', 'project:b'])).toEqual(['project:a', 'project:b'])
    expect(sanitizeSidebarOrderRefs(['project:a', 'project:a', 'project:b'])).toEqual(['project:a', 'project:b'])
    expect(() => sanitizeSidebarOrderRefs('project:a')).toThrow(/must be an array/)
    expect(() => sanitizeSidebarOrderRefs([1])).toThrow(/non-empty string/)
    expect(() => sanitizeSidebarOrderRefs([''])).toThrow(/non-empty string/)
    expect(() => sanitizeSidebarOrderRefs(['project a'])).toThrow(/whitespace/)
    expect(() => sanitizeSidebarOrderRefs([`x${'y'.repeat(300)}`])).toThrow(/too long/)
    expect(() => sanitizeSidebarOrderRefs(Array.from({ length: SIDEBAR_ORDER_MAX_REFS + 1 }, (_, index) => `project:${index}`)))
      .toThrow(/at most/)
  })

  it('drops unusable stored entries instead of failing the read', () => {
    expect(readableSidebarOrders({
      'ws-1|projects': ['project:a'],
      'ws-1|channels': ['channel:a'],
      'ws-1|agents': ['member:1', 'member:1'],
      'ws-1|other': ['x'],
      'ws-1|projects-deleted-but-bad': 'not-an-array' as never,
    })).toEqual({
      'ws-1|projects': ['project:a'],
      'ws-1|agents': ['member:1'],
    })
  })

  it('is a field the row migration knows, so a carried group arrives complete', () => {
    expect(HOST_ROW_FIELDS).toContain('sidebarOrder')
    const carried = { version: 1, lists: { 'ws-1|projects': ['project:b', 'project:a'] } }
    expect(planHostRowWrite({}, { sidebarOrder: carried })).toEqual({ sidebarOrder: carried })
    expect(planHostRowWrite({}, { sidebarOrder: {} })).toEqual({ sidebarOrder: DEFAULT_SIDEBAR_ORDER })
    // The Human's own stored order is never overwritten by a carried one.
    expect(planHostRowWrite({ sidebarOrder: carried }, { sidebarOrder: { version: 1, lists: {} } })).toBeUndefined()
    expect(planHostRowWrite({}, { sidebarOrder: 'not-a-group' })).toBeUndefined()
  })
})
