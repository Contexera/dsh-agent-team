import { describe, expect, it, vi } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamContextJudgeResult } from '@wowyuarm/dsh-agent-team/types'
import { TeamContextGateForm, type TeamGateSection } from '../src/client/context-gate-form.ts'
import { TeamContextJudgeCheck, type TeamContextJudgeLoader } from '../src/client/context-judge.ts'

/**
 * The gate page edits two groups of one shared settings section, and the key is
 * write-only. These tests lock the three things that are easy to get wrong: the
 * flat form model is addressed at the real nested paths, a blank key draft
 * writes nothing (so opening the page can never clear a stored key), and a
 * landed write re-reads the status the Host now serves.
 */

const SECTION: TeamGateSection = {
  jev: { apiBase: 'https://api.typesafe.ai/v1', model: 'jev-1.13.0', apiKeyEnv: 'TYPESAFE_API_KEY' },
  gate: { tokens: 24000, idleMs: 300000, judgeTimeoutMs: 5000 },
}

const REPORT: AgentTeamContextJudgeResult = {
  enabled: false,
  reason: 'no-key',
  keyEnv: 'TYPESAFE_API_KEY',
  gate: { tokens: 24000, idleMs: 300000, judgeTimeoutMs: 5000 },
}

function bench() {
  const stub = stubConfigForm<TeamGateSection>()
  const loadContextJudge = vi.fn(async (): Promise<RemoteResult<AgentTeamContextJudgeResult>> => ({ ok: true, value: REPORT }))
  const judge = new TeamContextJudgeCheck({ loadContextJudge } as unknown as TeamContextJudgeLoader)
  const form = new TeamContextGateForm(stub.scope, judge)
  stub.publish({ status: 'ready', value: SECTION, base: SECTION, user: undefined, writable: true, revision: 7 })
  return { stub, form, judge, loadContextJudge }
}

describe('context gate form', () => {
  it('reads both groups into the controls it owns', () => {
    const { form } = bench()
    const state = form.getSnapshot()
    expect(state.shell.available).toBe(true)
    expect(state.fields.apiBase.text).toBe('https://api.typesafe.ai/v1')
    expect(state.fields.model.text).toBe('jev-1.13.0')
    expect(state.fields.apiKeyEnv.text).toBe('TYPESAFE_API_KEY')
    expect(state.fields.tokens.text).toBe('24000')
    expect(state.fields.idleMs.text).toBe('300000')
    expect(state.fields.judgeTimeoutMs.text).toBe('5000')
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
    form.actions().edit('judgeTimeoutMs', '10000')
    await form.actions().save()
    expect(stub.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['jev', 'apiBase'], value: 'https://openrouter.ai/api/v1' },
      { op: 'set', path: ['gate', 'judgeTimeoutMs'], value: 10000 },
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
    stub.publish({ user: { gate: { tokens: 1000 } }, value: { ...SECTION, gate: { tokens: 1000, idleMs: 300000, judgeTimeoutMs: 5000 } } })
    form.actions().resetField('tokens')
    await form.actions().save()
    expect(stub.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['gate', 'tokens'] }], 7)
  })

  it('renders nothing while the namespace is not served', () => {
    const { stub, form } = bench()
    stub.publish({ status: 'unavailable', value: undefined, writable: false })
    expect(form.getSnapshot().shell.available).toBe(false)
  })
})
