import { describe, expect, it, vi } from 'vitest'
import {
  createHumanUpdateChecker,
  fetchLatestVersion,
  HUMAN_UPDATE_CHECK_TTL_MS,
  isNewerVersion,
  isUpdateCheckEnabled,
  parseVersionCore,
  type UpdateCheckFetcher,
} from '../src/human-update-check.ts'

function okFetcher(version: unknown): UpdateCheckFetcher & { calls: number } {
  const fetcher: UpdateCheckFetcher & { calls: number } = Object.assign(
    async (_url: string, _init: { readonly signal: AbortSignal }) => {
      fetcher.calls += 1
      return { ok: true as const, json: async () => ({ version }) }
    },
    { calls: 0 },
  )
  return fetcher
}

function failingFetcher(): UpdateCheckFetcher & { calls: number } {
  const fetcher: UpdateCheckFetcher & { calls: number } = Object.assign(
    async (_url: string, _init: { readonly signal: AbortSignal }) => {
      fetcher.calls += 1
      throw new Error('offline')
    },
    { calls: 0 },
  )
  return fetcher
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('human update version ordering', () => {
  it('parses numeric cores and ignores suffixes', () => {
    expect(parseVersionCore('0.1.13')).toEqual([0, 1, 13])
    expect(parseVersionCore('0.1.14-rc.1')).toEqual([0, 1, 14])
    expect(parseVersionCore('1.0.0+build.7')).toEqual([1, 0, 0])
    expect(parseVersionCore('')).toBeUndefined()
    expect(parseVersionCore('latest')).toBeUndefined()
    expect(parseVersionCore('0.1.x')).toBeUndefined()
  })

  it('orders strictly on the numeric core', () => {
    expect(isNewerVersion('0.1.13', '0.1.14')).toBe(true)
    expect(isNewerVersion('0.1.13', '0.2.0')).toBe(true)
    expect(isNewerVersion('0.1.13', '0.1.13.1')).toBe(true)
    expect(isNewerVersion('0.1.13', '0.1.13')).toBe(false)
    expect(isNewerVersion('0.1.14', '0.1.13')).toBe(false)
    expect(isNewerVersion('0.1.13', 'garbage')).toBe(false)
    expect(isNewerVersion('0.1.13', '0.1.14-rc.1')).toBe(true)
  })
})

describe('human update check kill-switch', () => {
  it('stays on unless explicitly disabled', () => {
    expect(isUpdateCheckEnabled({})).toBe(true)
    expect(isUpdateCheckEnabled({ DSH_AGENT_TEAM_UPDATE_CHECK: '1' })).toBe(true)
    for (const off of ['0', 'false', 'FALSE', 'off', ' Off ']) {
      expect(isUpdateCheckEnabled({ DSH_AGENT_TEAM_UPDATE_CHECK: off })).toBe(false)
    }
  })
})

describe('human latest-version fetch', () => {
  it('resolves the published version and absorbs every failure as absent', async () => {
    await expect(fetchLatestVersion(okFetcher('0.1.14'))).resolves.toBe('0.1.14')
    await expect(fetchLatestVersion(failingFetcher())).resolves.toBeUndefined()
    await expect(fetchLatestVersion(okFetcher(42))).resolves.toBeUndefined()
    await expect(fetchLatestVersion(okFetcher(undefined))).resolves.toBeUndefined()
    const notFound = (async () => ({ ok: false, json: async () => ({}) })) as UpdateCheckFetcher
    await expect(fetchLatestVersion(notFound)).resolves.toBeUndefined()
  })
})

describe('human update checker cache', () => {
  it('serves unknown synchronously and publishes a newer release once observed', async () => {
    const fetchImpl = okFetcher('0.1.14')
    const checker = createHumanUpdateChecker({ currentVersion: '0.1.13', fetchImpl, env: {} })
    expect(checker.snapshot()).toEqual({})
    await flush()
    expect(checker.snapshot()).toEqual({ latestVersion: '0.1.14' })
    expect(fetchImpl.calls).toBe(1)
  })

  it('stays quiet when the published release is not newer', async () => {
    const fetchImpl = okFetcher('0.1.13')
    const checker = createHumanUpdateChecker({ currentVersion: '0.1.13', fetchImpl, env: {} })
    checker.snapshot()
    await flush()
    expect(checker.snapshot()).toEqual({})
  })

  it('shares one refresh across concurrent snapshots and re-checks after the TTL', async () => {
    let now = 1_000
    const fetchImpl = okFetcher('0.1.13')
    const checker = createHumanUpdateChecker({ currentVersion: '0.1.13', fetchImpl, now: () => now, env: {} })
    checker.snapshot()
    checker.snapshot()
    await flush()
    expect(fetchImpl.calls).toBe(1)
    now += HUMAN_UPDATE_CHECK_TTL_MS
    checker.snapshot()
    await flush()
    expect(fetchImpl.calls).toBe(2)
  })

  it('never throws and never calls out when disabled or offline', async () => {
    const onSpy = vi.fn()
    const disabled = createHumanUpdateChecker({
      currentVersion: '0.1.13',
      fetchImpl: (async () => {
        onSpy()
        return { ok: true, json: async () => ({ version: '9.9.9' }) }
      }) as UpdateCheckFetcher,
      env: { DSH_AGENT_TEAM_UPDATE_CHECK: '0' },
    })
    expect(disabled.snapshot()).toEqual({})
    await flush()
    expect(onSpy).not.toHaveBeenCalled()

    const offline = createHumanUpdateChecker({ currentVersion: '0.1.13', fetchImpl: failingFetcher(), env: {} })
    expect(offline.snapshot()).toEqual({})
    await flush()
    expect(offline.snapshot()).toEqual({})
  })
})
