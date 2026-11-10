// @vitest-environment jsdom
/**
 * The Human's stop surface inside the edit-Agent dialog: one row per live run,
 * a stop that shows its own progress, a failure that keeps the row and says why,
 * and an unconfirmed run that offers no control.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { MemberWorkerRunsSection } from '../src/client/TeamMemberEditor.tsx'
import { zh } from '../src/client/locales.ts'
import type { AgentTeamWorkerInspection, AgentTeamWorkerRunView, AgentTeamWorkerStopResult } from '@contexera/dsh-agent-team/types'

afterEach(cleanup)

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as Parameters<typeof MemberWorkerRunsSection>[0]['t']

const workspaceId = 'workspace:alpha' as Parameters<typeof MemberWorkerRunsSection>[0]['workspaceId']
const memberId = 'member:owner' as Parameters<typeof MemberWorkerRunsSection>[0]['memberId']

const running: AgentTeamWorkerRunView = { workerRef: 'worker:one' as AgentTeamWorkerRunView['workerRef'],
  projectRef: 'project:alpha' as AgentTeamWorkerRunView['projectRef'], engine: 'codex', state: 'running',
  task: 'check the schedule', startedAt: '2026-01-01T00:00:00.000Z' }
const unconfirmed: AgentTeamWorkerRunView = { ...running, workerRef: 'worker:old' as AgentTeamWorkerRunView['workerRef'],
  state: 'unconfirmed' }

const listed = (runs: readonly AgentTeamWorkerRunView[]): RemoteResult<{ readonly runs: readonly AgentTeamWorkerRunView[] }> =>
  ({ ok: true, value: { runs } }) as RemoteResult<{ readonly runs: readonly AgentTeamWorkerRunView[] }>

const refused = (message: string): RemoteResult<never> => ({ ok: false, error: { message } }) as RemoteResult<never>

/** One ended run, as the Host lists it after its process exited. */
const failed: AgentTeamWorkerRunView = { ...running, workerRef: 'worker:failed' as AgentTeamWorkerRunView['workerRef'],
  state: 'failed', task: 'check the nightly run' }

/** The Host's report for that run: the public summary, the anchors, and what the native record answered. */
const inspection = (history: AgentTeamWorkerInspection['history'] = { kind: 'read',
  fragments: [{ kind: 'turn', text: 'model: gpt-6.1-sol' }, { kind: 'failure', text: 'unexpected status 401' }],
  withheld: 0, truncated: false }): AgentTeamWorkerInspection => ({
  workerRef: failed.workerRef, projectRef: failed.projectRef, engine: 'codex', state: 'failed', unconfirmed: false,
  startedAt: failed.startedAt, settledAt: '2026-01-01T00:01:00.000Z', summary: 'The Worker ended in a failed turn.',
  stage: 'turn',
  native: { threadId: 'native-thread', turnId: 'native-turn', storage: '/tmp/sessions/rollout.jsonl' },
  history,
})

type StopResult = RemoteResult<AgentTeamWorkerStopResult>

function renderSection(options: {
  readonly runs: () => Promise<RemoteResult<{ readonly runs: readonly AgentTeamWorkerRunView[] }>>
  readonly stop?: () => Promise<StopResult>
  readonly inspect?: Parameters<typeof MemberWorkerRunsSection>[0]['inspectWorker']
}) {
  return render(
    <MemberWorkerRunsSection workspaceId={workspaceId} memberId={memberId}
      loadWorkerRuns={options.runs} stopWorker={options.stop ?? (async () => refused('unused') as never)}
      inspectWorker={options.inspect ?? (async () => refused('unused') as never)}
      disabled={false} t={t} />,
  )
}

