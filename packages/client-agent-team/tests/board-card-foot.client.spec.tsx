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
  it('reads the accountable as text and the executors as avatars, and an open card with nobody on it as awaiting a claim', () => {
    const { container } = render(<BoardCardFoot item={item('in_progress', [])} human={undefined} humanMemberId={humanMemberId} t={t} />)
    expect(container.textContent).toContain('负责人 lead')
    // No claimer yet: say so as a claim state, never as "the owner is unassigned".
    expect(container.textContent).toContain('待认领')
    expect(container.textContent).not.toContain('未指派')
    cleanup()

    const { container: withExecutors } = render(<BoardCardFoot item={item('in_progress', ['ana', 'bo'])} human={undefined} humanMemberId={humanMemberId} t={t} />)
    expect(withExecutors.textContent).toContain('负责人 lead')
    // The executor group carries its role word so the faces are not read as more owners.
    expect(withExecutors.textContent).toContain('执行者')
    expect(withExecutors.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('由 @ana, @bo 处理')
    expect(withExecutors.textContent).not.toContain('待认领')
  })

  it('drops the executor slot once the Task is resolved instead of saying nobody is on it', () => {
    for (const status of ['done', 'closed'] as const) {
      const { container } = render(<BoardCardFoot item={item(status, [])} human={undefined} humanMemberId={humanMemberId} t={t} />)
      expect(container.textContent).toContain('负责人 lead')
      expect(container.textContent).not.toContain('待认领')
      expect(container.textContent).not.toContain('未指派')
      expect(container.textContent).not.toContain('执行者')
      cleanup()
    }
  })

  it('names the reader as the accountable rather than repeating their handle', () => {
    const own = { ...item('in_progress', ['ana']), task: { ...item('in_progress', ['ana']).task, accountable: humanMemberId } }
    const { container } = render(<BoardCardFoot item={own} human={undefined} humanMemberId={humanMemberId} t={t} />)
    expect(container.textContent).toContain('你负责')
  })
})
