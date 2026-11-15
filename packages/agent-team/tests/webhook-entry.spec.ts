/**
 * The webhook entry over a real socket: a second Harness WebServer on a loopback
 * port, the ordinary Team Host behind it, and the status table of `spec.md` §4.5
 * asserted as responses rather than as return values. The isolation that keeps
 * this listener off the browser API is a composition fact (`cordis.patch.yml`),
 * so what is proven here is the entry's own contract: what it refuses, what it
 * reads, and what it hands the Host.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { MemoryMediaPool } from './helpers/memory-backend.ts'
import { harness } from './helpers/host-harness.ts'
import * as WebhookEntry from '../src/webhook.ts'
import { WEBHOOK_BODY_MAX_BYTES } from '../src/subscription-webhook.ts'
import type { AgentTeamProjectRef, AgentTeamRequestId } from '../src/types.ts'

const workspaceId = WorkspaceId('workspace:alpha')
const origin = 'https://team.example.com'
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
const cleanups: Array<() => Promise<void>> = []
const spillRoots: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  for (const root of spillRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A shell that answers the family probe and prints one event for the trial. */
function fakeShell(): { readonly service: unknown } {
  const spillRoot = mkdtempSync(join(tmpdir(), 'dsh-team-webhook-entry-'))
  spillRoots.push(spillRoot)
  let spillId = 0
  return {
    service: {
      resolve: (request: ShellExecSpec) => request,
      execute: async (spec: ShellExecSpec) => {
        const probe = spec.command.includes('BASH_VERSION')
        const answer = (): ShellRunResult => {
          const stdout = probe ? '5.2.15' : '{"id":"a","title":"A"}\n'
          const spillPath = join(spillRoot, `${spillId++}.log`)
          if (!probe) writeFileSync(spillPath, `__DSH_TEAM_RAW_STDOUT__${stdout}`)
          return {
            exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
            stdout: { text: stdout, truncated: false, ...(probe ? {} : { spillPath }) },
            stderr: { text: '', truncated: false },
          }
        }
        return { result: async () => answer() }
      },
    },
  }
}

interface Entry {
  readonly ctx: Context
  readonly base: string
  readonly projectRef: AgentTeamProjectRef
  readonly token: string
  readonly subscriptionRef: string
  /** What the private store holds for this subscription, so an assertion can read the row the entry wrote. */
  readonly admissions: () => readonly StoredAdmission[]
}

interface StoredAdmission {
  readonly admissionRef: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly state: string
}

/**
 * One Host, one second WebServer, and the entry on its route. The Host's own
 * `webServer` is absent here on purpose: the entry must reach the group's
 * instance, and a second instance is what makes "its own listener" literal.
 */
async function bootEntry(): Promise<Entry> {
  const pool = new MemoryMediaPool()
  const { ctx } = await harness({
    pool,
    workspaceIds: [workspaceId],
    config: { webhook: { publicOrigin: origin } } as never,
    prepare: c => {
      c.provide('shell', fakeShell().service as never)
      c.provide('credentials', {
        resolve: async (ref: string) => ({ value: `secret-${ref}`, source: 'fixture' }),
        describe: async () => ({ configured: true, writable: false }),
      })
    },
  })
  const server = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 } as never)
  cleanups.push(async () => { await server.dispose() })
  const entryFiber = await ctx.plugin(WebhookEntry)
  cleanups.push(async () => { await entryFiber.dispose() })
  const port = ctx.webServer.port
  if (port === undefined) throw new Error('the second WebServer did not bind')
  const projectRef = (await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId, name: 'alpha', description: '' })).project.projectRef
  const created = await ctx.agentTeam.createSubscription({ requestId: requestId('create'), workspaceId, projectRef, name: 'GitHub PR activity',
    webhook: true, script: { scriptContent: 'printf events\n' } })
  if (created.kind !== 'changed') throw new Error('expected a committed create')
  const address = created.webhookAddress
  if (address === undefined) throw new Error('expected the create to answer with its address')
  const admissions = (): readonly StoredAdmission[] =>
    [...(pool.media.get('agent_team_subscriptions')?.tables.get('admissions')?.values() ?? [])] as readonly StoredAdmission[]
  return { ctx, base: `http://127.0.0.1:${port}`, projectRef, token: address.split('/team/hooks/')[1]!, subscriptionRef: created.subscription.subscriptionRef, admissions }
}

