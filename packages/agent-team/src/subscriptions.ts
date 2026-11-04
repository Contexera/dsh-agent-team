/**
 * Project subscription domain rules that never touch the Host: script
 * snapshots, the output contract, the credential environment, and the
 * scheduling arithmetic. Everything here is pure so a fake clock and a fake
 * executor can drive it directly.
 * @module @contexera/dsh-agent-team/subscriptions
 */

import { createHash } from 'node:crypto'

/** A script snapshot is what runs; the repository file it came from is never read again. */
export const SUBSCRIPTION_SCRIPT_MAX_BYTES = 16 * 1024
export const SUBSCRIPTION_NAME_MAX_CHARACTERS = 80
export const SUBSCRIPTION_EVENT_ID_MAX_CHARACTERS = 200
export const SUBSCRIPTION_EVENT_TITLE_MAX_CHARACTERS = 200
export const SUBSCRIPTION_EVENT_DETAIL_MAX_CHARACTERS = 2000
export const SUBSCRIPTION_EVENT_URL_MAX_CHARACTERS = 2000
/** Below this interval a timer subscription would outrun a person's ability to read its events. */
export const SUBSCRIPTION_MIN_INTERVAL_MINUTES = 5
export const SUBSCRIPTION_MAX_PER_PROJECT = 20
export const SUBSCRIPTION_MAX_CREDENTIALS = 8
/** The one prefix the Host reserves for its own injected variables; a subscription may not write there. */
export const SUBSCRIPTION_ENV_PREFIX = 'DSH_TEAM_'
export const SUBSCRIPTION_RUN_TIMEOUT_MS = 60_000
/** Explicit stdout budget: the executor's own default (64,000) is not this contract. */
export const SUBSCRIPTION_STDOUT_MAX_BYTES = 65_536
/** Team-owned admission, because the Harness executor does not provide one. */
export const SUBSCRIPTION_CONCURRENT_RUNS = 4
export const SUBSCRIPTION_PUBLISH_PER_MINUTE = 20
/** Accepted-but-unpublished ceiling per subscription; a run that would cross it is refused whole. */
export const SUBSCRIPTION_PENDING_MAX = 500
/** Failed runs in a row that pause the subscription. Any success clears the count. */
export const SUBSCRIPTION_FAILURES_BEFORE_PAUSE = 3
/** A boot spreads its first timer runs over this window so twenty subscriptions do not all fire at once. */
export const SUBSCRIPTION_FIRST_RUN_MAX_DELAY_MS = 60_000

/** The shell a snapshot was recorded under; a mismatched live executor fails the run. */
export type SubscriptionShell = 'bash' | 'pwsh'

export interface SubscriptionScriptSnapshot {
  readonly content: string
  readonly sha256: string
  /** Shell family the creating Host ran the trial under; the running executor must agree. */
  readonly shell: SubscriptionShell
}

export interface SubscriptionIntervalTrigger {
  readonly minutes: number
}

export interface SubscriptionTriggers {
  readonly interval?: SubscriptionIntervalTrigger | undefined
  readonly webhook?: true | undefined
}

/** One credential reference the Host resolves per run and injects as an environment name. */
export interface SubscriptionCredential {
  /** Harness credential reference (a POSIX environment-variable name). */
  readonly ref: string
  /** Name it is injected under; never inside the Host's reserved prefix. */
  readonly env: string
}

/** One event exactly as a script printed it. */
export interface SubscriptionEvent {
  readonly id: string
  readonly title: string
  readonly url?: string | undefined
  readonly detail?: string | undefined
}

export type SubscriptionOutput =
  | { readonly ok: true; readonly events: readonly SubscriptionEvent[] }
  | { readonly ok: false; readonly reason: string }

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Code-point length, which is what the contract's character ceilings count. */
export function characterLength(value: string): number {
  return [...value].length
}

/** The identity of one script snapshot: its exact bytes, so an update is visible in the ledger. */
export function scriptHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

const SCRIPT_HASH = /^[0-9a-f]{64}$/

/** The JSON number grammar (RFC 8259 §6), which `Number()` alone does not enforce. */
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/

