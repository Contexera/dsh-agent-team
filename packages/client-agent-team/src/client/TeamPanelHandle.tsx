import { useCallback, useEffect, useRef, useState } from 'react'
import channelCss from './channel.module.css'
import { PANEL_MAX, PANEL_MIN, clampPanelWidth, readPanelWidthPreference, writePanelWidthPreference } from './panel-width.ts'

const STEP = 24
const COARSE_STEP = 96

/** Re-seats the discussion panel through one CSS variable on the surface, so a drag never re-renders either side. The keyboard path is required: without it keyboard readers cannot change the seat. */
export function TeamPanelHandle({ surface, label }: {
  readonly surface: HTMLElement | null
  readonly label: string
}) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const base = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)

  const apply = useCallback((requested: number) => {
    if (surface === null) return 0
    const width = clampPanelWidth(requested, surface.offsetWidth)
    surface.style.setProperty('--team-panel-width', `${width}px`)
    return width
  }, [surface])

  const current = useCallback((): number => {
    if (surface === null) return PANEL_MIN
    const declared = Number.parseFloat(getComputedStyle(surface).getPropertyValue('--team-panel-width'))
    return Number.isFinite(declared) ? declared : clampPanelWidth(surface.offsetWidth * 0.52, surface.offsetWidth)
  }, [surface])

  // Once per mounted surface: the choice follows the reader across channels, each
  // re-clamping it to its own width.
  useEffect(() => {
    if (surface === null) return
    const preference = readPanelWidthPreference()
    if (preference !== null) apply(preference)
  }, [surface, apply])

  const cancelFrame = () => {
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
  }
  useEffect(() => cancelFrame, [])

  const commit = useCallback((width: number) => {
    if (surface === null) return
    writePanelWidthPreference(clampPanelWidth(width, surface.offsetWidth))
  }, [surface])

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.toggleAttribute('data-dragging', true)
    origin.current = event.clientX
    latest.current = event.clientX
    base.current = current()
    setDragging(true)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    latest.current = event.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      apply(base.current - (latest.current - origin.current))
    })
  }

  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.currentTarget.toggleAttribute('data-dragging', false)
    event.currentTarget.releasePointerCapture(event.pointerId)
    cancelFrame()
    setDragging(false)
    latest.current = event.clientX
    // A press without movement keeps the saved seat rather than writing one.
    if (latest.current !== origin.current) commit(apply(base.current - (latest.current - origin.current)))
  }

  const onPointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return
    event.currentTarget.toggleAttribute('data-dragging', false)
    cancelFrame()
    setDragging(false)
    // Cancellation abandons the gesture: the saved seat comes back untouched.
    const preference = readPanelWidthPreference()
    apply(preference ?? current())
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? COARSE_STEP : STEP
    // ArrowLeft gives the panel more room, because the seam travels left.
    const delta = event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0
    if (delta === 0) return
    event.preventDefault()
    const width = apply(current() + delta)
    if (width !== 0) commit(width)
  }

  return (
    <button
      type="button"
      className={channelCss.panelHandle}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(current())}
      aria-valuemin={PANEL_MIN}
      aria-valuemax={PANEL_MAX}
      data-team-panel-handle=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onKeyDown={onKeyDown}
    />
  )
}