const post = (base: string, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', ...init })

describe('the public webhook entry', () => {
  it('answers 202 only after the delivery is durable, and hands the script the headers it may read', async () => {
    const entry = await bootEntry()
    const answer = await post(entry.base, `/team/hooks/${entry.token}`, {
      headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': 'sha256=abc',
        'x-api-key': 'must-not-travel', authorization: 'Bearer leak', 'x-forwarded-for': '10.0.0.1' },
      body: '{"action":"opened"}',
    })
    expect(answer.status).toBe(202)
    const queued = entry.admissions()
    expect(queued, 'the 202 means the row already exists').toHaveLength(1)
    expect(queued[0]!.body).toBe('{"action":"opened"}')
    // Exactly the whitelist, lowercased: the credential-shaped headers the
    // request carried are absent rather than merely unread.
    expect(Object.keys(queued[0]!.headers).sort()).toEqual(['content-type', 'user-agent', 'x-github-event', 'x-hub-signature-256'])
    expect(queued[0]!.headers['x-github-event']).toBe('pull_request')
    expect(queued[0]!.headers['x-hub-signature-256']).toBe('sha256=abc')
    expect(queued[0]!.state).toBe('queued')
  })

  it('refuses an address nobody armed, and a path that is more than one token', async () => {
    const entry = await bootEntry()
    expect((await post(entry.base, `/team/hooks/${'B'.repeat(43)}`, { body: '{}' })).status, 'a token nobody minted').toBe(404)
    expect((await post(entry.base, `/team/hooks/${entry.token}/extra`, { body: '{}' })).status, 'a nested path').toBe(404)
    expect((await post(entry.base, '/team/hooks', { body: '{}' })).status, 'the bare prefix').toBe(404)
    expect(entry.admissions()).toHaveLength(0)
  })

  it('refuses a method that is not POST, and a body past the limit, without queueing anything', async () => {
    const entry = await bootEntry()
    const wrongMethod = await fetch(`${entry.base}/team/hooks/${entry.token}`)
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')
    const tooLarge = await post(entry.base, `/team/hooks/${entry.token}`, { body: 'a'.repeat(WEBHOOK_BODY_MAX_BYTES + 1) })
    expect(tooLarge.status).toBe(413)
    expect(entry.admissions(), 'a refused request never becomes work').toHaveLength(0)
  })

  it('refuses a body it cannot carry verbatim and an encoding whose bytes it cannot verify', async () => {
    const entry = await bootEntry()
    const invalid = await post(entry.base, `/team/hooks/${entry.token}`, { body: new Uint8Array([0x7b, 0xff, 0x7d]) })
    expect(invalid.status, 'replacement characters would change what a signature covers').toBe(400)
    const gzipped = await post(entry.base, `/team/hooks/${entry.token}`, { headers: { 'content-encoding': 'gzip' }, body: '{}' })
    expect(gzipped.status).toBe(415)
    expect(entry.admissions()).toHaveLength(0)
  })

  it('answers the status table rows a paused subscription and a full queue name', async () => {
    const entry = await bootEntry()
    await entry.ctx.agentTeam.pauseSubscription({ requestId: requestId('pause'), workspaceId, projectRef: entry.projectRef,
      subscriptionRef: entry.subscriptionRef as never, expectedRevision: 1 })
    expect((await post(entry.base, `/team/hooks/${entry.token}`, { body: '{}' })).status, 'a paused subscription').toBe(409)
    await entry.ctx.agentTeam.resumeSubscription({ requestId: requestId('resume'), workspaceId, projectRef: entry.projectRef,
      subscriptionRef: entry.subscriptionRef as never, expectedRevision: 1 })
    for (let index = 0; index < 10; index += 1) {
      expect((await post(entry.base, `/team/hooks/${entry.token}`, { body: `{"n":${index}}` })).status).toBe(202)
    }
    const full = await post(entry.base, `/team/hooks/${entry.token}`, { body: '{}' })
    expect(full.status, 'the eleventh delivery').toBe(429)
    expect(full.headers.get('retry-after')).toBe('60')
  })
})
