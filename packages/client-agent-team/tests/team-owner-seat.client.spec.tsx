// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { AgentTeamAgentMember, AgentTeamInboxActor, AgentTeamMainThreadCard, AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import { zh } from '../src/client/locales.ts'
import type { TeamConversationProps } from '../src/client/slots.ts'
import { TeamThreadCard } from '../src/client/TeamThreadCard.tsx'
import { accountableLabel, accountableWord } from '../src/client/team-formatters.ts'

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as TeamConversationProps['t']

afterEach(cleanup)

const humanMemberId = 'member:human' as AgentTeamMemberId
const builder = { memberId: 'member:builder' as AgentTeamMemberId, name: 'builder' } as const

function card(task: Partial<NonNullable<AgentTeamMainThreadCard['task']>> = {}): AgentTeamMainThreadCard {
  return {
    threadRef: 'thread:1' as never,
    anchor: { messageRef: 'message:1' as never, sender: 'member:builder' as AgentTeamMemberId, preview: '实现 API 网关', sequence: 1, occurredAt: '2026-11-05T04:00:00.000Z' },
    task: { taskRef: 'task:1' as never, taskNumber: 1, status: 'in_progress', resolution: 'open', accountable: builder.memberId, liveClaimOwners: [], ...task },
    replyCount: 0,
    participants: [],
    newestSequence: 1,
    newestOccurredAt: '2026-11-05T04:00:00.000Z',
    newestActor: builder,
  }
}

describe('Task owner standing', () => {
  it('names another Member by handle, the reader in the second person, and a suspended owner as a standing', () => {
    expect(accountableLabel(builder, humanMemberId, t)).toBe('负责人 @builder')
    expect(accountableLabel({ ...builder, memberId: humanMemberId }, humanMemberId, t)).toBe('你负责')
    expect(accountableLabel({ ...builder, state: 'suspended' as AgentTeamAgentMember['state'] }, humanMemberId, t)).toBe('负责人已暂停')
  })

  it('writes one @ however the name arrived, so a roster handle and a Host name read alike', () => {
    expect(accountableLabel(builder, humanMemberId, t)).toBe(accountableLabel({ ...builder, name: '@builder' }, humanMemberId, t))
  })

  it('writes the seat in one word, because the face beside it already names the person', () => {
    expect(accountableWord(builder, humanMemberId, t)).toBe('负责')
    expect(accountableWord({ ...builder, memberId: humanMemberId }, humanMemberId, t)).toBe('你负责')
    expect(accountableWord({ ...builder, state: 'suspended' as AgentTeamAgentMember['state'] }, humanMemberId, t)).toBe('负责 · 已暂停')
  })
})

describe('Task card owner', () => {
  it('shows the accountable beside the status and states them in the accessible name', () => {
    const owner: AgentTeamInboxActor = builder
    const { container } = render(<TeamThreadCard card={card()} unread={false} human={undefined} humanMemberId={humanMemberId}
      accountableOwner={owner} t={t} onOpen={() => {}} />)
    // The face is the person's initial, the words say only the role, and the seat speaks the whole sentence.
    expect(container.querySelector('[data-team-owner]')?.textContent).toBe(`B负责`)
    expect(container.querySelector('[data-team-owner]')?.getAttribute('aria-label')).toBe('负责人 @builder')
    expect(container.querySelector('[data-team-owner]')?.getAttribute('title')).toBe('负责人 @builder')
    expect(container.querySelector('button')?.getAttribute('aria-label')).toContain('负责人 @builder')
    cleanup()

    // Without the roster's answer the card still states the Task it can: no owner line, no invented name.
    const { container: unresolved } = render(<TeamThreadCard card={card()} unread={false} human={undefined} humanMemberId={humanMemberId}
      accountableOwner={undefined} t={t} onOpen={() => {}} />)
    expect(unresolved.querySelector('[data-team-owner]')).toBeNull()
    expect(unresolved.querySelector('button')?.getAttribute('aria-label')).not.toContain('负责人')
    cleanup()

    // Nothing was drawn at a seat, so there is no duplicate to remove: the accountable keeps their face in the group.
    const { container: unseated } = render(<TeamThreadCard card={card({ liveClaimOwners: [builder] })} unread={false}
      human={undefined} humanMemberId={humanMemberId} accountableOwner={undefined} t={t} onOpen={() => {}} />)
    expect(unseated.querySelector('[class*="cardExecutor"] [role="img"]')?.getAttribute('aria-label')).toBe('由 @builder 认领')
  })

  it('keeps the executors apart from the owner by naming their group, as the board card does', () => {
    const owner: AgentTeamInboxActor = builder
    const claimed = card({ liveClaimOwners: [{ memberId: 'member:ana' as AgentTeamMemberId, name: 'ana' }] })
    const { container } = render(<TeamThreadCard card={claimed} unread={false} human={undefined} humanMemberId={humanMemberId}
      accountableOwner={owner} t={t} onOpen={() => {}} />)
    const executors = container.querySelector('[class*="cardExecutor"]')
    expect(executors?.textContent).toContain('认领')
    expect(executors?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('由 @ana 认领')
  })

  it('draws the owner once when they also hold a Claim, and keeps the card naming every hand it has', () => {
    const owner: AgentTeamInboxActor = builder
    const claimed = card({ liveClaimOwners: [builder, { memberId: 'member:ana' as AgentTeamMemberId, name: 'ana' }] })
    const { container } = render(<TeamThreadCard card={claimed} unread={false} human={undefined} humanMemberId={humanMemberId}
      accountableOwner={owner} t={t} onOpen={() => {}} />)
    // The seat is the owner's only circle; the group lists the other claimant.
    expect(container.querySelectorAll('[class*="cardExecutor"] [role="img"]')).toHaveLength(1)
    expect(container.querySelector('[class*="cardExecutor"] [role="img"]')?.getAttribute('aria-label')).toBe('由 @ana 认领')
    // The card's own name still states the whole roster: it summarises the Task rather than the circles drawn.
    expect(container.querySelector('button')?.getAttribute('aria-label')).toContain('由 @builder, @ana 认领')
    cleanup()

    // Working alone leaves the seat as the card's whole statement about people, and never reads as awaiting a claim.
    const { container: alone } = render(<TeamThreadCard card={card({ liveClaimOwners: [builder] })} unread={false}
      human={undefined} humanMemberId={humanMemberId} accountableOwner={owner} t={t} onOpen={() => {}} />)
    expect(alone.querySelector('[class*="cardExecutor"]')).toBeNull()
    expect(alone.textContent).not.toContain('待认领')
  })
})
