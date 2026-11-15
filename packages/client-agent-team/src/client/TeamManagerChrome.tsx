import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamNavigation } from './navigation.ts'
import { TeamManagerSessionAction } from './TeamManagerSessionAction.tsx'
import type { AgentTeamNewManagerSessionRequest } from '@contexera/dsh-agent-team/types'

/** Temporary replacements for the fixed manager composition, not authorization controls. */
export function registerManagerChrome(
  ctx: ClientContext,
  navigation: TeamNavigation,
  newManagerSession: (expectedSessionId: AgentTeamNewManagerSessionRequest['expectedSessionId']) => Promise<void>,
): () => void {
  const sessions = ctx.sessions as unknown as ISessions
  const classified = new Set<SessionId>()
  let disposers: readonly (() => void)[] = []
  let active = true
  let requested: SessionId | undefined

  const reconcile = (): void => {
    const current = Object.values(sessions.list.getSnapshot().byId)
      .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
    const snapshot = navigation.getSnapshot()
    const manager = current !== undefined && (classified.has(current)
      || (snapshot.manager === true && snapshot.managerSessionId === current))
    if (manager && disposers.length === 0) {
      const replace = (name: 'conversation.hero.agentPreset' | 'conversation.input.permission'): (() => void) =>
        ctx.slots.inject(name, () => ctx.slots.register({ name, priority: -200 }, (() => null) as never))
      // The lowest-priority entry wins each cell. Waiting for the declaration
      // also covers optional preset plugins that mount after this controller.
      const action = ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions', id: 'agent-preset', priority: -200, order: -10,
        locale: 'team',
        inject: () => ({ navigation, newManagerSession }),
      }, TeamManagerSessionAction as never))
      disposers = [replace('conversation.hero.agentPreset'), replace('conversation.input.permission'), action]
    } else if (!manager) {
      for (const dispose of disposers) dispose()
      disposers = []
    }
    if (current === undefined || current === requested || classified.has(current)) return
    requested = current
    void ctx.remote.agentTeam.sessionOwnership({ sessionIds: [current] }).then(response => {
      if (!active || !response.ok) return
      if (response.value.some(entry => entry.sessionId === current && entry.kind === 'manager')) {
        classified.add(current)
        reconcile()
      }
    }, () => {
      // Presentation failure is non-authoritative; Host policy remains intact.
    })
  }
  const unsubscribeSessions = sessions.list.subscribe(reconcile)
  const unsubscribeNavigation = navigation.subscribe(reconcile)
  reconcile()
  return () => {
    active = false
    unsubscribeSessions()
    unsubscribeNavigation()
    for (const dispose of disposers) dispose()
  }
}
