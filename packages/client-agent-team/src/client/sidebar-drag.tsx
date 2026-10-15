/**
 * Native whole-row drag for the Team sidebar lists. Unlike the Harness
 * workspace list there is no document-level acceptance here: hovering another
 * row shows the before/after insertion marker and releasing on a row commits
 * exactly once per gesture, while a release outside any row — including over
 * the other sidebar list, whose panel never responds — just cancels without
 * committing.
 */
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import css from './sidebar.module.css'
import type { SidebarDropMarker } from './sidebar-order.ts'

export interface SidebarRowDragHandlers<K extends string> {
  readonly rowProps: (orderKey: K) => {
    readonly draggable: true
    readonly className?: string | undefined
    readonly onDragStart: (event: React.DragEvent<HTMLElement>) => void
    readonly onDragEnd: () => void
    readonly onDragOver: (event: React.DragEvent<HTMLElement>) => void
    readonly onDrop: (event: React.DragEvent<HTMLElement>) => void
  }
}

/**
 * One drag gesture per panel instance. `onCommit` receives the moved ref,
 * the drop target and the insertion side exactly once per completed gesture;
 * releases outside the list never reach it.
 */
export function useSidebarRowDrag<K extends string>({ refs, onCommit }: {
  /** Effective current order of the owning list, used for hit validation. */
  readonly refs: readonly K[]
  readonly onCommit: (movedRef: K, targetRef: K, marker: SidebarDropMarker) => void
}): SidebarRowDragHandlers<K> {
  const [state, setState] = useState<{ active: K; over: K; marker: SidebarDropMarker } | null>(null)
  const committed = useRef(false)

  const half = (event: React.DragEvent<HTMLElement>): SidebarDropMarker => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
  }

  return {
    rowProps: orderKey => ({
      draggable: true,
      className: state === null ? undefined
        : state.active === orderKey ? css.sidebarRowDragging
          : state.over === orderKey ? (state.marker === 'before' ? css.sidebarRowDropBefore : css.sidebarRowDropAfter)
            : undefined,
      onDragStart: event => {
        if (event.dataTransfer === null) return
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', orderKey)
        committed.current = false
        setState({ active: orderKey, over: orderKey, marker: 'after' })
      },
      onDragEnd: () => { setState(null) },
      onDragOver: event => {
        if (state === null || !refs.includes(orderKey)) return
        event.preventDefault()
        if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
        const marker = half(event)
        if (state.over !== orderKey || state.marker !== marker) setState({ ...state, over: orderKey, marker })
      },
      onDrop: event => {
        if (state === null || !refs.includes(orderKey)) return
        event.preventDefault()
        if (committed.current) return
        committed.current = true
        onCommit(state.active, orderKey, half(event))
      },
    }),
  }
}

/**
 * Transparent wrapper that owns the drop-marker styling for one draggable
 * sidebar row. It adds no layout of its own; the styled row stays inside so
 * hover/focus descendant selectors keep working.
 */
export function SortableRow<K extends string>({ drag, orderKey, children }: {
  readonly drag: SidebarRowDragHandlers<K>
  readonly orderKey: K
  readonly children: ReactNode
}) {
  const props = drag.rowProps(orderKey)
  return (
    <div {...props}>
      {children}
    </div>
  )
}