export function isScriptHash(value: string): boolean {
  return SCRIPT_HASH.test(value)
}

export type ScriptSnapshotResult =
  | { readonly ok: true; readonly script: SubscriptionScriptSnapshot }
  | { readonly ok: false; readonly reason: string }

/**
 * Freeze one script body into the snapshot the ledger stores. The size ceiling
 * applies to the bytes that will be written, not to the characters a person
 * typed: a multi-byte script may cross it earlier.
 */
export function snapshotScript(content: string, shell: SubscriptionShell): ScriptSnapshotResult {
  if (content.trim() === '') return { ok: false, reason: 'the script is empty' }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > SUBSCRIPTION_SCRIPT_MAX_BYTES) {
    return { ok: false, reason: `the script is ${bytes} bytes; the limit is ${SUBSCRIPTION_SCRIPT_MAX_BYTES}` }
  }
  return { ok: true, script: Object.freeze({ content, sha256: scriptHash(content), shell }) }
}

/** Why a trigger set cannot be used, or `undefined` when it can. */
export function triggersProblem(triggers: SubscriptionTriggers): string | undefined {
  const interval = triggers.interval
  if (interval === undefined && triggers.webhook !== true) return 'a subscription needs at least one trigger'
  if (interval !== undefined) {
    if (!Number.isInteger(interval.minutes)) return 'interval minutes must be a whole number'
    if (interval.minutes < SUBSCRIPTION_MIN_INTERVAL_MINUTES) {
      return `interval minutes must be at least ${SUBSCRIPTION_MIN_INTERVAL_MINUTES}`
    }
  }
  return undefined
}

/** Whether a name is usable as a subscription label, and why not when it is not. */
export function nameProblem(name: string): string | undefined {
  const trimmed = name.trim()
  if (trimmed === '') return 'the subscription needs a name'
  if (characterLength(trimmed) > SUBSCRIPTION_NAME_MAX_CHARACTERS) {
    return `the name is ${characterLength(trimmed)} characters; the limit is ${SUBSCRIPTION_NAME_MAX_CHARACTERS}`
  }
  return undefined
}

/**
 * Validate one credential mapping. Both halves name an environment variable —
 * the reference is the Harness lookup key and the environment name is what the
 * script reads — so both follow the same grammar, and the Host's reserved
 * prefix is refused on the destination only.
 */
export function credentialsProblem(credentials: readonly SubscriptionCredential[]): string | undefined {
  if (credentials.length > SUBSCRIPTION_MAX_CREDENTIALS) {
    return `a subscription may declare at most ${SUBSCRIPTION_MAX_CREDENTIALS} credentials`
  }
  const refs = new Set<string>()
  const envs = new Set<string>()
  for (const credential of credentials) {
    if (!ENV_NAME.test(credential.ref)) return `'${credential.ref}' is not a valid credential reference`
    if (!ENV_NAME.test(credential.env)) return `'${credential.env}' is not a valid environment variable name`
    if (credential.env.startsWith(SUBSCRIPTION_ENV_PREFIX)) {
      return `'${credential.env}' uses the Host's reserved ${SUBSCRIPTION_ENV_PREFIX} prefix`
    }
    if (refs.has(credential.ref)) return `credential reference '${credential.ref}' is listed twice`
    if (envs.has(credential.env)) return `environment variable '${credential.env}' is mapped twice`
    refs.add(credential.ref)
    envs.add(credential.env)
  }
  return undefined
}

/**
 * Parse the stdout contract: one JSON object per line, empty lines ignored,
 * nothing published unless every line is legal.
 *
 * Parse one run's JSON-lines output. The executor reports decoded text, so the
 * caller re-encodes it: this fatal decoder cannot prove the original byte stream
 * was valid UTF-8, and a replacement character printed as data stays data.
 */
