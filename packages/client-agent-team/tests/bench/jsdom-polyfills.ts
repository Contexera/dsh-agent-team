import { vi } from 'vitest'

// jsdom has no ResizeObserver; the shipped ConversationRoot publishes the
// composer seat's height through one on every mount.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub)

// jsdom 30 implements no FontFaceSet at all, so `document.fonts` is absent
// while every real browser has one; the shipped composer control row subscribes
// to its 'loadingdone' event when it measures the two control groups.
if (document.fonts === undefined) {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  })
}

// A throwing slot entry is contained by the shipped SlotErrorBoundary and only
// reported through console.error: the surface disappears and the suite stays
// green. An incomplete `conversation` stub produced exactly that — 34 passing
// tests beside 51 `Invalid value used as weak map key` reports from
// 'conversation.composer.bar' — so a passing exit code is not evidence the page
// rendered. Collect those reports and fail the test that mounted them.
const slotCrashes: string[] = []
const consoleError = console.error.bind(console)
console.error = (...args: unknown[]): void => {
  const text = args.map(value => value instanceof Error ? `${value.name}: ${value.message}` : String(value)).join(' ')
  if (text.includes('slot entry crashed')) slotCrashes.push(text)
  consoleError(...args)
}

export function drainSlotCrashes(): string[] {
  return slotCrashes.splice(0)
}
