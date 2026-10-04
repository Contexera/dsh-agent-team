import { describe, expect, it, vi } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamContextJudgeResult } from '@wowyuarm/dsh-agent-team/types'
import { TeamJudgeForm, TeamJudgeFormSeat, type TeamJudgeSection } from '../src/client/judge-form.ts'
import { TeamContextJudgeCheck, type TeamContextJudgeLoader } from '../src/client/context-judge.ts'

/**
 * The Team settings page edits one group of a shared settings section, and the
 * key is write-only. These tests lock the three things that are easy to get
 * wrong: the flat form model is addressed at the real nested paths, a blank key
 * draft writes nothing (so opening the page can never clear a stored key), and
 * a landed write re-reads the status the Host now serves.
 */

const JEV = { apiBase: 'https://api.typesafe.ai/v1', model: 'jev-1.13.0', apiKeyEnv: 'TYPESAFE_API_KEY' }

const SECTION: TeamJudgeSection = { jev: JEV }

const REPORT: AgentTeamContextJudgeResult = {
  enabled: false,
  reason: 'no-key',
  keyEnv: 'TYPESAFE_API_KEY',
  gate: { tokens: 24000, idleMs: 300000, judgeTimeoutMs: 5000 },
}

function bench() {
  const stub = stubConfigForm<TeamJudgeSection>()
  const loadContextJudge = vi.fn(async (): Promise<RemoteResult<AgentTeamContextJudgeResult>> => ({ ok: true, value: REPORT }))
  const judge = new TeamContextJudgeCheck({ loadContextJudge } as unknown as TeamContextJudgeLoader)
  const form = new TeamJudgeForm(stub.scope, judge)
  stub.publish({ status: 'ready', value: SECTION, base: SECTION, user: undefined, writable: true, revision: 7 })
  return { stub, form, judge, loadContextJudge }
}

describe('judge endpoint form', () => {
  it('reads the group into the controls it owns, and only those', () => {
    const { form } = bench()
    const state = form.getSnapshot()
    expect(state.shell.available).toBe(true)
    expect(state.fields.apiBase.text).toBe('https://api.typesafe.ai/v1')
    expect(state.fields.model.text).toBe('jev-1.13.0')
    // The `gate` thresholds and the key environment variable share the row and
    // are not this page's controls; the projection carries no field for them.
    expect(Object.keys(state.fields)).toEqual(['apiBase', 'model', 'apiKey'])
  })

  it('never seeds the key control: the literal does not ride a response', () => {
    const { stub, form } = bench()
    stub.publish({ user: { jev: { apiKey: 'stored-somewhere' } } })
    expect(form.getSnapshot().fields.apiKey.text).toBe('')
    expect(form.getSnapshot().fields.apiKey.overridden).toBe(false)
  })

  it('marks a field overridden from the user layer\'s presence, not its value', () => {
    const { stub, form } = bench()
    stub.publish({ user: { jev: { model: 'jev-1.13.0' } } })
    expect(form.getSnapshot().fields.model.overridden).toBe(true)
    expect(form.getSnapshot().fields.apiBase.overridden).toBe(false)
  })

  it('writes a staged edit at the path the control really lives at, fenced to the revision it started from', async () => {
    const { stub, form } = bench()
    form.actions().edit('apiBase', 'https://openrouter.ai/api/v1')
    form.actions().edit('model', 'typesafe/jev-1.13')
    await form.actions().save()
    expect(stub.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['jev', 'apiBase'], value: 'https://openrouter.ai/api/v1' },
      { op: 'set', path: ['jev', 'model'], value: 'typesafe/jev-1.13' },
    ], 7)
  })

  it('writes nothing for an untouched or emptied key draft', async () => {
    const { stub, form } = bench()
    form.actions().edit('apiKey', '   ')
    await form.actions().save()
    expect(stub.mutate).not.toHaveBeenCalled()
  })

  it('writes a typed key through the same form, and re-reads the status once it lands', async () => {
    const { stub, form, loadContextJudge } = bench()
    form.actions().edit('apiKey', 'sk-literal')
    await form.save()
    // The key write carries no fence of its own: it settles after the staged
    // ops, whose write has already moved the revision the form started from.
    expect(stub.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['jev', 'apiKey'], value: 'sk-literal' }])
    expect(loadContextJudge).toHaveBeenCalledTimes(1)
    expect(form.getSnapshot().shell.dirty).toBe(false)
  })

  it('clears the stored key with an explicit unset and re-reads the status', async () => {
    const { stub, form, loadContextJudge } = bench()
    await expect(form.clearKey()).resolves.toBe(true)
    expect(stub.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['jev', 'apiKey'] }])
    expect(loadContextJudge).toHaveBeenCalledTimes(1)
  })

  it('reports a refused clear without re-reading', async () => {
    const { stub, form, loadContextJudge } = bench()
    stub.mutate.mockResolvedValueOnce(false)
    await expect(form.clearKey()).resolves.toBe(false)
    expect(loadContextJudge).not.toHaveBeenCalled()
  })

  it('keeps a refused save\'s drafts and does not re-read the status', async () => {
    const { stub, form, loadContextJudge } = bench()
    stub.mutate.mockResolvedValueOnce(false)
    form.actions().edit('model', 'typesafe/jev-1.13')
    await form.save()
    expect(form.getSnapshot().shell.failed).toBe(true)
    expect(form.getSnapshot().shell.dirty).toBe(true)
    expect(form.getSnapshot().fields.model.text).toBe('typesafe/jev-1.13')
    expect(loadContextJudge).not.toHaveBeenCalled()
  })

  it('stages a reset back to the composition layer as an unset of the real path', async () => {
    const { stub, form } = bench()
    stub.publish({ user: { jev: { model: 'typesafe/jev-1.13' } }, value: { jev: { ...JEV, model: 'typesafe/jev-1.13' } } })
    form.actions().resetField('model')
    await form.actions().save()
    expect(stub.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['jev', 'model'] }], 7)
  })

  it('renders nothing while the namespace is not served', () => {
    const { stub, form } = bench()
    stub.publish({ status: 'unavailable', value: undefined, writable: false })
    expect(form.getSnapshot().shell.available).toBe(false)
  })
})

/**
 * The seat the settings page binds: the form is held rather than handed over,
 * because a slot entry's injected props are computed once and the settings
 * service may answer after that moment.
 */
describe('judge form seat', () => {
  it('publishes a held form and withdraws it again', () => {
    const { form } = bench()
    const seat = new TeamJudgeFormSeat()
    const listener = vi.fn()
    const stop = seat.subscribe(listener)
    expect(seat.getSnapshot()).toBeUndefined()

    seat.hold(form)
    expect(seat.getSnapshot()).toBe(form)
    expect(listener).toHaveBeenCalledTimes(1)

    seat.release(form)
    expect(seat.getSnapshot()).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(2)

    // A disposed subscriber is not called again, and the seat keeps its value.
    stop()
    seat.hold(form)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(seat.getSnapshot()).toBe(form)
  })

  it('ignores a release from a holder the seat no longer carries', () => {
    const first = bench().form
    const second = bench().form
    const seat = new TeamJudgeFormSeat()
    seat.hold(first)
    seat.hold(second)
    // The service that built the first form going away must not clear the
    // replacement it was swapped for.
    seat.release(first)
    expect(seat.getSnapshot()).toBe(second)
  })
})
