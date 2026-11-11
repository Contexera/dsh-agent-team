// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLayoutEffect, useState } from 'react'
import { useTimelineScroll } from '../src/client/timeline-scroll.ts'

interface Layout {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
  anchorTop: number
}

let layout: Layout
let observers: MockResizeObserver[]
let pinnedAfterScroll: boolean | undefined

class MockResizeObserver {
  readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    observers.push(this)
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function TimelineHarness(): React.ReactElement {
  const [revision, setRevision] = useState(0)
  const timeline = useTimelineScroll(String(revision))
  useLayoutEffect(() => {
    const root = timeline.ref.current
    if (root === null) return
    const anchor = root.querySelector<HTMLElement>('[data-message-ref="message:anchor"]')
    if (anchor === null) return
    Object.defineProperties(root, {
      scrollHeight: { configurable: true, get: () => layout.scrollHeight },
      clientHeight: { configurable: true, get: () => layout.clientHeight },
      scrollTop: {
        configurable: true,
        get: () => layout.scrollTop,
        set: (value: number) => {
          layout.scrollTop = Math.max(0, Math.min(value, layout.scrollHeight - layout.clientHeight))
        },
      },
    })
    root.getBoundingClientRect = () => ({ top: 0, bottom: layout.clientHeight } as DOMRect)
    anchor.getBoundingClientRect = () => ({ top: layout.anchorTop - layout.scrollTop, bottom: layout.anchorTop - layout.scrollTop + 40 } as DOMRect)
  }, [timeline.ref])

  return <section
    ref={timeline.ref}
    onScroll={timeline.onScroll}
    aria-label="test timeline"
  >
    <div>
      <MutableContent />
      <article
        key={revision}
        data-message-ref="message:anchor"
        ref={element => {
          if (element === null) return
          element.getBoundingClientRect = () => ({
            top: layout.anchorTop - layout.scrollTop,
            bottom: layout.anchorTop - layout.scrollTop + 40,
          } as DOMRect)
        }}
      >the message the reader is watching</article>
    </div>
    <button type="button" data-action="change" onClick={() => { setRevision(value => value + 1) }}>change content</button>
  </section>
}

function MutableContent(): React.ReactElement {
  const [loaded, setLoaded] = useState(false)
  return loaded
    ? <img src="data:image/png;base64,AA==" alt="loaded" />
    : <button type="button" data-action="load-image" onClick={() => { setLoaded(true) }}>finish image</button>
}

function InitialBottomHarness(): React.ReactElement {
  const timeline = useTimelineScroll('initial')
  return <section
    ref={root => {
      Object.assign(timeline.ref, { current: root })
      if (root === null) return
      Object.defineProperties(root, {
        scrollHeight: { configurable: true, get: () => layout.scrollHeight },
        clientHeight: { configurable: true, get: () => layout.clientHeight },
        scrollTop: {
          configurable: true,
          get: () => layout.scrollTop,
          set: (value: number) => {
            layout.scrollTop = Math.max(0, Math.min(value, layout.scrollHeight - layout.clientHeight))
          },
        },
      })
      root.getBoundingClientRect = () => ({ top: 0, bottom: layout.clientHeight } as DOMRect)
    }}
    onScroll={() => {
      timeline.onScroll()
      pinnedAfterScroll = timeline.isPinned()
    }}
    aria-label="initial timeline"
  >
    <div>initial content</div>
    <button type="button" data-action="scroll-bottom" onClick={timeline.scrollToBottom}>scroll to bottom</button>
  </section>
}

function moveReaderAwayFromBottom(): void {
  layout.scrollTop = 120
  const timeline = document.querySelector<HTMLElement>('section[aria-label="test timeline"]')!
  fireEvent.scroll(timeline)
}

async function changeContent(): Promise<void> {
  fireEvent.click(document.querySelector('button[data-action="change"]')!)
  await waitFor(() => { expect(document.querySelector('button[data-action="change"]')).toBeTruthy() })
}

function resize(): void {
  const observer = observers.at(-1)
  if (observer === undefined) throw new Error('the timeline did not observe its content')
  act(() => { observer.callback([], observer) })
}

beforeEach(() => {
  layout = { scrollHeight: 300, scrollTop: 0, clientHeight: 100, anchorTop: 180 }
  observers = []
  pinnedAfterScroll = undefined
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useTimelineScroll', () => {
  it('keeps the initial bottom pin when growth precedes its queued scroll event', () => {
    render(<InitialBottomHarness />)
    expect(layout.scrollTop).toBe(200)
    fireEvent.click(document.querySelector<HTMLButtonElement>('button[data-action="scroll-bottom"]')!)

    layout.scrollHeight += 100
    fireEvent.scroll(document.querySelector<HTMLElement>('section[aria-label="initial timeline"]')!)
    expect(pinnedAfterScroll).toBe(true)
    resize()

    expect(layout.scrollTop).toBe(300)
  })

  it('does not mistake a no-op initial bottom write for owned movement', () => {
    layout = { scrollHeight: 100, scrollTop: 0, clientHeight: 100, anchorTop: 180 }
    render(<InitialBottomHarness />)

    layout.scrollHeight = 1000
    layout.clientHeight = 120
    fireEvent.scroll(document.querySelector<HTMLElement>('section[aria-label="initial timeline"]')!)

    expect(pinnedAfterScroll).toBe(false)
  })

  it('leaves a visible message in place when content is appended below it', async () => {
    render(<TimelineHarness />)
    moveReaderAwayFromBottom()
    const before = layout.anchorTop - layout.scrollTop

    layout.scrollHeight += 100
    await changeContent()

    expect(layout.anchorTop - layout.scrollTop).toBe(before)
  })

  it('does not compensate twice when Chromium has already anchored prepended history', async () => {
    render(<TimelineHarness />)
    expect(document.querySelector<HTMLElement>('section[aria-label="test timeline"]')!.style.getPropertyValue('overflow-anchor')).toBe('none')
    moveReaderAwayFromBottom()
    const before = layout.anchorTop - layout.scrollTop

    layout.scrollHeight += 100
    layout.anchorTop += 100
    layout.scrollTop += 100
    await changeContent()

    expect(layout.anchorTop - layout.scrollTop).toBe(before)
  })

  it('compensates prepended history when the browser has not anchored it', async () => {
    render(<TimelineHarness />)
    moveReaderAwayFromBottom()
    const before = layout.anchorTop - layout.scrollTop

    layout.scrollHeight += 100
    layout.anchorTop += 100
    await changeContent()

    expect(layout.anchorTop - layout.scrollTop).toBe(before)
  })

  it('restores the same message when an image above it finishes loading and ignores growth below it', async () => {
    render(<TimelineHarness />)
    moveReaderAwayFromBottom()
    const before = layout.anchorTop - layout.scrollTop

    layout.scrollHeight += 96
    resize()
    expect(layout.anchorTop - layout.scrollTop).toBe(before)

    layout.anchorTop += 96
    resize()
    expect(layout.anchorTop - layout.scrollTop).toBe(before)
  })

  it('preserves the anchor when a remounted image loads without a resize notification', async () => {
    render(<TimelineHarness />)
    moveReaderAwayFromBottom()
    const before = layout.anchorTop - layout.scrollTop

    layout.scrollHeight += 96
    layout.anchorTop += 96
    fireEvent.click(document.querySelector('button[data-action="load-image"]')!)
    fireEvent.load(document.querySelector('img[alt="loaded"]')!)
    await act(async () => {
      await new Promise<void>(resolve => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }) })
    })
    expect(layout.anchorTop - layout.scrollTop).toBe(before)

    layout.scrollHeight += 100
    layout.anchorTop += 100
    await changeContent()
    expect(layout.anchorTop - layout.scrollTop).toBe(before)
  })
})