export function parseSubscriptionOutput(raw: Uint8Array): SubscriptionOutput {
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    return { ok: false, reason: 'the output starts with a UTF-8 byte-order mark' }
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    return { ok: false, reason: 'the output is not valid UTF-8' }
  }
  const events: SubscriptionEvent[] = []
  const seen = new Map<string, SubscriptionEvent>()
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    // CRLF is a line ending, not content; a missing final newline is fine because split already answers the tail.
    const line = lines[index]!.replace(/\r$/, '')
    if (line.trim() === '') continue
    const parsed = parseJsonLine(line)
    if (!parsed.ok) return { ok: false, reason: `line ${index + 1}: ${parsed.reason}` }
    const event = eventOf(parsed.value, index + 1)
    if (!event.ok) return { ok: false, reason: event.reason }
    // One run may not name one id twice with different payloads: the acceptance
    // order would decide which survives, and a retried run would disagree.
    const earlier = seen.get(event.event.id)
    if (earlier !== undefined) {
      if (sameEvent(earlier, event.event)) continue
      return { ok: false, reason: `line ${index + 1}: id '${event.event.id}' repeats with a different payload` }
    }
    seen.set(event.event.id, event.event)
    events.push(event.event)
  }
  return { ok: true, events: Object.freeze(events) }
}

function sameEvent(left: SubscriptionEvent, right: SubscriptionEvent): boolean {
  return left.id === right.id && left.title === right.title && left.url === right.url && left.detail === right.detail
}

type JsonResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string }

/**
 * Strict JSON for one line. `JSON.parse` accepts the last of two identical
 * keys, which would silently change a payload the provider meant to be
 * ambiguous, so duplicate keys are refused here.
 */
function parseJsonLine(line: string): JsonResult {
  let cursor = 0
  const fail = (reason: string): JsonResult => ({ ok: false, reason })
  const skipSpace = (): void => {
    while (cursor < line.length && (line[cursor] === ' ' || line[cursor] === '\t')) cursor += 1
  }
  const parseValue = (depth: number): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string } => {
    if (depth > 32) return fail('the JSON nests too deeply')
    skipSpace()
    const character = line[cursor]
    if (character === '{') return parseObject(depth)
    if (character === '[') return parseArray(depth)
    if (character === '"') return parseString()
    if (character === 't' && line.startsWith('true', cursor)) { cursor += 4; return { ok: true, value: true } }
    if (character === 'f' && line.startsWith('false', cursor)) { cursor += 5; return { ok: true, value: false } }
    if (character === 'n' && line.startsWith('null', cursor)) { cursor += 4; return { ok: true, value: null } }
    return parseNumber()
  }
  const parseObject = (depth: number): JsonResult => {
    cursor += 1
    // A prototype-less record: `{"__proto__": …}` would otherwise reach the
    // interpreter's setter and turn an unknown key into inherited `id`/`title`,
    // which is a forged event the script never printed.
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    const keys = new Set<string>()
    skipSpace()
    if (line[cursor] === '}') { cursor += 1; return { ok: true, value: result } }
    for (;;) {
      skipSpace()
      if (line[cursor] !== '"') return fail('an object key must be a string')
      const key = parseString()
      if (!key.ok) return key
      if (key.value === '__proto__') return fail("the key '__proto__' is not a plain object member")
      if (keys.has(key.value as string)) return fail(`the key '${String(key.value)}' appears twice`)
      keys.add(key.value as string)
      skipSpace()
      if (line[cursor] !== ':') return fail('an object key must be followed by a colon')
      cursor += 1
      const value = parseValue(depth + 1)
      if (!value.ok) return value
      result[key.value as string] = value.value
      skipSpace()
      if (line[cursor] === ',') { cursor += 1; continue }
      if (line[cursor] === '}') { cursor += 1; return { ok: true, value: result } }
      return fail('an object needs a comma or a closing brace')
    }
  }
  const parseArray = (depth: number): JsonResult => {
    cursor += 1
    const result: unknown[] = []
    skipSpace()
    if (line[cursor] === ']') { cursor += 1; return { ok: true, value: result } }
    for (;;) {
      const value = parseValue(depth + 1)
      if (!value.ok) return value
      result.push(value.value)
      skipSpace()
      if (line[cursor] === ',') { cursor += 1; continue }
      if (line[cursor] === ']') { cursor += 1; return { ok: true, value: result } }
      return fail('an array needs a comma or a closing bracket')
    }
  }
  const parseString = (): JsonResult => {
    const start = cursor
    cursor += 1
    let escaped = false
    for (; cursor < line.length; cursor += 1) {
      const character = line[cursor]
      if (escaped) { escaped = false; continue }
      if (character === '\\') { escaped = true; continue }
      if (character === '"') {
        const slice = line.slice(start, cursor + 1)
        try {
          const value: unknown = JSON.parse(slice)
          cursor += 1
          return { ok: true, value }
        } catch {
          return fail('a string literal is malformed')
        }
      }
    }
    return fail('a string is unterminated')
  }
  const parseNumber = (): JsonResult => {
    const start = cursor
    if (line[cursor] === '-') cursor += 1
    while (cursor < line.length && line[cursor] !== undefined && /[0-9eE+\-.]/.test(line[cursor]!)) cursor += 1
    const slice = line.slice(start, cursor)
    if (slice === '' || slice === '-') return fail('a value is missing')
    // `Number()` accepts `01`, `+1`, `.5`, and `1.`, none of which is JSON. The
    // grammar is checked first, and the numeric value only parsed once it holds.
    if (!JSON_NUMBER.test(slice)) return fail(`'${slice}' is not a JSON number`)
    const value = Number(slice)
    if (!Number.isFinite(value)) return fail(`'${slice}' is not a finite number`)
    return { ok: true, value }
  }
  const value = parseValue(0)
  if (!value.ok) return value
  skipSpace()
  if (cursor !== line.length) return fail('unexpected trailing text after the JSON value')
  return value
}

