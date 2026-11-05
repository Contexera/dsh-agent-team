// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { AgentTeamMemberId, AgentTeamProjectRef, AgentTeamTaskBoardItem, AgentTeamTaskRef, AgentTeamThreadRef } from '@contexera/dsh-agent-team/types'
import { zh } from '../src/client/locales.ts'
import type { TeamConversationProps } from '../src/client/slots.ts'
import { BoardCardFoot } from '../src/client/BoardCardFoot.tsx'

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as TeamConversationProps['t']

afterEach(cleanup)

const member = (name: string) => ({ memberId: `member:${name}` as AgentTeamMemberId, name })
const humanMemberId = 'member:human' as AgentTeamMemberId

function item(status: AgentTeamTaskBoardItem['task']['status'], executors: readonly string[]): AgentTeamTaskBoardItem {
  return {
    workspaceId: 'w1' as never,
    projectRef: 'project:p' as AgentTeamProjectRef,
    projectName: 'engineering',
    task: {
      taskRef: 'task:1' as AgentTeamTaskRef, projectRef: 'project:p' as AgentTeamProjectRef, threadRef: 'thread:1' as AgentTeamThreadRef,
      status, resolution: 'open', accountable: 'member:lead' as AgentTeamMemberId, sourceThreadRefs: [],
    },
    taskNumber: 1,
    threadRef: 'thread:1' as AgentTeamThreadRef,
    subject: 'a task',
    liveClaimOwners: executors.map(name => member(name)),
    lastActivitySequence: 1,
    lastActivityAt: '2026-10-28T06:00:00.000Z',
    accountableOwner: member('lead'),
    relation: 'project-owner',
    needsAcceptance: false,
  }
}

describe('Task card foot', () => {
  it('reads the accountable as one seated person and the executors as avatars, and an open card with nobody on it as awaiting a claim', () => {
    const { container } = render(<BoardCardFoot item={item('in_progress', [])} human={undefined} humanMemberId={humanMemberId} t={t} />)
    // The face and one role word; the name stays in the seat's own label.
    expect(container.querySelector('[data-team-owner]')?.textContent).toBe('L负责')
    expect(container.querySelector('[data-team-owner]')?.getAttribute('aria-label')).toBe('负责人 @lead')
    // No claimer yet: say so as a claim state, never as "the owner is unassigned".
    expect(container.textContent).toContain('待认领')
    expect(container.textContent).not.toContain('未指派')
    cleanup()

    const { container: withExecutors } = render(<BoardCardFoot item={item('in_progress', ['ana', 'bo'])} human={undefined} humanMemberId={humanMemberId} t={t} />)
    expect(withExecutors.querySelector('[data-team-owner]')?.getAttribute('aria-label')).toBe('负责人 @lead')
    // The executor group carries its role word so the faces are not read as more owners.
    expect(withExecutors.textContent).toContain('认领')
    expect(withExecutors.querySelector('[class*="boardCardExecutor"] [role="img"]')?.getAttribute('aria-label')).toBe('由 @ana, @bo 认领')
    expect(withExecutors.textContent).not.toContain('待认领')
  })

  it('draws one face per person, so an accountable who also claims stands at the seat and not again in the group', () => {
    const { container } = render(<BoardCardFoot item={item('in_progress', ['lead', 'ana'])} human={undefined} humanMemberId={humanMemberId} t={t} />)
    expect(container.querySelector('[data-team-owner]')?.textContent).toBe('L负责')
    // The group names the one hand the seat does not already stand for.
    expect(container.querySelector('[class*="boardCardExecutor"] [role="img"]')?.getAttribute('aria-label')).toBe('由 @ana 认领')
    cleanup()

    // A Task only its owner claimed is drawn by the seat alone: the column already says work has started, and a second
    // copy of the same face is what read as two roles disagreeing about one person.
    const { container: alone } = render(<BoardCardFoot item={item('in_progress', ['lead'])} human={undefined} humanMemberId={humanMemberId} t={t} />)
    expect(alone.querySelector('[data-team-owner]')?.textContent).toBe('L负责')
    expect(alone.textContent).not.toContain('认领')
    expect(alone.textContent).not.toContain('待认领')
    expect(alone.querySelector('[class*="boardCardExecutor"]')).toBeNull()
  })

  it('drops the executor slot once the Task is resolved instead of saying nobody is on it', () => {
    for (const status of ['done', 'closed'] as const) {
      const { container } = render(<BoardCardFoot item={item(status, [])} human={undefined} humanMemberId={humanMemberId} t={t} />)
      expect(container.querySelector('[data-team-owner]')?.getAttribute('aria-label')).toBe('负责人 @lead')
      expect(container.textContent).not.toContain('待认领')
      expect(container.textContent).not.toContain('未指派')
      expect(container.textContent).not.toContain('认领')
      cleanup()
    }
  })

  it('names the reader as the accountable rather than repeating their handle', () => {
    const own = { ...item('in_progress', ['ana']), task: { ...item('in_progress', ['ana']).task, accountable: humanMemberId },
      accountableOwner: member('human') }
    const { container } = render(<BoardCardFoot item={own} human={undefined} humanMemberId={humanMemberId} t={t} />)
    expect(container.textContent).toContain('你负责')
  })
})
