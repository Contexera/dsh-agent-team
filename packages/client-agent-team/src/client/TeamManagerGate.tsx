import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentTeamClientMemberStatus, AgentTeamManagerSessionRequest, AgentTeamManagerSessionResult } from '@contexera/dsh-agent-team/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TeamNavigationSource } from './slots.ts'
import css from './conversation.module.css'

export interface TeamManagerGateProps extends PropsLocale<'team'> {
  readonly navigation: TeamNavigationSource
  readonly loadManagerSession: (request: AgentTeamManagerSessionRequest) => Promise<RemoteResult<AgentTeamManagerSessionResult>>
  readonly openResolvedManagerSession: (sessionId: AgentTeamClientMemberStatus['member']['sessionId'], workspaceId: WorkspaceId) => Promise<AgentTeamClientMemberStatus['member']['sessionId'] | undefined>
  readonly resolveManagerSession: (sessionId: AgentTeamClientMemberStatus['member']['sessionId'], returnToSessionId?: AgentTeamClientMemberStatus['member']['sessionId']) => void
  readonly showManagerWorkspaceEmpty: () => void
}

/** Resolves the Host-owned manager id before yielding the main seat to the shipped Conversation. */
export function TeamManagerGate({ navigation, loadManagerSession, openResolvedManagerSession, resolveManagerSession, showManagerWorkspaceEmpty, t }: TeamManagerGateProps) {
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string>()

  useEffect(() => {
    let active = true
    setLoading(true)
    setFailure(undefined)
    void (async () => {
      try {
        const response = await loadManagerSession({})
        if (!active || navigation.getSnapshot().manager !== true) return
        if (!response.ok) {
          setFailure(response.error.message)
          return
        }
        const result = response.value
        if (result.status === 'no-workspace') {
          showManagerWorkspaceEmpty()
          return
        }
        if (result.status === 'unavailable') {
          setFailure(result.diagnostic.detail)
          return
        }
        const returnTo = await openResolvedManagerSession(result.sessionId, result.workspaceId)
        if (!active || navigation.getSnapshot().manager !== true) return
        resolveManagerSession(result.sessionId, returnTo)
        requestAnimationFrame(() => {
          if (active && navigation.getSnapshot().managerSessionId === result.sessionId) {
            document.querySelector<HTMLElement>('[data-composer-input][contenteditable="true"]')?.focus()
          }
        })
      } catch (error) {
        if (active && navigation.getSnapshot().manager === true) setFailure(error instanceof Error ? error.message : String(error))
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [attempt, loadManagerSession, navigation, openResolvedManagerSession, resolveManagerSession, showManagerWorkspaceEmpty])

  return <main className={css.welcomeSurface} data-team-manager-gate>
    <div className={css.welcome}>
      <h1>{t('teamManager')}</h1>
      {failure === undefined
        ? <p className={css.loadingState} role="status"><span className={css.loadingMark} aria-hidden="true" />{t('managerLoading')}</p>
        : <div className={css.errorState} role="alert"><span>{failure}</span><Button size="sm" variant="outline" disabled={loading} onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button></div>}
    </div>
  </main>
}
