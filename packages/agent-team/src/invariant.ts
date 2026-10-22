/** Package-owned invariant companion for `@contexera/dsh-agent-team`. */

import type { Context } from '@deepseek-ai/cordis'

const PACKAGE_NAME = '@contexera/dsh-agent-team'

/** Cordis companion plugin name. */
export const name = 'agent-team-invariant'
/** Services required before validation; the check is self-hosted in this plugin's fiber, not registered into `@deepseek-ai/dsh-invariants`. */
export const inject = ['agentTeam']

/** A violated Team ledger invariant, raised on the triggering frame (boot replay or the committing call). The Host's post-commit boundary re-raises it instead of logging. */
export class AgentTeamInvariantError extends Error {
/** Stable failure code. */
  readonly code = 'INVARIANT' as const
  /** Full npm package name that owns the violated invariant. */
  readonly packageName = PACKAGE_NAME

  constructor(message: string) {
    super(`invariant violated by "${PACKAGE_NAME}": ${message}`)
    this.name = 'AgentTeamInvariantError'
  }
}

/** Validates Team state at mount and after every commit. */
export const apply = (ctx: Context): void => {
  validateAtMount(ctx)
  watchCommits(ctx)
}

/** Synchronous so a ledger that cannot be re-derived fails startup instead of racing the first commit. Adopts the constructor's record-level replay once, while nothing has committed since; every later validation replays the whole durable table. */
function validateAtMount(ctx: Context): void {
  try {
    ctx.agentTeam.validateLedgerAtMount()
  } catch (error) {
    throw new AgentTeamInvariantError(divergenceText(error))
  }
}

/** Opening a Thread commits, and the commit path cannot afford a full replay before its response returns, so commits coalesce into one full replay after the response's I/O turn. A divergence is logged where detected and re-raised on every later commit until a replay comes back clean. */
function watchCommits(ctx: Context): void {
  let latched: string | undefined
  let pending: NodeJS.Immediate | undefined
  const check = (): void => {
    pending = undefined
    try {
      ctx.agentTeam.validateLedger()
      latched = undefined
    } catch (error) {
      latched = divergenceText(error)
      ctx.logger.error(`agent-team: ${latched}`)
    }
  }
  ctx.effect(() => () => {
    if (pending !== undefined) clearImmediate(pending)
    pending = undefined
  }, 'agent-team.invariant.pending-validation')
  const armProjectionRecheck = (): void => {
    if (pending === undefined) pending = setImmediate(check)
  }
  const raiseLatchedDivergence = (): void => {
    if (latched !== undefined) throw new AgentTeamInvariantError(latched)
  }
  ctx.on('agent-team/committed', () => {
    // Order matters: only a replay that comes back clean releases the latch, so
    // the recheck is armed before this call reports the divergence it holds.
    armProjectionRecheck()
    raiseLatchedDivergence()
  })
}

/** One string every invariant report identifies its divergence by. */
function divergenceText(error: unknown): string {
  return `durable ledger and Team projection diverged: ${String(error)}`
}
