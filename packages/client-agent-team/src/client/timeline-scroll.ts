import { useCallback, useLayoutEffect, useRef } from 'react'

const BOTTOM_MARGIN_PX = 48
const POSITION_EPSILON_PX = 0.5

interface Anchor {
  readonly messageRef: string
  readonly top: number
}

export interface TimelineScroll {
  readonly ref: React.RefObject<HTMLElement>
  onScroll: () => void
  isPinned: () => boolean
  scrollToBottom: () => void
}

function messageTop(element: HTMLElement, message: HTMLElement): number {
  return message.getBoundingClientRect().top - element.getBoundingClientRect().top
}

function visibleMessage(element: HTMLElement): HTMLElement | undefined {
  const viewportTop = element.getBoundingClientRect().top
  const viewportBottom = viewportTop + element.clientHeight
  let partial: HTMLElement | undefined
  for (const message of element.querySelectorAll<HTMLElement>('[data-message-ref]')) {
    const box = message.getBoundingClientRect()
    if (box.bottom <= viewportTop || box.top >= viewportBottom) continue
    if (box.top >= viewportTop) return message
    partial ??= message
  }
  return partial
}

function messageByRef(element: HTMLElement, messageRef: string): HTMLElement | undefined {
  for (const message of element.querySelectorAll<HTMLElement>('[data-message-ref]')) {
    if (message.getAttribute('data-message-ref') === messageRef) return message
  }
  return undefined
}

/** Shared by Project and Thread: follow new facts only while pinned to the bottom, and hold one visible Message at the same viewport offset when content changes. The content key must change whenever rendered facts change. */
export function useTimelineScroll(contentKey: string): TimelineScroll {
  const ref = useRef<HTMLElement>(null)
  const pinnedRef = useRef(true)
  const anchorRef = useRef<Anchor>()
  const correctedTop = useRef<number>()

  // A scroll event for a component-owned write may arrive after content grows. Remember an actual
  // position change so that stale event cannot be mistaken for the reader leaving the tail.
  const writeScrollTop = useCallback((element: HTMLElement, top: number): void => {
    const previousTop = element.scrollTop
    element.scrollTop = top
    if (Math.abs(element.scrollTop - previousTop) >= POSITION_EPSILON_PX) correctedTop.current = element.scrollTop
  }, [])

  const captureAnchor = useCallback(() => {
    const element = ref.current
    if (element === null) return
    const message = visibleMessage(element)
    const messageRef = message?.getAttribute('data-message-ref')
    anchorRef.current = message === undefined || messageRef === null || messageRef === undefined
      ? undefined
      : { messageRef, top: messageTop(element, message) }
  }, [])

  const preserveAnchor = useCallback(() => {
    const element = ref.current
    if (element === null) return
    if (pinnedRef.current) {
      writeScrollTop(element, element.scrollHeight)
      captureAnchor()
      return
    }
    const anchor = anchorRef.current
    const message = anchor === undefined ? undefined : messageByRef(element, anchor.messageRef)
    if (anchor !== undefined && message !== undefined) {
      const delta = messageTop(element, message) - anchor.top
      // A change below the anchor increases the total height but does not move this row.
      if (Math.abs(delta) < POSITION_EPSILON_PX) return
      const target = element.scrollTop + delta
      writeScrollTop(element, target)
      // A single page can commit before its images finish. Keep the same
      // anchor through all of those layouts unless a scroll bound stops us.
      if (Math.abs(element.scrollTop - target) < POSITION_EPSILON_PX) return
    }
    captureAnchor()
  }, [captureAnchor, writeScrollTop])

  const onScroll = useCallback(() => {
    const element = ref.current
    if (element === null) return
    const corrected = correctedTop.current
    correctedTop.current = undefined
    if (corrected !== undefined && Math.abs(element.scrollTop - corrected) < POSITION_EPSILON_PX) return
    pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_MARGIN_PX
    if (!pinnedRef.current) captureAnchor()
  }, [captureAnchor])

  const scrollToBottom = useCallback(() => {
    const element = ref.current
    pinnedRef.current = true
    if (element === null) return
    writeScrollTop(element, element.scrollHeight)
    captureAnchor()
  }, [captureAnchor, writeScrollTop])

  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    // This hook preserves the same Message itself. Leaving Chromium's native
    // anchoring enabled creates two scroll owners and can double-count a
    // layout change before the next measurement sees the final scrollTop.
    const previousOverflowAnchor = element.style.getPropertyValue('overflow-anchor')
    element.style.setProperty('overflow-anchor', 'none')
    preserveAnchor()
    let frame: number | undefined
    const onLoad = (event: Event): void => {
      if (!(event.target instanceof HTMLImageElement)) return
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = undefined
        preserveAnchor()
      })
    }
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(preserveAnchor)
    resizeObserver?.observe(element)
    const content = element.firstElementChild
    if (content !== null) resizeObserver?.observe(content)
    // Pagination can remount a message run and its images. Capture image loads
    // on the timeline so the second layout change cannot be missed.
    element.addEventListener('load', onLoad, true)
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      element.removeEventListener('load', onLoad, true)
      if (previousOverflowAnchor === '') element.style.removeProperty('overflow-anchor')
      else element.style.setProperty('overflow-anchor', previousOverflowAnchor)
    }
  }, [contentKey, preserveAnchor])

  return { ref, onScroll, isPinned: () => pinnedRef.current, scrollToBottom }
}
