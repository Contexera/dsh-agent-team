import { vi } from 'vitest'

const clock = vi.hoisted(() => ({ intervalMs: 1 }))

export function subscriptionTickInterval(intervalMs: number): void {
  clock.intervalMs = intervalMs
}

vi.mock('../../src/subscription-runtime.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/subscription-runtime.ts')>()
  return {
    ...actual,
    SubscriptionScheduler: class extends actual.SubscriptionScheduler {
      constructor(ports: ConstructorParameters<typeof actual.SubscriptionScheduler>[0]) {
        const intervalMs = clock.intervalMs
        super({ ...ports, schedule: run => ports.schedule(run, intervalMs) })
      }
    },
  }
})
