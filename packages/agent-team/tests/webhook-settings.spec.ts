/**
 * The webhook deployment setting: where an outside service reaches the hook
 * listener. It lives on the Host row rather than in the Team ledger because a
 * tunnel or reverse proxy decides it, and it is volatile like the row's other
 * groups, so the settings form is where a Human writes it.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WEBHOOK_CONFIG,
  HOST_ROW_FIELDS,
  TEAM_HOST_ROW_SETTINGS_SCHEMA,
  WEBHOOK_SETTINGS_SCHEMA,
  planHostRowWrite,
  type Config,
} from '../src/host-row-settings.ts'
import { webhookOriginRefusal } from '../src/subscription-webhook.ts'

const row = (input: unknown): Config => TEAM_HOST_ROW_SETTINGS_SCHEMA(input as never) as unknown as Config

describe('the webhook public address setting', () => {
  it('resolves an unconfigured row to no origin and a configured one to what the Human wrote', () => {
    expect(DEFAULT_WEBHOOK_CONFIG.publicOrigin, 'an unconfigured address is empty, never a guess').toBe('')
    expect(row({}).webhook.get()).toEqual(DEFAULT_WEBHOOK_CONFIG)
    expect(row({ webhook: { publicOrigin: 'https://team.example.com' } }).webhook.get())
      .toEqual({ publicOrigin: 'https://team.example.com' })
    // Volatile: the value is a live wrapper the settings service can replace per
    // row, not a plain string captured at construction.
    expect(typeof row({}).webhook.get).toBe('function')
    expect(WEBHOOK_SETTINGS_SCHEMA({}).get()).toEqual(DEFAULT_WEBHOOK_CONFIG)
  })

  it('is a field the row migration knows, so an older namespace can carry it forward', () => {
    expect(HOST_ROW_FIELDS).toContain('webhook')
    expect(planHostRowWrite({}, { webhook: { publicOrigin: 'https://carried.example' } }))
      .toEqual({ webhook: { publicOrigin: 'https://carried.example' } })
    // A partial group arrives complete rather than leaving the missing field to
    // a stale schema default.
    expect(planHostRowWrite({}, { webhook: {} })).toEqual({ webhook: { publicOrigin: '' } })
    // A stored value is the Human's own choice and is never overwritten.
    expect(planHostRowWrite({ webhook: { publicOrigin: 'https://stored.example' } }, { webhook: { publicOrigin: 'https://carried.example' } }))
      .toBeUndefined()
    expect(planHostRowWrite({}, { webhook: 'not-a-group' })).toBeUndefined()
  })

  it('names the setting to write when it is missing, and the problem when it is unusable', () => {
    expect(webhookOriginRefusal('')).toMatch(/set webhook\.publicOrigin in the Team settings/)
    expect(webhookOriginRefusal('   ')).toMatch(/not configured/)
    expect(webhookOriginRefusal('https://team.example.com')).toBeUndefined()
    expect(webhookOriginRefusal('https://team.example.com/team')).toMatch(/must be an origin, without a path/)
    expect(webhookOriginRefusal('team.example.com')).toMatch(/not an absolute URL/)
  })
})
