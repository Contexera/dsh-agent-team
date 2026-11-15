import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility, type Domain, type DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import AgentTeam from '../src/index.ts'
import { managerSessionDomainSpec } from '../src/manager-session-store.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import { subscriptionDomainSpec } from '../src/subscription-store.ts'
import { MemoryStorageBackend } from './helpers/memory-backend.ts'
import { provideQuietTokenMeter } from './helpers/team-host-fixture.ts'

const alpha = WorkspaceId('workspace:alpha')

interface ManagerFailureOptions {
  readonly openFailure?: Error
  readonly closeFailure?: Error
}

class ManagerFailureFacility extends DomainFacility {
  readonly closed: string[] = []

  constructor(ctx: Context, private readonly failure: ManagerFailureOptions) {
    super(ctx, { backend: 'memory', routes: {} })
  }

  override async open<S extends DomainSpec>(spec: S): Promise<Domain<S>> {
    if (spec.name === managerSessionDomainSpec.name && this.failure.openFailure !== undefined) {
      throw this.failure.openFailure
    }
    const domain = await super.open(spec)
    if (this.failure.closeFailure === undefined) return domain
    return {
      name: domain.name,
      get global() { return domain.global },
      table: <N extends keyof S['tables'] & string>(name: N) => domain.table(name),
      close: async () => {
        await domain.close()
        this.closed.push(domain.name)
        if (domain.name === managerSessionDomainSpec.name) throw this.failure.closeFailure
      },
    }
  }
}

async function boot(failure: ManagerFailureOptions) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new ManagerFailureFacility(ctx, failure)
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === alpha ? { id, path: process.cwd(), attachSession: async () => {} } : undefined,
    list: () => [{ id: alpha, path: process.cwd() }],
    archiveSession: async () => {},
  })
  ctx.provide('agents', {
    create: async () => { throw new Error('unused') },
    resume: async () => { throw new Error('unused') },
  })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessionPersistence', { list: async () => [] })
  provideQuietTokenMeter(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam)
  return { ctx, fiber, facility }
}

function thrownBy(action: () => void): unknown {
  try {
    action()
    return undefined
  } catch (error) {
    return error
  }
}

describe('manager storage failures during Host lifecycle', () => {
  it('keeps boot alive but refuses ownership when the manager pointer store could not open', async () => {
    const storeFailure = new Error('manager pointer medium is damaged')
    const { ctx, fiber, facility } = await boot({ openFailure: storeFailure })
    try {
      expect(facility.get(managerSessionDomainSpec.name)).toBeUndefined()
      const observed = thrownBy(() => ctx.agentTeam.sessionOwnership({
        sessionIds: [SessionId('session:probe')],
      }))
      expect(observed).toBe(storeFailure)
    } finally {
      await fiber.dispose()
      await facility.closeAll()
    }
  })

  it('continues closing the Team ledger and subscriptions after the manager domain fails to close', async () => {
    const closeFailure = new Error('manager pointer close failed')
    const { ctx, fiber, facility } = await boot({ closeFailure })
    const warn = vi.spyOn(ctx.logger, 'warn')
    try {
      await fiber.dispose()
      expect(facility.closed).toEqual([
        managerSessionDomainSpec.name,
        agentTeamDomainSpec.name,
        subscriptionDomainSpec.name,
      ])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('manager pointer domain close failed'))
    } finally {
      await facility.closeAll()
    }
  })
})
