/**
 * Team's relatedness judge: the long-gap gate's `jev` service, mounted by this
 * bundle when a key resolves and left unmounted when none does.
 *
 * The key is the switch, so nothing here decides policy: a key in the Host
 * row's `jev` config — or in the environment variable that config names —
 * mounts the service, clearing it unmounts the service, and the gate asks
 * whatever is mounted. A deployment that mounts its own `jev` row keeps
 * working, because the judge is read as a service rather than as this mount.
 *
 * The mount also carries the one setting the two sides must agree on: jev's own
 * call budget is derived from the gate's deadline, so a judge can never be
 * configured to outlive the time the gate gives it — the mismatch that would
 * otherwise leave every long-gap step ungated without a word.
 * @module @wowyuarm/dsh-agent-team/context-judge
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import { DEFAULT_API_KEY_ENV, Jev, type JevPluginConfig } from '@wowyuarm/dsh-jev'
import type { PressureJudgement } from '@wowyuarm/dsh-context-continuity'

/** The Host row's `jev` config: where the judge's key, endpoint and model come from. */
export interface TeamContextJudgeConfig {
  readonly apiKey?: string | undefined
  readonly apiKeyEnv?: string | undefined
  readonly model?: string | undefined
  readonly apiBase?: string | undefined
}

/**
 * The judge's call budget keeps this much of the gate's deadline for the hop
 * back: the gate abandons a judgement that outlives its own deadline, so a
 * judge allowed to use the whole deadline would always be abandoned first.
 */
const JUDGE_DEADLINE_MARGIN_MS = 1_000

/** The key a row states, or the one the named environment variable holds. */
function resolvedKey(config: TeamContextJudgeConfig | undefined, envName: string): string | undefined {
  const stated = config?.apiKey
  if (stated !== undefined && stated !== '') return stated
  const fromEnv = process.env[envName]
  return fromEnv === undefined || fromEnv === '' ? undefined : fromEnv
}

/**
 * The config one mount runs with. Exported because it is the whole contract
 * between the gate's deadline and the judge's own budget, and a pure function
 * is what a test can hold still.
 */
export function judgeMountConfig(
  config: TeamContextJudgeConfig | undefined,
  key: string,
  envName: string,
  deadlineMs: number,
): JevPluginConfig {
  return {
    apiKey: key,
    apiKeyEnv: envName,
    ...(config?.model === undefined ? {} : { model: config.model }),
    ...(config?.apiBase === undefined ? {} : { apiBase: config.apiBase }),
    timeoutMs: Math.max(JUDGE_DEADLINE_MARGIN_MS, deadlineMs - JUDGE_DEADLINE_MARGIN_MS),
    // One attempt: a retry budget belongs to a background pass, and this call
    // sits on the path that starts a turn.
    attempts: 1,
  }
}

/** The judge's status as the Team settings surface reads it. */
export interface TeamContextJudgeStatus {
  /** Whether a judge is reachable for the next step. */
  readonly enabled: boolean
  /** Why no judge is reachable; absent when one is. */
  readonly reason?: 'no-key' | 'unavailable' | undefined
  /** Host-side diagnostic behind `unavailable`; never rendered as user copy. */
  readonly detail?: string | undefined
  /** The environment variable this deployment reads the key from. */
  readonly keyEnv: string
}

/**
 * One Host's judge: the service it mounted, the failure that kept one from
 * mounting, and the reconciliation that keeps the two in step with the row.
 */
export class TeamContextJudge {
  private fiber: Fiber | undefined
  private failure: string | undefined
  /** The mount the live fiber runs with, so an unchanged row does not restart it. */
  private mounted: string | undefined

  constructor(
    private readonly ctx: Context,
    private readonly options: {
      /** The Host row's live `jev` config. */
      readonly config: () => TeamContextJudgeConfig | undefined
      /** The gate's effective judgement deadline, in milliseconds. */
      readonly deadlineMs: () => number
    },
  ) {}

  /**
   * The judge a step may ask, or undefined when the deployment has none: this
   * bundle's own mount first, then a service another row mounted.
   */
  judge(): PressureJudgement | undefined {
    return this.fiber?.ctx.get('jev') ?? this.ctx.get('jev')
  }

  /** The environment variable this deployment reads the key from. */
  keyEnv(): string {
    const name = this.options.config()?.apiKeyEnv
    return name === undefined || name === '' ? DEFAULT_API_KEY_ENV : name
  }

  /** Whether a key is resolvable right now, from the row or from its environment. */
  private key(): string | undefined {
    return resolvedKey(this.options.config(), this.keyEnv())
  }

  /**
   * Make the mount match the row: mount when a key resolves and none is
   * mounted, re-configure a live mount whose settings changed, unmount when the
   * key is gone. Called at init and on every volatile update of the row, so a
   * key written in the Team settings surface takes effect without a restart.
   */
  async sync(): Promise<void> {
    const config = this.options.config()
    const key = this.key()
    if (key === undefined) {
      this.failure = undefined
      await this.unmount()
      return
    }
    const wanted = judgeMountConfig(config, key, this.keyEnv(), this.options.deadlineMs())
    const signature = JSON.stringify(wanted)
    if (this.fiber !== undefined && signature === this.mounted) return
    if (this.fiber === undefined) {
      this.fiber = this.ctx.plugin(Jev, wanted)
      this.mounted = signature
    } else {
      this.mounted = signature
      // `update` re-activates the fiber with the new config, and clears a
      // previous failure, so a corrected endpoint recovers without a restart.
      this.fiber.update(wanted)
    }
    try {
      await this.fiber.await()
      this.failure = undefined
    } catch (error) {
      // A rejected key or endpoint is a configuration failure the settings
      // surface reports: the row keeps what the Human wrote, and the status
      // says why the judge is not answering.
      this.failure = error instanceof Error ? error.message : String(error)
    }
  }

  /** Drop this bundle's mount, if it has one. */
  private async unmount(): Promise<void> {
    const fiber = this.fiber
    this.fiber = undefined
    this.mounted = undefined
    if (fiber !== undefined) await fiber.dispose()
  }

  /** What the Team settings surface states about the judge. */
  status(): TeamContextJudgeStatus {
    const keyEnv = this.keyEnv()
    if (this.judge() !== undefined) return { enabled: true, keyEnv }
    return {
      enabled: false,
      reason: this.key() === undefined ? 'no-key' : 'unavailable',
      ...(this.failure === undefined ? {} : { detail: this.failure }),
      keyEnv,
    }
  }
}