function eventOf(value: unknown, lineNumber: number): { readonly ok: true; readonly event: SubscriptionEvent } | { readonly ok: false; readonly reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason: `line ${lineNumber}: ${reason}` })
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('each line must be a JSON object')
  const record = value as Record<string, unknown>
  const id = record.id
  const title = record.title
  if (typeof id !== 'string' || id === '') return fail('every event needs a non-empty string id')
  if (typeof title !== 'string' || title === '') return fail('every event needs a non-empty string title')
  if (characterLength(id) > SUBSCRIPTION_EVENT_ID_MAX_CHARACTERS) return fail(`the id is longer than ${SUBSCRIPTION_EVENT_ID_MAX_CHARACTERS} characters`)
  if (characterLength(title) > SUBSCRIPTION_EVENT_TITLE_MAX_CHARACTERS) return fail(`the title is longer than ${SUBSCRIPTION_EVENT_TITLE_MAX_CHARACTERS} characters`)
  const url = record.url
  if (url !== undefined) {
    if (typeof url !== 'string') return fail('url must be a string')
    if (characterLength(url) > SUBSCRIPTION_EVENT_URL_MAX_CHARACTERS) return fail(`the url is longer than ${SUBSCRIPTION_EVENT_URL_MAX_CHARACTERS} characters`)
    if (!/^https?:\/\/\S+$/i.test(url)) return fail('url must be an http(s) address')
  }
  const detail = record.detail
  if (detail !== undefined) {
    if (typeof detail !== 'string') return fail('detail must be a string')
    if (characterLength(detail) > SUBSCRIPTION_EVENT_DETAIL_MAX_CHARACTERS) return fail(`the detail is longer than ${SUBSCRIPTION_EVENT_DETAIL_MAX_CHARACTERS} characters`)
  }
  return {
    ok: true,
    event: Object.freeze({
      id,
      title,
      ...(typeof url === 'string' ? { url } : {}),
      ...(typeof detail === 'string' ? { detail } : {}),
    }),
  }
}

export interface SubscriptionRunEnvironmentInput {
  readonly projectRef: string
  readonly subscriptionRef: string
  readonly trigger: 'interval' | 'webhook' | 'test'
  /** When the last output was accepted, if this subscription ever succeeded. */
  readonly lastSuccessAt?: string | undefined
  /** The admission id a webhook run hands the script, so it can tell a retry from a new delivery. */
  readonly deliveryId?: string | undefined
  readonly resolved: Readonly<Record<string, string>>
}

