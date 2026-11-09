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
import type { AgentTeamWorkerRunView, AgentTeamWorkerStopResult } from '@contexera/dsh-agent-team/types'

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

type StopResult = RemoteResult<AgentTeamWorkerStopResult>

function renderSection(options: {
  readonly runs: () => Promise<RemoteResult<{ readonly runs: readonly AgentTeamWorkerRunView[] }>>
  readonly stop?: () => Promise<StopResult>
}) {
  return render(
    <MemberWorkerRunsSection workspaceId={workspaceId} memberId={memberId}
      loadWorkerRuns={options.runs} stopWorker={options.stop ?? (async () => refused('unused') as never)}
      disabled={false} t={t} />,
  )
}

describe('the running Worker list in the edit-Agent dialog', () => {
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
