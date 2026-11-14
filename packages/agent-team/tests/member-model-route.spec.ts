import { describe, expect, it } from 'vitest'
// Slow CI machines (windows lane) can stretch multi-generation rollover
// chains past the default per-test budget. Every test here boots a real
// Host harness and waits on asynchronous session transitions, so both this
// per-test budget and the waitFor deadline below (kept equal) need headroom.
import { realHarness, ScriptedAdapter, requestId } from './helpers/member-harness.ts'

describe('Agent Team model route rejection (issue #43 #6)', () => {
  it('rejects an unregistered provider at creation instead of deferring to the first turn', async () => {
    const { ctx, workspaceId } = await realHarness(new ScriptedAdapter())
    await expect(ctx.agentTeam.addMember({
      requestId: requestId('bad-provider-add'), workspaceId, handle: 'builder',
      description: 'Builds the implementation', presetId: 'team-member', projectRefs: [],
      model: { provider: 'no-such-provider', model: 'whatever' },
    })).rejects.toThrow(/provider 'no-such-provider' is not registered/)
  })

  it('rejects an unregistered provider on update too', async () => {
    const h = await realHarness(new ScriptedAdapter())
    const builder = await h.human.addMember('builder', {
      description: 'Builds the implementation',
      model: { provider: 'mock', model: 'fine' },
    })
    await expect(h.ctx.agentTeam.updateMember({
      requestId: requestId('bad-provider-edit'), memberId: builder.memberId,
      handle: 'builder', description: 'Builds the implementation',
      model: { provider: 'no-such-provider', model: 'whatever' },
    })).rejects.toThrow(/provider 'no-such-provider' is not registered/)
  })

  it('accepts a registered provider and refuses a Member created without a route', async () => {
    const { ctx, workspaceId } = await realHarness(new ScriptedAdapter())
    const pinned = await ctx.agentTeam.addMember({
      requestId: requestId('good-provider-add'), workspaceId, handle: 'builder',
      description: 'Builds the implementation', presetId: 'team-member', projectRefs: [],
      model: { provider: 'mock', model: 'fine' },
    })
    expect(pinned.status.availability).toBe('active')
    // No route at all is refused: such a Member would wake on whatever the Host default is at that moment.
    await expect(ctx.agentTeam.addMember({
      requestId: requestId('no-model-add'), workspaceId, handle: 'painter',
      description: 'Paints the UI', presetId: 'team-member', projectRefs: [],
    })).rejects.toThrow(/requires an explicit model selection/)
  })
})
