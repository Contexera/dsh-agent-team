// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { AgentTeamClientMemberStatus } from '@contexera/dsh-agent-team/types'
import { zh } from '../src/client/locales.ts'
import type { TeamSidebarProps } from '../src/client/slots.ts'
import { TeamMemberAvatar } from '../src/client/TeamMemberAvatar.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as TeamSidebarProps['t']

/** A Member at its simplest: an available row whose handle is all this component reads. */
function member(handle: string): AgentTeamClientMemberStatus {
  return { presence: 'available', member: { memberId: 'member:balloon', handle } } as unknown as AgentTeamClientMemberStatus
}

/** The initial as the avatar renders it, badge excluded by taking the leading code point. */
function initialOf(handle: string): string {
  const { container } = render(<TeamMemberAvatar status={member(handle)} t={t} />)
  const avatar = container.querySelector('[role="img"]')!
  return [...(avatar.textContent ?? '')][0] ?? ''
}

/** A UTF-16 unit that no code point produced: what a cut through an astral character leaves behind. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe('Member avatar initial', () => {
  it('renders a whole astral character when the handle starts with one', () => {
    expect(initialOf('🎈builder')).toBe('🎈')
    // The same handle without its `@` reads the same, and `@` before an emoji is not a cut point.
    expect(initialOf('@🎈builder')).toBe('🎈')
    expect(LONE_SURROGATE.test(initialOf('🎈builder'))).toBe(false)
  })

  it('keeps an ASCII initial uppercased', () => {
    expect(initialOf('@builder')).toBe('B')
    expect(initialOf('reviewer')).toBe('R')
  })
})
