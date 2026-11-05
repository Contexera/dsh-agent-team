/**
 * The subscription contract that runs before any Host exists: what a script
 * snapshot is, what stdout may say, which environment a run gets, and when a
 * timer tick may run.
 */
import { describe, expect, it } from 'vitest'
import {
  credentialsProblem,
  nameProblem,
  parseSubscriptionOutput,
  scheduleAction,
  scriptHash,
  snapshotScript,
  SUBSCRIPTION_PENDING_MAX,
  SUBSCRIPTION_SCRIPT_MAX_BYTES,
  subscriptionRunEnvironment,
  subscriptionTestStdin,
  triggersProblem,
} from '../src/subscriptions.ts'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('script snapshots', () => {
  it('hashes the exact bytes and keeps the shell it was recorded under', () => {
    const result = snapshotScript('echo hi\n', 'bash')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.script).toEqual({ content: 'echo hi\n', sha256: scriptHash('echo hi\n'), shell: 'bash' })
    expect(result.script.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('measures the size limit in bytes, not characters', () => {
    const filler = 'é'.repeat(SUBSCRIPTION_SCRIPT_MAX_BYTES / 2)
    expect(Buffer.byteLength(filler, 'utf8')).toBe(SUBSCRIPTION_SCRIPT_MAX_BYTES)
    expect(snapshotScript(filler, 'bash').ok).toBe(true)
    expect(snapshotScript(`${filler}é`, 'bash')).toEqual({
      ok: false,
      reason: `the script is ${SUBSCRIPTION_SCRIPT_MAX_BYTES + 2} bytes; the limit is ${SUBSCRIPTION_SCRIPT_MAX_BYTES}`,
    })
  })

  it('refuses an empty script', () => {
    expect(snapshotScript('   \n', 'pwsh')).toEqual({ ok: false, reason: 'the script is empty' })
  })
})

describe('the output contract', () => {
  it('reads one object per line and ignores empty lines', () => {
    const result = parseSubscriptionOutput(bytes('{"id":"a","title":"A"}\n\n{"id":"b","title":"B","url":"https://example.test/b","detail":"d"}\n'))
    expect(result).toEqual({ ok: true, events: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B', url: 'https://example.test/b', detail: 'd' },
    ] })
  })

  it('accepts CRLF line endings and a missing final newline', () => {
    expect(parseSubscriptionOutput(bytes('{"id":"a","title":"A"}\r\n{"id":"b","title":"B"}'))).toEqual({
      ok: true, events: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    })
  })

  it('refuses a byte-order mark', () => {
    const result = parseSubscriptionOutput(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('{"id":"a","title":"A"}')]))
    expect(result).toEqual({ ok: false, reason: 'the output starts with a UTF-8 byte-order mark' })
  })

  it('refuses bytes that are not UTF-8 instead of letting them decode to replacement characters', () => {
    const result = parseSubscriptionOutput(new Uint8Array([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]))
    expect(result).toEqual({ ok: false, reason: 'the output is not valid UTF-8' })
  })

  it('refuses duplicate keys inside one object', () => {
    expect(parseSubscriptionOutput(bytes('{"id":"a","id":"b","title":"A"}'))).toEqual({
      ok: false, reason: "line 1: the key 'id' appears twice",
    })
  })

  it('names the offending line so an owner can find it', () => {
    expect(parseSubscriptionOutput(bytes('{"id":"a","title":"A"}\nnot json\n'))).toEqual({
      ok: false, reason: 'line 2: a value is missing',
    })
  })

  it('requires id and title, and bounds them in characters', () => {
    expect(parseSubscriptionOutput(bytes('{"title":"A"}'))).toEqual({ ok: false, reason: 'line 1: every event needs a non-empty string id' })
    expect(parseSubscriptionOutput(bytes('{"id":"a"}'))).toEqual({ ok: false, reason: 'line 1: every event needs a non-empty string title' })
    const long = 'x'.repeat(201)
    expect(parseSubscriptionOutput(bytes(JSON.stringify({ id: long, title: 'A' })))).toEqual({
      ok: false, reason: 'line 1: the id is longer than 200 characters',
    })
    // Code points, not UTF-16 units: 200 astral characters are 200 characters, 400 units, so the id passes.
    expect(parseSubscriptionOutput(bytes(JSON.stringify({ id: '🎈'.repeat(200), title: 'A' })))).toMatchObject({ ok: true })
  })

  it('bounds detail and requires an http(s) url', () => {
    expect(parseSubscriptionOutput(bytes(JSON.stringify({ id: 'a', title: 'A', url: 'ftp://x' })))).toEqual({
      ok: false, reason: 'line 1: url must be an http(s) address',
    })
    expect(parseSubscriptionOutput(bytes(JSON.stringify({ id: 'a', title: 'A', detail: 'd'.repeat(2001) })))).toEqual({
      ok: false, reason: 'line 1: the detail is longer than 2000 characters',
    })
  })

  it('ignores unknown keys', () => {
    expect(parseSubscriptionOutput(bytes('{"id":"a","title":"A","severity":"high"}'))).toEqual({ ok: true, events: [{ id: 'a', title: 'A' }] })
  })

  it('refuses a prototype key instead of forging an event out of inherited fields', () => {
    // `{"__proto__": …}` through a plain object lands in the interpreter's
    // setter: the record then *inherits* id/title and the run looks accepted.
    expect(parseSubscriptionOutput(bytes('{"__proto__":{"id":"forged","title":"Forged"}}'))).toEqual({
      ok: false, reason: "line 1: the key '__proto__' is not a plain object member",
    })
    expect(parseSubscriptionOutput(bytes('{"id":"a","title":"A","__proto__":{"id":"forged"}}'))).toEqual({
      ok: false, reason: "line 1: the key '__proto__' is not a plain object member",
    })
  })

  it('applies the JSON number grammar, not what Number() happens to accept', () => {
    // `Number()` reads every one of these as a number; RFC 8259 does not.
    for (const literal of ['01', '+1', '.5', '1.']) {
      expect(parseSubscriptionOutput(bytes(`{"id":"a","title":"A","count":${literal}}`))).toEqual({
        ok: false, reason: `line 1: '${literal}' is not a JSON number`,
      })
    }
    expect(parseSubscriptionOutput(bytes('{"id":"a","title":"A","count":-1.5e3}'))).toEqual({ ok: true, events: [{ id: 'a', title: 'A' }] })
  })

  it('refuses an explicit null url or detail instead of reading it as absent', () => {
    expect(parseSubscriptionOutput(bytes('{"id":"a","title":"A","url":null}'))).toEqual({ ok: false, reason: 'line 1: url must be a string' })
    expect(parseSubscriptionOutput(bytes('{"id":"a","title":"A","detail":null}'))).toEqual({ ok: false, reason: 'line 1: detail must be a string' })
  })

  it('collapses an identical id twice but refuses the same id with a different payload', () => {
    expect(parseSubscriptionOutput(bytes('{"id":"a","title":"A"}\n{"id":"a","title":"A"}'))).toEqual({ ok: true, events: [{ id: 'a', title: 'A' }] })
    expect(parseSubscriptionOutput(bytes('{"id":"a","title":"A"}\n{"id":"a","title":"B"}'))).toEqual({
      ok: false, reason: "line 2: id 'a' repeats with a different payload",
    })
  })
})

