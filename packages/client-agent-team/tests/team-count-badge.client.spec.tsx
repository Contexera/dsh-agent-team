// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { TeamCountBadge } from '../src/client/TeamCountBadge.tsx'

afterEach(cleanup)

function hasClassToken(element: Element, token: string): boolean {
  return [...element.classList].some(className => className.includes(token))
}

describe('TeamCountBadge', () => {
  it('renders nothing at zero, because zero is the absence of a count', () => {
    const { container } = render(<TeamCountBadge count={0} />)
    expect(container.querySelector('[data-team-count-badge]')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('caps a wide count at 99+ so the capsule never grows', () => {
    const { container: atCap } = render(<TeamCountBadge count={99} />)
    expect(atCap.textContent).toBe('99')
    cleanup()
    const { container: overCap } = render(<TeamCountBadge count={155} />)
    expect(overCap.textContent).toBe('99+')
  })

  it('stays decoration when the surrounding control already carries the number', () => {
    const { container } = render(<TeamCountBadge count={3} />)
    const badge = container.querySelector('[data-team-count-badge]')!
    expect(badge.getAttribute('aria-hidden')).toBe('true')
    expect(badge.getAttribute('role')).toBeNull()
  })

  it('names itself when the count is the only thing saying it', () => {
    const { container } = render(<TeamCountBadge count={3} label="3 条未读，其中 1 条提及" tone="hairline" className="hung" />)
    const badge = container.querySelector('[data-team-count-badge]')!
    expect(badge.getAttribute('data-team-count-badge')).toBe('hairline')
    expect(badge.getAttribute('role')).toBe('img')
    expect(badge.getAttribute('aria-label')).toBe('3 条未读，其中 1 条提及')
    expect(badge.getAttribute('title')).toBe('3 条未读，其中 1 条提及')
    expect(badge.textContent).toBe('3')
    expect(hasClassToken(badge, 'hairline')).toBe(true)
    expect(hasClassToken(badge, 'hung')).toBe(true)
  })
})
