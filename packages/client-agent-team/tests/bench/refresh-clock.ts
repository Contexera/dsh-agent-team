import { act } from '@testing-library/react'
import { expect, onTestFinished, vi } from 'vitest'

export function useRefreshClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true, advanceTimeDelta: 1 })
  onTestFinished(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })
}

export async function flushRefreshes(bench: { changeDispatchesReady(): Promise<void> }): Promise<void> {
  await act(async () => { await bench.changeDispatchesReady() })
  for (let pass = 0; pass < 100 && vi.getTimerCount() > 0; pass += 1) {
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
      await bench.changeDispatchesReady()
    })
  }
  expect(vi.getTimerCount(), 'all refresh timers drained').toBe(0)
}
