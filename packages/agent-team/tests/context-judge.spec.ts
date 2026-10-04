/**
 * The long-gap gate's judge: what the Host row's key mounts, what clearing it
 * unmounts, and the one setting the gate and the judge must agree on — the
 * judge's own call budget, which is derived from the gate's deadline so a
 * configured judge can never be abandoned before it answers.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { judgeMountConfig, TeamContextJudge, type TeamContextJudgeConfig } from '../src/context-judge.ts'

/** One judge over a live Cordis context, with the row config a test controls. */
function judgeWith(config: TeamContextJudgeConfig | undefined, deadlineMs = 5_000) {
  const ctx = new Context()
  let row = config
  const judge = new TeamContextJudge(ctx, { config: () => row, deadlineMs: () => deadlineMs })
  return { judge, setRow: (next: TeamContextJudgeConfig | undefined) => { row = next } }
}

describe('the Team context judge', () => {
  it('mounts the judge from the row\'s key and reports it as enabled', async () => {
    const { judge } = judgeWith(undefined)

    // No key anywhere is the one state a Human can act on, and it is what the
    // settings surface states rather than reporting a failure.
    expect(judge.status()).toEqual({ enabled: false, reason: 'no-key', keyEnv: 'TYPESAFE_API_KEY' })

    const { judge: withKey } = judgeWith({ apiKey: 'key-from-the-row' })
    await withKey.sync()

    expect(withKey.judge()).toBeDefined()
    expect(withKey.status()).toEqual({ enabled: true, keyEnv: 'TYPESAFE_API_KEY' })
  })

  it('reads the key from the environment variable the row names', async () => {
    process.env.TEAM_JUDGE_TEST_KEY = 'key-from-the-environment'
    try {
      const { judge } = judgeWith({ apiKeyEnv: 'TEAM_JUDGE_TEST_KEY' })

      await judge.sync()

      expect(judge.judge()).toBeDefined()
      expect(judge.status()).toEqual({ enabled: true, keyEnv: 'TEAM_JUDGE_TEST_KEY' })
    } finally {
      delete process.env.TEAM_JUDGE_TEST_KEY
    }
  })

  it('leaves the gate off without a key, and unmounts when the key is cleared', async () => {
    const { judge, setRow } = judgeWith({ apiKey: 'key-from-the-row' })
    await judge.sync()
    expect(judge.judge()).toBeDefined()

    // Clearing the key is the switch: the mount goes away, and the status says
    // the one thing a Human can act on rather than reporting a failure.
    setRow({ apiKey: '' })
    await judge.sync()

    expect(judge.judge()).toBeUndefined()
    expect(judge.status()).toEqual({ enabled: false, reason: 'no-key', keyEnv: 'TYPESAFE_API_KEY' })
  })

  it('reports an unusable configuration as unavailable, with the Host\'s own diagnostic', async () => {
    const { judge } = judgeWith({ apiKey: 'key-from-the-row', apiBase: 'not-a-url' })

    await judge.sync()

    const status = judge.status()
    expect(status.enabled).toBe(false)
    expect(status.reason).toBe('unavailable')
    expect(status.detail).toBeTruthy()
  })

  it('gives the judge a budget inside the gate\'s deadline, with a floor', () => {
    // The gate abandons a judgement that outlives its deadline, so the judge's
    // own timeout must stay under it — and a deployment that set a tiny
    // deadline still gets a usable call rather than a zero budget. The second
    // attempt rides the same budget: one transport blip must not cost the step
    // its gate, and the wait before that attempt is short enough to leave the
    // deadline time to ask again.
    expect(judgeMountConfig(undefined, 'key', 'TYPESAFE_API_KEY', 5_000)).toMatchObject({
      apiKey: 'key',
      apiKeyEnv: 'TYPESAFE_API_KEY',
      timeoutMs: 4_000,
      attempts: 2,
      retryDelayMs: 500,
    })
    expect(judgeMountConfig({ model: 'm', apiBase: 'https://example.test/v1' }, 'key', 'K', 20_000)).toMatchObject({
      model: 'm',
      apiBase: 'https://example.test/v1',
      timeoutMs: 19_000,
    })
    expect(judgeMountConfig(undefined, 'key', 'K', 500).timeoutMs).toBe(1_000)
  })

  it('does not touch an unchanged mount, and re-configures a changed one', async () => {
    const ctx = new Context()
    let mounts = 0
    let updates = 0
    // A Context that counts what the judge asks of it: the seam this test needs,
    // because a mounted Cordis service is a proxy whose identity says nothing
    // about whether its fiber was restarted.
    const counting = new Proxy(ctx, {
      get: (target, property, receiver) => {
        if (property !== 'plugin') return Reflect.get(target, property, receiver)
        return (...args: unknown[]) => {
          mounts += 1
          const fiber = (target.plugin as (...rest: unknown[]) => object)(...args) as { update: (...rest: unknown[]) => void }
          const update = fiber.update.bind(fiber)
          fiber.update = (...next: unknown[]) => { updates += 1; update(...next) }
          return fiber
        }
      },
    }) as Context
    let row: TeamContextJudgeConfig | undefined = { apiKey: 'key-from-the-row', model: 'first' }
    const judge = new TeamContextJudge(counting, { config: () => row, deadlineMs: () => 5_000 })

    await judge.sync()
    expect(mounts).toBe(1)

    // A volatile write that changes nothing about the judge must not restart
    // the service the gate is using.
    await judge.sync()
    expect(mounts).toBe(1)
    expect(updates).toBe(0)

    row = { apiKey: 'key-from-the-row', model: 'second' }
    await judge.sync()
    expect(mounts).toBe(1)
    expect(updates).toBe(1)
    expect(judge.status().enabled).toBe(true)
  })
})
