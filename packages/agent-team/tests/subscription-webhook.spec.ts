import { describe, expect, it } from 'vitest'
import {
  WEBHOOK_HEADER_VALUE_MAX_BYTES,
  WEBHOOK_PATH_PREFIX,
  WEBHOOK_RETRY_DELAYS_MS,
  forwardableHeaders,
  mintWebhookToken,
  sameWebhookTokenHash,
  webhookAddress,
  webhookOriginProblem,
  webhookRetryDelayMs,
  webhookStdin,
  webhookTokenHash,
  webhookTokenOfPath,
} from '../src/subscription-webhook.ts'

describe('a token exists as an address and as a hash, never as both', () => {
  it('mints 43 characters of base64url from 32 random bytes', () => {
    const token = mintWebhookToken(size => Buffer.alloc(size, 7))
    expect(token).toHaveLength(43)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(webhookTokenOfPath(`${WEBHOOK_PATH_PREFIX}${token}`)).toBe(token)
    // Two independent draws differ, so two subscriptions never share an address.
    expect(mintWebhookToken()).not.toBe(mintWebhookToken())
  })

  it('stores one stable SHA-256 and compares it without leaking a prefix', () => {
    const token = 'a'.repeat(43)
    const hash = webhookTokenHash(token)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(webhookTokenHash(token)).toBe(hash)
    expect(sameWebhookTokenHash(hash, hash)).toBe(true)
    expect(sameWebhookTokenHash(hash, webhookTokenHash('b'.repeat(43)))).toBe(false)
    expect(sameWebhookTokenHash(hash, 'short')).toBe(false)
  })

  it('recognises only a well-formed hook path', () => {
    const token = 'A'.repeat(43)
    expect(webhookTokenOfPath(`${WEBHOOK_PATH_PREFIX}${token}`)).toBe(token)
    for (const pathname of ['/hooks/' + token, `/team/hooks/${token}/extra`, '/team/hooks/', `/team/hooks/${token}x`,
      `/team/hooks/${'a'.repeat(42)}`, `/team/hooks/${'a'.repeat(44)}`, `/team/hooks/${'a'.repeat(42)}+`]) {
      expect(webhookTokenOfPath(pathname), pathname).toBeUndefined()
    }
  })
})

describe('the public address is an origin, and an address is origin plus token', () => {
  it('accepts an absolute http or https origin, with or without a trailing slash', () => {
    for (const origin of ['https://team.example.com', 'https://team.example.com/', 'http://127.0.0.1:8080', 'https://example.com:8443']) {
      expect(webhookOriginProblem(origin), origin).toBeUndefined()
    }
    expect(webhookAddress('https://team.example.com/', 'tok')).toBe('https://team.example.com/team/hooks/tok')
    expect(webhookAddress('https://team.example.com', 'tok')).toBe('https://team.example.com/team/hooks/tok')
  })

  it('refuses a value that is not a bare origin, with a reason that says which part', () => {
    expect(webhookOriginProblem('')).toMatch(/empty/)
    expect(webhookOriginProblem('team.example.com')).toMatch(/absolute URL/)
    expect(webhookOriginProblem('ftp://team.example.com')).toMatch(/http or https/)
    expect(webhookOriginProblem('https://team.example.com/base')).toMatch(/origin, without a path/)
    expect(webhookOriginProblem('https://team.example.com?x=1')).toMatch(/query or fragment/)
    expect(webhookOriginProblem('https://team.example.com#x')).toMatch(/query or fragment/)
  })
})

describe('only the headers a provider signs with reach a script', () => {
  it('forwards the two general names and the provider patterns, all lowercased', () => {
    const forwarded = forwardableHeaders({
      'Content-Type': 'application/json',
      'User-Agent': 'GitHub-Hookshot/abc',
      'X-GitHub-Event': 'issues',
      'X-GitHub-Delivery': 'd-1',
      'X-Hub-Signature-256': 'sha256=deadbeef',
      'x-gitlab-event': 'Push Hook',
      'X-GitLab-Token-Timestamp': '1234',
    })
    expect(forwarded).toEqual({ ok: true, headers: {
      'content-type': 'application/json',
      'user-agent': 'GitHub-Hookshot/abc',
      'x-github-event': 'issues',
      'x-github-delivery': 'd-1',
      'x-hub-signature-256': 'sha256=deadbeef',
      'x-gitlab-event': 'Push Hook',
      'x-gitlab-token-timestamp': '1234',
    } })
  })

  it('drops credentials, provider signatures outside the patterns and proxy headers', () => {
    const forwarded = forwardableHeaders({
      authorization: 'Bearer secret',
      cookie: 'session=1',
      'x-api-key': 'key',
      'x-forwarded-for': '203.0.113.9',
      'stripe-signature': 't=1,v1=abc',
      'x-github-event': 'push',
    })
    expect(forwarded).toEqual({ ok: true, headers: { 'x-github-event': 'push' } })
  })

  it('refuses a value past the limit instead of truncating it, and names the header', () => {
    const long = 'x'.repeat(WEBHOOK_HEADER_VALUE_MAX_BYTES + 1)
    const refused = forwardableHeaders({ 'x-hub-signature-256': long })
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.header).toBe('x-hub-signature-256')
    expect(refused.ok === false && refused.reason).toMatch(/limit is 1024/)
    // At the limit it is still forwarded byte for byte.
    const exact = 'y'.repeat(WEBHOOK_HEADER_VALUE_MAX_BYTES)
    expect(forwardableHeaders({ 'x-hub-signature-256': exact })).toEqual({ ok: true, headers: { 'x-hub-signature-256': exact } })
    // A name outside the list is dropped before its size is ever considered.
    expect(forwardableHeaders({ 'x-api-key': long })).toEqual({ ok: true, headers: {} })
  })

  it('joins a repeated header and measures the joined value', () => {
    const forwarded = forwardableHeaders({ 'X-Forwarded-Event': undefined, 'x-github-event': ['a', 'b'] })
    expect(forwarded).toEqual({ ok: true, headers: { 'x-github-event': 'a, b' } })
  })
})

describe('the stdin envelope and the retry schedule', () => {
  it('hands the script lowercased headers and the raw body', () => {
    const stdin = webhookStdin({ 'x-github-event': 'push' }, '{"action":"opened"}\n')
    expect(JSON.parse(stdin)).toEqual({ headers: { 'x-github-event': 'push' }, body: '{"action":"opened"}\n' })
  })

  it('counts retries in minutes: 1, 5, 30, then nothing', () => {
    expect(WEBHOOK_RETRY_DELAYS_MS).toEqual([60_000, 300_000, 1_800_000])
    expect([1, 2, 3].map(retry => webhookRetryDelayMs(retry))).toEqual([60_000, 300_000, 1_800_000])
    expect(webhookRetryDelayMs(0)).toBeUndefined()
    expect(webhookRetryDelayMs(4)).toBeUndefined()
    expect(webhookRetryDelayMs(1.5)).toBeUndefined()
  })
})
