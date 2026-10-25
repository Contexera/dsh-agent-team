import { useCallback, useEffect, useState } from 'react'
import type { AgentTeamMemberId, AgentTeamTaskBoardItem } from '@contexera/dsh-agent-team/types'
import type { TeamConversationProps } from './slots.ts'
import { formatAbsoluteTime, formatInboxTime, taskStatusDot } from './team-formatters.ts'
import { TeamStateDot } from './TeamStateDot.tsx'
import projectCss from './project.module.css'
import css from './conversation.module.css'

const columns = [
  { key: 'todo', label: 'taskStatusTodo' },
  { key: 'in_progress', label: 'taskStatusInProgress' },
  { key: 'in_review', label: 'taskStatusInReview' },
] as const

export function TeamTaskBoardPage({ useWorkspaces, loadTaskBoard, subscribeChanges, selectWorkspace, selectThread, t }: Pick<TeamConversationProps, 'useWorkspaces' | 'loadTaskBoard' | 'subscribeChanges' | 'selectWorkspace' | 'selectThread' | 't'>) {
  const workspaces = useWorkspaces(state => state.items)
  const [items, setItems] = useState<readonly AgentTeamTaskBoardItem[]>()
  // The reader the boards are relative to, so a card can say 「你负责」 the way the Project board does.
  const [humanMemberId, setHumanMemberId] = useState<AgentTeamMemberId>()
  const [error, setError] = useState<string>()
  const refresh = useCallback(async () => {
    const results = await Promise.all(workspaces.map(async workspace => loadTaskBoard({ workspaceId: workspace.workspaceId })))
    const failed = results.find(result => !result.ok)
    setError(failed?.ok === false ? failed.error.message : undefined)
    if (failed === undefined) {
      setItems(results.flatMap(result => result.ok ? result.value.open : []).sort((a, b) => b.lastActivitySequence - a.lastActivitySequence))
      const first = results.find(result => result.ok)
      setHumanMemberId(first !== undefined && first.ok ? first.value.humanMemberId : undefined)
    }
  }, [loadTaskBoard, workspaces])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => subscribeChanges(undefined, update => { if (update.type === 'changed') void refresh() }), [refresh, subscribeChanges])
  return <main className={css.surface} data-team-task-board>
    <div className={css.surfaceHeader}><header className={css.headerRow}><div className={css.headerCopy}><h1>{t('taskBoard')}</h1><p>{t('taskBoardHint')}</p></div></header></div>
    <section className={projectCss.board}>
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      {items === undefined && error === undefined && <div className={css.emptySurface}><p className={css.loadingState}>{t('boardLoading')}</p></div>}
      {items !== undefined && items.length === 0 && <div className={css.emptySurface}><p className={css.emptyState}>{t('taskBoardEmpty')}</p></div>}
      {items !== undefined && items.length > 0 && <div className={projectCss.boardColumns}>{columns.map(column => {
        const columnItems = items.filter(item => item.task.status === column.key)
        return <div className={projectCss.boardColumn} key={column.key}><div className={projectCss.boardColumnHead}>{t(column.label)}<span className={projectCss.boardColumnCount}>{columnItems.length}</span></div>{columnItems.map(item => <button key={item.task.taskRef} type="button" className={projectCss.boardCard} onClick={() => { selectWorkspace(item.workspaceId); selectThread(item.threadRef, item.projectRef, item.task.taskRef, item.taskNumber) }}><span className={projectCss.boardCardNum}><TeamStateDot size={8} state={taskStatusDot(item.task.status)} />{t('taskLabel', { number: item.taskNumber })}{item.needsAcceptance && <span className={projectCss.boardAcceptBadge}>{t('boardNeedsAcceptance')}</span>}</span><span className={projectCss.boardCardTitle}>{item.projectName}: {item.subject}</span><span className={projectCss.boardCardFoot}><span className={projectCss.boardCardOwner}>{item.accountableOwner?.state === 'suspended' ? t('boardAccountableSuspended') : item.task.accountable === humanMemberId ? t('boardAccountableYou') : t('boardAccountable', { name: item.accountableOwner?.name ?? item.task.accountable })}</span><span>{item.relation === 'executor' ? t('boardMine') : item.liveClaimOwners.length > 0 ? t('boardAssigned') : t('boardUnassigned')}</span><time dateTime={item.lastActivityAt} title={formatAbsoluteTime(item.lastActivityAt)}>{formatInboxTime(item.lastActivityAt, t)}</time></span></button>)}</div>
      })}</div>}
    </section>
  </main>
}