describe('the running Worker list in the edit-Agent dialog', () => {
  it('names the block with a heading one rank above the field labels around it', async () => {
    renderSection({ runs: async () => listed([]) })
    expect(await screen.findByRole('heading', { level: 3, name: 'Worker 执行记录' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Worker 执行记录' })).toBeTruthy()
  })

  it('lists live runs and leaves an unconfirmed run without a stop control', async () => {
    renderSection({ runs: async () => listed([running, unconfirmed]) })
    const rows = await screen.findAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('check the schedule')
    expect(rows[0]!.textContent).toContain('运行中')
    // The previous Host's run explains itself and offers nothing to press.
    expect(rows[1]!.textContent).toContain('结果未确认')
    expect(rows[1]!.textContent).toContain('由之前的 Host 启动')
    expect(screen.getAllByRole('button', { name: /停止 Worker/ })).toHaveLength(1)
    // Neither row opens a diagnostic: a live run has no native record yet, and the
    // previous Host's run has none this Host can find.
    expect(screen.queryByRole('button', { name: /查看诊断/ })).toBeNull()
  })

  it('shows the stop in progress, then the ending the Host confirmed', async () => {
    let finish!: (result: StopResult) => void
    const stop = vi.fn(() => new Promise<StopResult>(resolve => { finish = resolve }))
    renderSection({ runs: async () => listed([running]), stop })
    fireEvent.click(await screen.findByRole('button', { name: '停止 Worker：check the schedule' }))
    expect(screen.getByRole('button', { name: '停止 Worker：check the schedule' }).textContent).toBe('停止中')
    finish({ ok: true, value: { kind: 'ended', workerRef: running.workerRef, state: 'stopped' } } as StopResult)
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toContain('已停止') })
    expect(screen.queryByRole('button', { name: /停止 Worker/ })).toBeNull()
    expect(stop).toHaveBeenCalledWith({ workspaceId, memberId, workerRef: running.workerRef })
  })

  it('reports a run that finished first as the state it really ended in', async () => {
    // The stop reached the Host after the run had already completed: the row
    // says so instead of claiming a stop that never happened.
    const stop = vi.fn(async () => ({ ok: true, value: { kind: 'ended', workerRef: running.workerRef, state: 'completed' } }) as StopResult)
    renderSection({ runs: async () => listed([running]), stop })
    fireEvent.click(await screen.findByRole('button', { name: '停止 Worker：check the schedule' }))
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toContain('已完成') })
    expect(screen.getByRole('listitem').textContent).not.toContain('已停止')
    expect(screen.queryByRole('button', { name: /停止 Worker/ })).toBeNull()
  })

  it('keeps the Host sentence of a run whose cleanup it could not confirm', async () => {
    const stop = vi.fn(async () => ({ ok: true, value: { kind: 'ended', workerRef: running.workerRef, state: 'failed',
      diagnostic: 'The engine may still be active; check it before starting another task.' } }) as StopResult)
    renderSection({ runs: async () => listed([running]), stop })
    fireEvent.click(await screen.findByRole('button', { name: '停止 Worker：check the schedule' }))
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toContain('已失败') })
    expect(screen.getByRole('alert').textContent).toBe('The engine may still be active; check it before starting another task.')
    expect(screen.getByRole('listitem').textContent).not.toContain('已停止')
    expect(screen.queryByRole('button', { name: /停止 Worker/ })).toBeNull()
  })

  it('keeps a cleanup still in flight as stopping, with the Host sentence and the control', async () => {
    // The Host's receipt says the stop was requested and the cleanup is still
    // running: that is not a failure, and the row must not call it one.
    const stop = vi.fn(async () => ({ ok: true, value: { kind: 'pending', workerRef: running.workerRef,
      message: 'Worker \'worker:one\' is still stopping; the engine has not confirmed its cleanup yet.' } }) as StopResult)
    renderSection({ runs: async () => listed([running]), stop })
    fireEvent.click(await screen.findByRole('button', { name: '停止 Worker：check the schedule' }))
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toContain('停止中') })
    expect(screen.getByRole('alert').textContent).toContain('has not confirmed its cleanup yet')
    expect(screen.getByRole('listitem').textContent).not.toContain('停止失败')
    expect(screen.getByRole('button', { name: '停止 Worker：check the schedule' })).toBeTruthy()
  })

  it('shows a run this Host no longer holds as unconfirmed, with its hint', async () => {
    const stop = vi.fn(async () => ({ ok: true, value: { kind: 'unconfirmed', workerRef: running.workerRef,
      message: 'Worker \'worker:one\' was started by a Host that no longer holds its handle.' } }) as StopResult)
    renderSection({ runs: async () => listed([running]), stop })
    fireEvent.click(await screen.findByRole('button', { name: '停止 Worker：check the schedule' }))
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toContain('结果未确认') })
    expect(screen.getByRole('listitem').textContent).toContain('由之前的 Host 启动')
    expect(screen.queryByRole('button', { name: /停止 Worker/ })).toBeNull()
  })

  it('keeps a confirmed stopping when a later request is refused', async () => {
    // The first stop was accepted and the cleanup is in flight; the second call
    // never completed. That failure carries no execution fact, so the row must
    // stay where the Host put it and only the explanation changes.
    const stop = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { kind: 'pending', workerRef: running.workerRef,
        message: 'Worker \'worker:one\' is still stopping; the engine has not confirmed its cleanup yet.' } } as StopResult)
      .mockResolvedValueOnce(refused('the Host is unreachable'))
    renderSection({ runs: async () => listed([running]), stop })
    fireEvent.click(await screen.findByRole('button', { name: '停止 Worker：check the schedule' }))
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toContain('停止中') })
    fireEvent.click(screen.getByRole('button', { name: '停止 Worker：check the schedule' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('the Host is unreachable') })
    // The state did not regress to the first read, and the control stays.
    expect(screen.getByRole('listitem').textContent).toContain('停止中')
    expect(screen.getByRole('listitem').textContent).not.toContain('运行中')
    expect(screen.getByRole('button', { name: '停止 Worker：check the schedule' })).toBeTruthy()
  })

  it('keeps a confirmed stopping when a later request rejects', async () => {
    const stop = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { kind: 'pending', workerRef: running.workerRef,
        message: 'Worker \'worker:one\' is still stopping; the engine has not confirmed its cleanup yet.' } } as StopResult)
      .mockRejectedValueOnce(new Error('the remote call was torn down'))
    renderSection({ runs: async () => listed([running]), stop })
    fireEvent.click(await screen.findByRole('button', { name: '停止 Worker：check the schedule' }))
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toContain('停止中') })
    fireEvent.click(screen.getByRole('button', { name: '停止 Worker：check the schedule' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('the remote call was torn down') })
    expect(screen.getByRole('listitem').textContent).toContain('停止中')
    expect(screen.getByRole('listitem').textContent).not.toContain('运行中')
  })

  it('says a refused call did not complete without deciding the run', async () => {
    // A transport or permission failure is not an ending: the row keeps the
    // state the Host still reports and carries the sentence as an explanation.
    const stop = vi.fn(async () => refused('the Host is unreachable'))
    renderSection({ runs: async () => listed([running]), stop })
    fireEvent.click(await screen.findByRole('button', { name: '停止 Worker：check the schedule' }))
    expect((await screen.findByRole('alert')).textContent).toBe('the Host is unreachable')
    expect(screen.getByRole('listitem').textContent).toContain('运行中')
    expect(screen.getByRole('listitem').textContent).not.toContain('停止失败')
    expect(screen.getByRole('button', { name: '停止 Worker：check the schedule' })).toBeTruthy()
  })
})

