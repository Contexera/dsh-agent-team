import { describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/index.ts'

function registration(config?: Config) {
  const register = vi.fn<(tool: { name: string }) => void>()
  return { register, mount: () => apply({ tools: { register } } as never, config) }
}

describe('Team tool registration', () => {
  it('declares every tool once in the existing order by default', () => {
    const { register, mount } = registration()
    mount()
    expect(register.mock.calls.map(([tool]) => tool.name)).toEqual([
      'team_inbox', 'team_reminder', 'team_thread', 'team_attention', 'team_message', 'team_dm',
      'team_task', 'team_view', 'team_overview', 'team_models', 'team_subscription', 'team_worker',
      'member_create', 'project_create', 'project_owner', 'project_update', 'member_update',
      'member_state', 'member_workspace',
    ])
  })

  it('declares only the selected tools, without duplicates or reordering', () => {
    const { register, mount } = registration({ only: ['team_worker', 'team_inbox', 'team_worker'] })
    mount()
    expect(register.mock.calls.map(([tool]) => tool.name)).toEqual(['team_inbox', 'team_worker'])
  })

  it('declares nothing when the selection is empty', () => {
    const { register, mount } = registration({ only: [] })
    mount()
    expect(register).not.toHaveBeenCalled()
  })

  it('rejects an unknown name before declaring any tools', () => {
    const { register, mount } = registration({ only: ['team_inbox', 'team_unknown'] })
    expect(mount).toThrow('team-tools config names an unknown Team tool: team_unknown')
    expect(register).not.toHaveBeenCalled()
  })
})
