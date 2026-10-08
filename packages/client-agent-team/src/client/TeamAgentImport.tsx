import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AgentTeamClientMemberStatus, AgentTeamJoinWorkspaceRequest } from '@contexera/dsh-agent-team/types'
import type { TeamSidebarProps } from './slots.ts'
import { TeamMemberRow } from './TeamMemberRow.tsx'
import { mintRequestId } from './requests.ts'
import css from './create.module.css'

/** Selection is a Host join, not a new Agent or a copied Session. */
export function TeamAgentImport({ workspaceId, loadMembers, joinWorkspace, onJoined, onPending, t }: {
  readonly workspaceId: WorkspaceId
  readonly loadMembers: TeamSidebarProps['loadMembers']
  readonly joinWorkspace: TeamSidebarProps['joinWorkspace']
  readonly onJoined: () => Promise<void>
  readonly onPending: (pending: boolean) => void
  readonly t: TeamSidebarProps['t']
}) {
  const [members, setMembers] = useState<readonly AgentTeamClientMemberStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<string>()
  const retry = useRef<AgentTeamJoinWorkspaceRequest>()
  const busy = useRef(false)
  const generation = useRef(0)
  const load = useCallback(async () => {
    const current = ++generation.current
    setLoading(true)
    setError(undefined)
    try {
      const result = await loadMembers({})
      if (current !== generation.current) return
      if (!result.ok) throw new Error(result.error.message)
      setMembers(result.value.filter(status => (status.member.state === 'enabled' || status.member.state === 'suspended') && !status.workspaceIds.includes(workspaceId)))
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [loadMembers, workspaceId])
  useEffect(() => { void load(); return () => { generation.current++ } }, [load])
  const join = async (status: AgentTeamClientMemberStatus) => {
    if (busy.current) return
    busy.current = true
    setPending(status.member.memberId)
    onPending(true)
    setError(undefined)
    const request = retry.current?.memberId === status.member.memberId ? retry.current : {
      requestId: mintRequestId(), workspaceId, memberId: status.member.memberId,
    }
    retry.current = request
    try {
      const result = await joinWorkspace(request)
      if (!result.ok) throw new Error(result.error.message)
      await onJoined()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      busy.current = false
      setPending(undefined)
      onPending(false)
    }
  }
  return <div className={css.form}>
    <p className={css.notice}>{t('importAgentNotice')}</p>
    {loading && <p className={css.state} role="status">{t('loadingAgents')}</p>}
    {!loading && error === undefined && members.length === 0 && <p className={css.state}>{t('emptyImportAgents')}</p>}
    {!loading && members.length > 0 && <div className={css.roster}>
      {members.map(status => <TeamMemberRow key={status.member.memberId} status={status} t={t} action={{
        label: pending === status.member.memberId ? t('importingAgent') : t('importAgent'),
        disabled: pending !== undefined,
        onSelect: () => { void join(status) },
      }} />)}
    </div>}
    {error !== undefined && <div className={css.failure} role="alert"><p className={css.error}>{error}</p><Button disabled={pending !== undefined} variant="outline" onClick={() => { void load() }}>{t('retry')}</Button></div>}
  </div>
}
