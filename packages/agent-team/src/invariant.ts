/** Package-owned invariant companion for `@wowyuarm/dsh-agent-team`. */

import type { Context } from '@deepseek-ai/cordis'

const PACKAGE_NAME = '@wowyuarm/dsh-agent-team'

/** Cordis companion plugin name. */
export const name = 'agent-team-invariant'
/**
 * Services required before the companion can validate Team state. The check
 * is self-hosted in this plugin's own fiber — companions used to register
 * into `@deepseek-ai/dsh-invariants`, which the Harness line after `rc.2`
 * removes wholesale.
 */
export const inject = ['agentTeam']

/**
 * A violated Team ledger invariant, raised on the frame that triggered the
 * check: boot when the mount replay fails, the committing call while a
 * divergence is latched. The Host's post-commit boundary recognizes this class
 * and re-raises it instead of degrading it to a log line.
 */
export class AgentTeamInvariantError extends Error {
  /** Stable failure code, carried over from the removed upstream error class. */
  readonly code = 'INVARIANT' as const
  /** Full npm package name that owns the violated invariant. */
  readonly packageName = PACKAGE_NAME

  /**
   * Construct a Team invariant failure.
   * @param message - violated contract, without the standard error prefix.
   */
  constructor(message: string) {
    super(`invariant violated by "${PACKAGE_NAME}": ${message}`)
    this.name = 'AgentTeamInvariantError'
  }
}

/**
 * Validate Team state at mount and keep validating it after every commit.
 * @param ctx - Cordis context carrying the Agent Team service.
 * @returns nothing; listeners and the pending check ride the plugin fiber.
 */
export const apply = (ctx: Context): void => {
  const divergence = (error: unknown): string =>
    `durable ledger and Team projection diverged: ${String(error)}`

  // Mounting stays synchronous: a durable ledger that cannot be re-derived
  // must fail startup instead of racing the first commit. The mount adopts
  // the record-level replay the constructor already ran, once and only while
  // nothing has committed since; every later validation, and every
  // commit-driven one below, replays the whole durable table.
  try {
    ctx.agentTeam.validateLedgerAtMount()
  } catch (error) {
    throw new AgentTeamInvariantError(divergence(error))
  }

  // The commit path cannot pay a full replay before its Remote response
  // returns, and opening a Thread commits. The replay stays the same full one
  // over the durable table, but commits coalesce into a single run in the
  // check phase, after the I/O turn carrying the response. A divergence stays
  // loud: it is logged where it is detected, and every later commit re-raises
  // it on a caller-owned frame until a replay comes back clean.
  let latched: string | undefined
  let pending: NodeJS.Immediate | undefined
  const check = (): void => {
    pending = undefined
    try {
      ctx.agentTeam.validateLedger()
      latched = undefined
    } catch (error) {
      latched = divergence(error)
      ctx.logger.error(`agent-team: ${latched}`)
    }
  }
  ctx.effect(() => () => {
    if (pending !== undefined) clearImmediate(pending)
    pending = undefined
  }, 'agent-team.invariant.pending-validation')
  ctx.on('agent-team/committed', () => {
    // Scheduled before the latch re-raises: a replay that comes back clean is
    // what releases it.
    if (pending === undefined) pending = setImmediate(check)
    if (latched !== undefined) throw new AgentTeamInvariantError(latched)
  })
}