describe('subscription definitions', () => {
  it('needs a trigger, a whole interval, and at least the minimum interval', () => {
    expect(triggersProblem({})).toBe('a subscription needs at least one trigger')
    expect(triggersProblem({ interval: { minutes: 4 } })).toBe('interval minutes must be at least 5')
    expect(triggersProblem({ interval: { minutes: 5.5 } })).toBe('interval minutes must be a whole number')
    expect(triggersProblem({ interval: { minutes: 5 } })).toBeUndefined()
    expect(triggersProblem({ webhook: true })).toBeUndefined()
  })

  it('bounds the name in characters', () => {
    expect(nameProblem('  ')).toBe('the subscription needs a name')
    expect(nameProblem('x'.repeat(81))).toBe('the name is 81 characters; the limit is 80')
    expect(nameProblem('main CI')).toBeUndefined()
  })

  it('refuses a credential mapping the run could not honour', () => {
    expect(credentialsProblem([{ ref: 'GH_TOKEN', env: 'GH_TOKEN' }])).toBeUndefined()
    expect(credentialsProblem([{ ref: 'not-a-ref', env: 'X' }])).toBe("'not-a-ref' is not a valid credential reference")
    expect(credentialsProblem([{ ref: 'A', env: '1BAD' }])).toBe("'1BAD' is not a valid environment variable name")
    expect(credentialsProblem([{ ref: 'A', env: 'DSH_TEAM_PROJECT' }])).toBe("'DSH_TEAM_PROJECT' uses the Host's reserved DSH_TEAM_ prefix")
    expect(credentialsProblem([{ ref: 'A', env: 'A' }, { ref: 'A', env: 'B' }])).toBe("credential reference 'A' is listed twice")
    expect(credentialsProblem([{ ref: 'A', env: 'C' }, { ref: 'B', env: 'C' }])).toBe("environment variable 'C' is mapped twice")
    expect(credentialsProblem(Array.from({ length: 9 }, (_, index) => ({ ref: `R${index}`, env: `E${index}` }))))
      .toBe('a subscription may declare at most 8 credentials')
  })
})

