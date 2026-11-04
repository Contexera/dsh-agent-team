/**
 * The webhook trigger's contract, outside the Host so it is provable without a socket.
 * @module @contexera/dsh-agent-team/subscription-webhook
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Where a subscription's hook lives on the public origin, before its token. */
export const WEBHOOK_PATH_PREFIX = '/team/hooks/'

/** One request's body limit. Larger is refused rather than read: a partial body cannot be verified. */
export const WEBHOOK_BODY_MAX_BYTES = 256 * 1024

/** One forwarded header value's limit, in bytes. A longer value is refused, never truncated. */
export const WEBHOOK_HEADER_VALUE_MAX_BYTES = 1024

/** Deliveries one subscription may have queued or retrying at once. */
export const WEBHOOK_QUEUE_LIMIT = 10

/** What a full queue asks an auto-retrying provider to wait: shorter than its own ladder, so a burst drains. */
export const WEBHOOK_QUEUE_RETRY_AFTER_SECONDS = 60

/** Backoff before each retry of a delivery whose script failed: 1, 5 and 30 minutes. */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = Object.freeze([1, 5, 30].map(minutes => minutes * 60_000))

/** Retries one delivery gets before it becomes a failed delivery an owner must handle. */
export const WEBHOOK_RETRY_LIMIT = WEBHOOK_RETRY_DELAYS_MS.length

/** Token bytes behind one address: 32 random bytes, base64url — 43 characters, no padding. */
const WEBHOOK_TOKEN_BYTES = 32

const WEBHOOK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** What a subscription carries in the ledger: the hash, never the address it names. */
export interface SubscriptionWebhookArm {
  readonly tokenHash: string
  readonly generation: number
  /** When this generation's token was minted, for the operator reading the ledger. */
  readonly armedAt: string
}

/** A fresh token: random, so a reset relates old and new address in no way. */
export function mintWebhookToken(random: (size: number) => Buffer = size => randomBytes(size)): string {
  return random(WEBHOOK_TOKEN_BYTES).toString('base64url')
}

/** The ledger's copy of a token: its SHA-256, so a leak of storage does not yield addresses. */
export function webhookTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Whether two hex hashes name the same token, compared without leaking where they diverge. */
export function sameWebhookTokenHash(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/** The token a request path names, or `undefined` when the path is not a hook address. */
export function webhookTokenOfPath(pathname: string): string | undefined {
  if (!pathname.startsWith(WEBHOOK_PATH_PREFIX)) return undefined
  const token = pathname.slice(WEBHOOK_PATH_PREFIX.length)
  return WEBHOOK_TOKEN_PATTERN.test(token) ? token : undefined
}

/** Why a public origin cannot carry hook addresses: a path, query or fragment makes one ambiguous. */
export function webhookOriginProblem(origin: string): string | undefined {
  const trimmed = origin.trim()
  if (trimmed === '') return 'the public address is empty'
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return `the public address '${trimmed}' is not an absolute URL`
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `the public address '${trimmed}' must use http or https`
  }
  if (url.search !== '' || url.hash !== '') return `the public address '${trimmed}' must not carry a query or fragment`
  if (url.pathname !== '/' && url.pathname !== '') return `the public address '${trimmed}' must be an origin, without a path`
  if (url.hostname === '') return `the public address '${trimmed}' has no host`
  return undefined
}

/** One subscription's address on the configured origin. */
export function webhookAddress(origin: string, token: string): string {
  const base = origin.trim().replace(/\/+$/, '')
  return `${base}${WEBHOOK_PATH_PREFIX}${token}`
}

/** The sentence an arming write refuses with, so the operator learns which setting to write. */
export function webhookOriginRefusal(origin: string): string | undefined {
  if (origin.trim() === '') {
    return 'the webhook public address is not configured; set webhook.publicOrigin in the Team settings before enabling a webhook trigger'
  }
  const problem = webhookOriginProblem(origin)
  return problem === undefined ? undefined : `the configured webhook public address cannot carry hook addresses: ${problem}`
}

/** Names forwarded whatever the provider: the two every payload needs to be understood. */
const WEBHOOK_HEADERS_ALWAYS: readonly string[] = ['content-type', 'user-agent']

/** Provider conventions (GitHub's `x-github-event`, GitLab's `x-gitlab-event`); anything else is listed. */
const WEBHOOK_HEADER_PATTERNS: readonly RegExp[] = [/^x-.*-event$/, /^x-.*-delivery$/, /^x-.*-signature/, /^x-.*-timestamp$/]

/** Headers named explicitly by a deployment, beyond the patterns above. */
const WEBHOOK_HEADERS_LISTED: readonly string[] = []

export type WebhookHeadersResult =
  | { readonly ok: true; readonly headers: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string; readonly header: string }

function headerIsForwardable(lowercase: string): boolean {
  return WEBHOOK_HEADERS_ALWAYS.includes(lowercase) || WEBHOOK_HEADERS_LISTED.includes(lowercase)
    || WEBHOOK_HEADER_PATTERNS.some(pattern => pattern.test(lowercase))
}

/**
 * The headers a script may see, lowercased, or why one cannot be forwarded. A value
 * past the limit refuses the delivery: a cut signature verifies nothing (`spec.md` §4.5).
 */
export function forwardableHeaders(raw: Readonly<Record<string, string | readonly string[] | undefined>>): WebhookHeadersResult {
  const forwarded: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    const lowercase = name.toLowerCase()
    if (!headerIsForwardable(lowercase)) continue
    const joined = typeof value === 'string' ? value : value.join(', ')
    if (Buffer.byteLength(joined, 'utf8') > WEBHOOK_HEADER_VALUE_MAX_BYTES) {
      return { ok: false, header: lowercase, reason: `the '${lowercase}' header is ${Buffer.byteLength(joined, 'utf8')} bytes; the limit is ${WEBHOOK_HEADER_VALUE_MAX_BYTES}` }
    }
    forwarded[lowercase] = joined
  }
  return { ok: true, headers: Object.freeze(forwarded) }
}

/** The stdin a webhook run reads: headers, and the raw body a signature hashes. */
export function webhookStdin(headers: Readonly<Record<string, string>>, body: string): string {
  return JSON.stringify({ headers, body })
}

/** How long to wait before retry number `attempt`, counting the first retry as one. */
export function webhookRetryDelayMs(retry: number): number | undefined {
  return Number.isInteger(retry) && retry >= 1 && retry <= WEBHOOK_RETRY_LIMIT ? WEBHOOK_RETRY_DELAYS_MS[retry - 1] : undefined
}

/** How often the Host looks for a delivery that is due. One second is a run's granularity, not a queue's. */
export const WEBHOOK_PUMP_INTERVAL_MS = 5_000

/** How long the entry waits for one body, so a slow client never holds a queue slot. */
export const WEBHOOK_READ_DEADLINE_MS = 10_000

/**
 * The status table of `spec.md` §4.5 plus its four refusals, so the entry and the tests
 * read one list.
 */
export const WEBHOOK_STATUS = Object.freeze({
  queued: 202,
  notFound: 404,
  paused: 409,
  bodyTooLarge: 413,
  notPost: 405,
  queueFull: 429,
  storageFailed: 503,
  headerTooLarge: 431,
  unsupportedEncoding: 415,
  notUtf8: 400,
})
