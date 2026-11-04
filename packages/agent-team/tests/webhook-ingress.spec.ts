/**
 * The webhook ingress row over a real socket: it mounts its own
 * `@deepseek-ai/dsh-host-webserver` inside an isolated `webServer` realm, so the
 * listener a tunnel publishes serves the webhook entry and never the browser API the
 * host's own listener serves. Two facts are proven here — that the realm really is a
 * second instance, and that unloading the row releases the port instead of leaving it
 * bound for a re-enable to trip over.
 */
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Ingress from '../src/webhook-ingress.ts'

const root = resolve(import.meta.dirname, '../../../')
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** The ingress row as the bundle ships it, with a port the test can bind. */
function shippedIngressRow(): EntryOptions {
  const rows = composeEntries([loadOverlayPatches('webhook ingress', resolve(root, 'cordis.patch.yml'))])
  const row = rows.find(entry => entry.name === '@contexera/dsh-agent-team/webhook-ingress')
  if (row === undefined) throw new Error('the composition has no ingress row')
  return { ...row, config: { host: '127.0.0.1', port: 0 } }
}

interface Composed {
  readonly ctx: Context
  /** The port the host's own listener bound. */
  readonly hostPort: number
  /** The port the ingress row bound, read out of the isolated realm it created. */
  readonly ingressPort: number
  /** How many deliveries the entry handed the Host. */
  intakes(): number
}

/**
 * A composed host: one listener for the browser API, and the ingress row beside it in
 * its own realm. The Team Host is a stub — what the entry does with a delivery is
 * `webhook-entry.spec.ts`'s subject, and the row under test only needs that seam.
 */
async function compose(): Promise<Composed> {
  const state = { intakes: 0 }
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@contexera/dsh-agent-team/webhook-ingress', Ingress],
  ])
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  ctx.provide('agentTeam', {
    intakeWebhookDelivery: async () => {
      state.intakes += 1
      return { kind: 'queued', admissionRef: 'admission:ingress-probe' }
    },
  })
  await ctx.plugin(Loader)
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  // The browser API's own listener, and the shipped ingress row beside it: what
  // this spec proves is the shape the bundle actually composes.
  await ctx.loader.create({ id: 'host-server', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } } as never)
  await ctx.loader.create(shippedIngressRow())
  await ctx.loader.await()
  const unloaded = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
  expect(unloaded.map(entry => entry.options.name), 'every row of the composition started').toEqual([])
  const ingress = [...ctx.loader.entries()]
    .find(entry => entry.options.name === '@contexera/dsh-agent-team/webhook-ingress')
  const ingressPort = ingress?.fiber?.ctx.get('webServer')?.port
  const hostPort = ctx.webServer.port
  if (hostPort === undefined || ingressPort === undefined) throw new Error('a listener did not bind')
  return { ctx, hostPort, ingressPort, intakes: () => state.intakes }
}

/** A path the entry reads as one address: a token of its own length, so the Host answers. */
const HOOK = `/team/hooks/${'A'.repeat(43)}`

const post = (port: number, path: string = HOOK): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: '{}' })

describe('the webhook ingress row', () => {
  it('serves the entry on its own listener, and answers the same path nowhere else', async () => {
    const bit = await compose()
    expect(bit.ingressPort, 'the ingress is a second instance, not the host listener').not.toBe(bit.hostPort)
    expect((await post(bit.ingressPort)).status, 'the entry is on that listener').toBe(202)
    expect(bit.intakes(), 'and it handed the delivery to the Host').toBe(1)
    // The very same request over the host's listener finds no route: the browser
    // API's listener never serves a webhook, whatever the path says.
    expect((await post(bit.hostPort)).status, 'the host listener knows no webhook').toBe(404)
    expect(bit.intakes(), 'and the host listener never reached the Host').toBe(1)
  })

  it('provides its own webServer instance, so the host keeps the one it had', async () => {
    const bit = await compose()
    const isolated = [...bit.ctx.loader.entries()]
      .find(entry => entry.options.name === '@contexera/dsh-agent-team/webhook-ingress')?.fiber?.ctx.get('webServer')
    expect(isolated, 'the row provides an instance in its own realm').toBeDefined()
    expect(isolated, 'and it is not the host instance').not.toBe(bit.ctx.webServer)
    expect(bit.ctx.webServer.port, 'the host listener kept its own port').toBe(bit.hostPort)
  })

  it('releases the published port when the plugin tree unloads', async () => {
    const bit = await compose()
    expect((await post(bit.ingressPort)).status).toBe(202)
    await bit.ctx.fiber.dispose()
    // Unloading Team takes the whole tree with it, so the address the deployment
    // publishes is bindable again for the next enable.
    const probe = createServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(bit.ingressPort, '127.0.0.1', () => { resolve() })
    })
    await new Promise<void>(resolve => { probe.close(() => { resolve() }) })
  })
})