/**
 * The environment deltas one run adds on top of the executor's own scrub.
 * The Host's own four variables are always present because a script that
 * cannot tell what it is running for is debugged by guessing.
 */
export function subscriptionRunEnvironment(input: SubscriptionRunEnvironmentInput): Record<string, string> {
  return {
    [`${SUBSCRIPTION_ENV_PREFIX}PROJECT`]: input.projectRef,
    [`${SUBSCRIPTION_ENV_PREFIX}SUBSCRIPTION`]: input.subscriptionRef,
    [`${SUBSCRIPTION_ENV_PREFIX}TRIGGER`]: input.trigger,
    [`${SUBSCRIPTION_ENV_PREFIX}LAST_SUCCESS_AT`]: input.lastSuccessAt ?? '',
    ...(input.deliveryId === undefined ? {} : { [`${SUBSCRIPTION_ENV_PREFIX}DELIVERY_ID`]: input.deliveryId }),
    ...input.resolved,
  }
}

/** The test envelope a webhook-only subscription runs under while it is validated. */
export const SUBSCRIPTION_TEST_TRIGGER = 'test'

/**
 * The trial envelope's stdin. A webhook-only subscription has no live input to
 * replay at creation, so the contract supplies a sample the script can reject
 * on signature grounds before it is ever deployed.
 */
export function subscriptionTestStdin(): string {
  return JSON.stringify({
    headers: { 'content-type': 'application/json', 'x-team-event': 'test', 'x-team-delivery': 'test' },
    body: '{"test":true}',
  })
}

/** Next due instant after `from`, or `undefined` for a subscription that has no timer. */
export function nextDueAfter(from: number, minutes: number): number {
  return from + minutes * 60_000
}

export type SubscriptionScheduleAction = 'run' | 'wait' | 'skip'

export interface SubscriptionScheduleInput {
  /** Due instant persisted for this subscription, if any. */
  readonly dueAt?: number | undefined
  readonly now: number
  readonly paused: boolean
  readonly deleted: boolean
  readonly archived: boolean
  /** Accepted-but-unpublished events for this subscription. */
  readonly pending: number
  /** Running or queued for a run slot right now. */
  readonly busy: boolean
}

/**
 * What a timer tick does with one subscription. Waiting is not failing: a due
 * run whose own subscription is already executing (a trial, typically) waits
 * for its turn in the queue, the backlog ceiling skips without counting, and a
 * skip keeps the failure count and re-targets the due instant.
 */
export function scheduleAction(input: SubscriptionScheduleInput): SubscriptionScheduleAction {
  if (input.deleted || input.archived || input.paused) return 'skip'
  if (input.dueAt === undefined || input.now < input.dueAt) return 'wait'
  // One subscription never runs twice at once: a due run waits behind its own
  // trial instead of being dropped or counted as a finished one.
  if (input.busy) return 'wait'
  // The backlog ceiling is a skip, not a failure: nothing the script can do
  // would help until publishing drains the queue.
  if (input.pending >= SUBSCRIPTION_PENDING_MAX) return 'skip'
  return 'run'
}

/** Why a stored snapshot cannot be run as recorded, or `undefined` when it can. */
export function scriptSnapshotProblem(script: SubscriptionScriptSnapshot): string | undefined {
  if (script.shell !== 'bash' && script.shell !== 'pwsh') return `'${String(script.shell)}' is not a supported shell`
  if (!isScriptHash(script.sha256)) return 'the script hash is malformed'
  if (scriptHash(script.content) !== script.sha256) return 'the script hash does not match its content'
  return snapshotScript(script.content, script.shell).ok ? undefined : 'the script snapshot is not usable'
}

/** Everything a definition must satisfy before it may be stored, as the first problem found. */
export function subscriptionDefinitionProblem(definition: {
  readonly name: string
  readonly triggers: SubscriptionTriggers
  readonly script: SubscriptionScriptSnapshot
  readonly credentials: readonly SubscriptionCredential[]
}): string | undefined {
  return nameProblem(definition.name)
    ?? triggersProblem(definition.triggers)
    ?? credentialsProblem(definition.credentials)
    ?? scriptSnapshotProblem(definition.script)
}
