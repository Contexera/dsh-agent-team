import { useCallback, useEffect, useRef } from 'react'

const BOTTOM_MARGIN_PX = 48

export interface TimelineScroll {
  readonly ref: React.RefObject<HTMLElement>
  onScroll: () => void
  isPinned: () => boolean
  scrollToBottom: () => void
}

/** Shared by Project and Thread: follow new facts only while pinned to the bottom, and keep prepended history stable. The content key must change whenever rendered facts change. */
export function useTimelineScroll(contentKey: string): TimelineScroll {
  const ref = useRef<HTMLElement>(null)
  const pinnedRef = useRef(true)
  const heightRef = useRef(0)

  const onScroll = useCallback(() => {
    const element = ref.current
    if (element === null) return
    pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_MARGIN_PX
  }, [])

  const scrollToBottom = useCallback(() => {
    const element = ref.current
    pinnedRef.current = true
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [])

  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const previousHeight = heightRef.current
    heightRef.current = element.scrollHeight
    if (pinnedRef.current) {
      element.scrollTop = element.scrollHeight
      return
    }
    // Prepended older history must not shift the content the reader is on.
    if (previousHeight > 0 && element.scrollHeight > previousHeight) {
      element.scrollTop += element.scrollHeight - previousHeight
    }
  }, [contentKey])

  return { ref, onScroll, isPinned: () => pinnedRef.current, scrollToBottom }
}
