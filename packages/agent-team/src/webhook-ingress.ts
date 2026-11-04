/**
 * The public webhook entry's own listener: a second `@deepseek-ai/dsh-host-webserver`, in an
 * isolated `webServer` realm so a provider that reaches this port never touches the browser
 * API. It is mounted here, as a child of this row, instead of named as a composition row:
 * Harness protects that module, and a bundle naming a protected module cannot be disabled
 * again at runtime. docs/architecture/host-authority.md explains the consequence.
 * @module @contexera/dsh-agent-team/webhook-ingress
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as WebhookEntry from './webhook.ts'

/** Cordis plugin name. */
export const name = 'agent-team-webhook-ingress'

/** Nothing to wait for: the route this mounts asks for `agentTeam` and `webServer` itself. */
export const inject: readonly string[] = []

export interface Config {
  /** A concrete local address; a tunnel publishes it. */
  host: string
  /** The published port; `0` lets the operating system choose one. */
  port: number
}

export const Config: z<Config> = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.natural().max(65535).required(),
})

/** Mount the listener and the route into this row's own realm. */
export const apply = async (ctx: Context, config: Config): Promise<void> => {
  await ctx.plugin(WebServer, { host: config.host, port: config.port })
  ctx.plugin(WebhookEntry)
}