describe('the diagnostic behind one Worker run', () => {
  it('keeps a failed run on the list after its process exited, with its door and no stop control', async () => {
    renderSection({ runs: async () => listed([running, failed]) })
    const rows = await screen.findAllByRole('listitem')
    expect(rows[1]!.textContent).toContain('已失败')
    expect(rows[1]!.textContent).toContain('check the nightly run')
    // Only the live run can still be stopped; only the ended one has a record to
    // read, so the door belongs to that row alone.
    expect(screen.getAllByRole('button', { name: /停止 Worker/ })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /查看诊断/ })).toHaveLength(1)
    expect(screen.getByRole('button', { name: '查看诊断：check the nightly run' })).toBeTruthy()
    // The list is a window, and it says so.
    expect(screen.getByText(zh.memberWorkerRunsWindow)).toBeTruthy()
  })

  it('renders the Host report as it came: summary, stage, native identities and fragments', async () => {
    const inspect = vi.fn(async () => ({ ok: true, value: inspection() }) as RemoteResult<AgentTeamWorkerInspection>)
    renderSection({ runs: async () => listed([failed]), inspect })
    fireEvent.click(await screen.findByRole('button', { name: '查看诊断：check the nightly run' }))
    await screen.findByText('摘要: The Worker ended in a failed turn.')
    expect(screen.getByText('失败阶段：turn')).toBeTruthy()
    expect(screen.getByText('原生会话：native-thread')).toBeTruthy()
    expect(screen.getByText('原生 turn：native-turn')).toBeTruthy()
    expect(screen.getByText('原生记录：/tmp/sessions/rollout.jsonl')).toBeTruthy()
    expect(screen.getByText('turn: model: gpt-6.1-sol')).toBeTruthy()
    expect(screen.getByText('failure: unexpected status 401')).toBeTruthy()
    expect(screen.queryByText(zh.memberWorkerInspectWithheld)).toBeNull()
    expect(inspect).toHaveBeenCalledWith({ workspaceId, memberId, workerRef: failed.workerRef })
    // One flag drives the word, the name, and the expanded state: the control now
    // says what it does, and the visible word is a prefix of its accessible name.
    const opened = screen.getByRole('button', { name: '收起诊断：check the nightly run' })
    expect(opened.textContent).toBe('收起诊断')
    expect(opened.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(opened)
    await waitFor(() => { expect(screen.queryByText('摘要: The Worker ended in a failed turn.')).toBeNull() })
    const closed = screen.getByRole('button', { name: '查看诊断：check the nightly run' })
    expect(closed.textContent).toBe('查看诊断')
    expect(closed.getAttribute('aria-expanded')).toBe('false')
  })

  it('says what the read could not do instead of inventing fragments', async () => {
    const inspect = vi.fn(async () => ({ ok: true, value: inspection({ kind: 'unmatched',
      reason: 'The record holds no turn with the recorded id.' }) }) as RemoteResult<AgentTeamWorkerInspection>)
    renderSection({ runs: async () => listed([failed]), inspect })
    fireEvent.click(await screen.findByRole('button', { name: '查看诊断：check the nightly run' }))
    await screen.findByText('The record holds no turn with the recorded id.')
    // The Team summary stays: a record that cannot answer does not erase the ending.
    expect(screen.getByText('摘要: The Worker ended in a failed turn.')).toBeTruthy()
    expect(screen.queryByText(zh.memberWorkerInspectFragments)).toBeNull()
  })

  it('shows the read in flight as a status, then a refused one as an alert', async () => {
    let answer!: (result: RemoteResult<AgentTeamWorkerInspection>) => void
    const inspect = vi.fn(() => new Promise<RemoteResult<AgentTeamWorkerInspection>>(resolve => { answer = resolve }))
    renderSection({ runs: async () => listed([failed]), inspect })
    fireEvent.click(await screen.findByRole('button', { name: '查看诊断：check the nightly run' }))
    expect((await screen.findByRole('status')).textContent).toBe(zh.memberWorkerInspectLoading)
    answer(refused('Worker \'worker:failed\' was delegated by another Member.'))
    await waitFor(() => { expect(screen.getByRole('alert').textContent)
      .toBe('诊断读取失败：Worker \'worker:failed\' was delegated by another Member.') })
    // A refused read leaves the row as the Host listed it, and the control folds
    // away a report that never arrived instead of sending the read again.
    expect(screen.getByRole('listitem').textContent).toContain('已失败')
    fireEvent.click(screen.getByRole('button', { name: '收起诊断：check the nightly run' }))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it('folds a read that is still in flight instead of asking twice', async () => {
    let answer!: (result: RemoteResult<AgentTeamWorkerInspection>) => void
    const inspect = vi.fn(() => new Promise<RemoteResult<AgentTeamWorkerInspection>>(resolve => { answer = resolve }))
    renderSection({ runs: async () => listed([failed]), inspect })
    fireEvent.click(await screen.findByRole('button', { name: '查看诊断：check the nightly run' }))
    expect((await screen.findByRole('status')).textContent).toBe(zh.memberWorkerInspectLoading)
    fireEvent.click(screen.getByRole('button', { name: '收起诊断：check the nightly run' }))
    await waitFor(() => { expect(screen.queryByRole('status')).toBeNull() })
    expect(inspect).toHaveBeenCalledTimes(1)
    // The late answer to the folded read does not reopen the report.
    answer({ ok: true, value: inspection() } as RemoteResult<AgentTeamWorkerInspection>)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.queryByText('摘要: The Worker ended in a failed turn.')).toBeNull()
    expect(screen.getByRole('button', { name: '查看诊断：check the nightly run' })).toBeTruthy()
  })

  it('keeps the report the Human moved to when an earlier read answers late', async () => {
    const other: AgentTeamWorkerRunView = { ...failed, workerRef: 'worker:other' as AgentTeamWorkerRunView['workerRef'],
      task: 'check the other run' }
    const answers = new Map<string, (result: RemoteResult<AgentTeamWorkerInspection>) => void>()
    const inspect = vi.fn((request: { readonly workerRef: string }) =>
      new Promise<RemoteResult<AgentTeamWorkerInspection>>(resolve => { answers.set(request.workerRef, resolve) }))
    renderSection({ runs: async () => listed([failed, other]), inspect })
    fireEvent.click(await screen.findByRole('button', { name: '查看诊断：check the nightly run' }))
    fireEvent.click(screen.getByRole('button', { name: '查看诊断：check the other run' }))
    // The first read answers after the second one was asked for: it is not the
    // answer the Human is looking at, so it may not take the surface over.
    answers.get(failed.workerRef)?.({ ok: true, value: { ...inspection(), workerRef: failed.workerRef } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.querySelector(`[data-worker-report="${failed.workerRef}"]`)).toBeNull()
    answers.get(other.workerRef)?.({ ok: true, value: { ...inspection(), workerRef: other.workerRef } })
    await waitFor(() => { expect(document.querySelector(`[data-worker-report="${other.workerRef}"]`)).not.toBeNull() })
    expect(document.querySelector(`[data-worker-report="${failed.workerRef}"]`)).toBeNull()
  })

  it('keeps one run to two lines: the task on one, its facts on the next', async () => {
    renderSection({ runs: async () => listed([running]) })
    const task = await waitFor(() => {
      const found = document.querySelector('[data-worker-task]')
      if (found === null) throw new Error('the task line has no seat yet')
      return found
    })
    // The Host's bounded preview stays reachable from the line that shows its opening words.
    expect(task.getAttribute('title')).toBe('check the schedule')
    expect(task.textContent).toBe('Codex · check the schedule')
    // State, where it was bound, and when it started share one line instead of stacking two.
    expect(task.parentElement!.querySelector('p')!.textContent).toMatch(/^运行中 · 仅 Project · 开始于 /)
  })

  it('offers no by-number door: the listed rows are the only way in', async () => {
    renderSection({ runs: async () => listed([failed]) })
    await screen.findByRole('listitem')
    // The number is never shown on this surface, so a field asking for one has no source.
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.querySelector('[data-team-member-workers] form')).toBeNull()
    expect(document.querySelector('[data-worker-lookup]')).toBeNull()
  })
})