describe('the run environment', () => {
  it('always carries the Host facts and merges the resolved credentials after them', () => {
    expect(subscriptionRunEnvironment({ projectRef: 'project:p', subscriptionRef: 'subscription:s', trigger: 'interval',
      lastSuccessAt: '2026-11-03T01:00:00.000Z', resolved: { GH_TOKEN: 'secret' } })).toEqual({
      DSH_TEAM_PROJECT: 'project:p',
      DSH_TEAM_SUBSCRIPTION: 'subscription:s',
      DSH_TEAM_TRIGGER: 'interval',
      DSH_TEAM_LAST_SUCCESS_AT: '2026-11-03T01:00:00.000Z',
      GH_TOKEN: 'secret',
    })
  })

  it('reports "never succeeded" as an empty instant rather than an absent variable', () => {
    expect(subscriptionRunEnvironment({ projectRef: 'project:p', subscriptionRef: 'subscription:s', trigger: 'test', resolved: {} }))
      .toMatchObject({ DSH_TEAM_LAST_SUCCESS_AT: '', DSH_TEAM_TRIGGER: 'test' })
  })

  it('ships a test envelope a webhook-only script can reject on its own terms', () => {
    expect(JSON.parse(subscriptionTestStdin())).toEqual({
      headers: { 'content-type': 'application/json', 'x-team-event': 'test', 'x-team-delivery': 'test' },
      body: '{"test":true}',
    })
  })
})

describe('the timer decision', () => {
  const base = { now: 1_000, dueAt: 900, paused: false, deleted: false, archived: false, pending: 0, busy: false }

  it('runs a due subscription', () => {
    expect(scheduleAction(base)).toBe('run')
  })

  it('waits before the due instant and skips a subscription that must not run', () => {
    expect(scheduleAction({ ...base, dueAt: 1_001 })).toBe('wait')
    expect(scheduleAction({ ...base, paused: true })).toBe('skip')
    expect(scheduleAction({ ...base, deleted: true })).toBe('skip')
    expect(scheduleAction({ ...base, archived: true })).toBe('skip')
  })

  it('skips — never fails — while the unpublished backlog is at its ceiling', () => {
    expect(scheduleAction({ ...base, pending: SUBSCRIPTION_PENDING_MAX })).toBe('skip')
    expect(scheduleAction({ ...base, pending: SUBSCRIPTION_PENDING_MAX - 1 })).toBe('run')
  })

  it('waits — never finishes — while the same subscription is already running', () => {
    // A due timer that met its own trial must not be reported as a finished run:
    // the scheduler would clear the failure count and move the due instant.
    expect(scheduleAction({ ...base, busy: true })).toBe('wait')
  })
})
