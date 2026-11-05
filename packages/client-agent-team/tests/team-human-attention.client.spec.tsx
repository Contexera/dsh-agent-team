// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 30_000 })
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** The Thread page with one open Task whose Thread the Human can follow or unfollow. */
async function seedThreadPage(options?: { seedFollowers?: readonly string[] }) {
  const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seededMessages: [
    { body: '帮我看看这个方案', occurredAt: '2026-10-14T09:00:00.000Z' },
  ], ...(options?.seedFollowers === undefined ? {} : { seedFollowers: options.seedFollowers }) })
  fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
  fireEvent.click(await b.view.findByRole('button', { name: /^打开 Task #1：/ }))
  expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()
  return b
}

type Bench = Awaited<ReturnType<typeof runtimeWithTeam>>

/** Whether an element carries one CSS-module class token, matched by substring because the build hashes the names. */
function hasClass(element: Element | null, token: string): boolean {
  return element !== null && [...element.classList].some(name => name.includes(token))
}

/** The Thread page's action band, by its own marker rather than by any localized class. */
function actionBand(b: Bench): Element {
  const band = b.view.container.querySelector('[data-team-action-band]')
  if (band === null) throw new Error('no action band on the Thread page')
  return band
}

/** One group inside the band: the Thread's own actions, or the ones that resolve the Task. */
function actionGroup(b: Bench, group: 'thread' | 'lifecycle'): Element | null {
  return actionBand(b).querySelector(`[data-team-action-group="${group}"]`)
}

/** Open the handover dialog: a dialog, not a menu, because an empty candidate list has to explain itself. */
async function openTransferDialog(b: Bench): Promise<HTMLElement> {
  fireEvent.click(await b.view.findByRole('button', { name: '转交负责人' }))
  return b.view.findByRole('dialog', { name: '转交负责人' })
}

/** The candidate rows the dialog offers, by their visible labels, in render order. */
function candidateLabels(dialog: HTMLElement): string[] {
  return [...dialog.querySelectorAll('li button')].map(node => node.textContent ?? '')
}

describe('Team Human Attention and Task transfer controls', () => {
  it('follows and unfollows from the Thread page, writing the Host Remote and re-reading its observation', async () => {
    const b = await seedThreadPage({ seedFollowers: [] })
    const followButton = await b.view.findByRole('button', { name: '关注此 Thread' })
    expect(followButton.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(followButton)
    await waitFor(() => expect(b.changeAttention).toHaveBeenCalledWith(expect.objectContaining({ action: 'follow', taskRef: 'task:1' })))
    // The Host's answer is the display authority: the committed row carries the
    // Attention, and the re-read confirms the follower set from the Host side.
    await waitFor(() => expect(b.threadObservations.mock.calls.length).toBeGreaterThan(1))
    expect((await b.view.findByRole('button', { name: '取消关注此 Thread' })).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(b.view.getByRole('button', { name: '取消关注此 Thread' }))
    await waitFor(() => expect(b.changeAttention).toHaveBeenCalledWith(expect.objectContaining({ action: 'unfollow', taskRef: 'task:1' })))
    // The unfollow lands on the same follower set the follow landed on, so the
    // Host's re-projected observation is what retires the button's pressed state.
    await waitFor(() => expect(b.view.queryByRole('button', { name: '取消关注此 Thread' })).toBeNull())
    expect((b.view.getByRole('button', { name: '关注此 Thread' })).getAttribute('aria-pressed')).toBe('false')
    await b.runtime.dispose()
  })

  it('puts the Thread page actions in one band of two groups, with the pressed state only while followed', async () => {
    const b = await seedThreadPage({ seedFollowers: [] })
    // The transfer control stands on any Task, even with an empty offer: its dialog is where the empty
    // state lives, so the band does not change shape as followers come and go.
    await b.view.findByRole('button', { name: '转交负责人' })
    // One band, not four sibling containers: this is the layout claim the visual review
    // raised, and it is structural rather than cosmetic.
    expect(b.view.container.querySelectorAll('[data-team-action-band]').length).toBe(1)
    const band = actionBand(b)
    const threadGroup = actionGroup(b, 'thread')
    const lifecycleGroup = actionGroup(b, 'lifecycle')
    expect(threadGroup).not.toBeNull()
    expect(lifecycleGroup).not.toBeNull()
    // Both groups are direct children of the band, which is what lets the divider between them
    // state the hierarchy; a nested copy would keep two containers alive.
    expect(threadGroup!.parentElement).toBe(band)
    expect(lifecycleGroup!.parentElement).toBe(band)
    // Following the Thread and moving its responsibility are the Thread's own actions; accepting and
    // closing resolve it. Neither group may borrow the other's control.
    const threadLabels = within(threadGroup! as HTMLElement).getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent)
    expect(threadLabels).toEqual(['关注此 Thread', '转交负责人'])
    const lifecycleLabels = within(lifecycleGroup! as HTMLElement).getAllByRole('button').map(button => button.textContent)
    expect(lifecycleLabels).toEqual(['验收', '关闭任务'])
    // The pressed state is the control's own attribute carrying a class, so a followed Thread differs
    // from an unfollowed one by more than the stroke: the shipped outline variant paints nothing for
    // `aria-pressed`, and the visual review called that out.
    const follow = within(threadGroup! as HTMLElement).getByRole('button', { name: '关注此 Thread' })
    expect(hasClass(follow, 'toggleOn')).toBe(false)
    fireEvent.click(follow)
    const following = await within(threadGroup! as HTMLElement).findByRole('button', { name: '取消关注此 Thread' })
    expect(following.getAttribute('aria-pressed')).toBe('true')
    expect(hasClass(following, 'toggleOn')).toBe(true)
    // The band's only primary is the one that resolves the Task.
    expect(hasClass(within(lifecycleGroup! as HTMLElement).getByRole('button', { name: '验收' }), 'primary')).toBe(true)
    expect(hasClass(following, 'primary')).toBe(false)
    await b.runtime.dispose()
  })

  it('states a committed transfer where the control stands and retires the receipt on the next move', async () => {
    const b = await seedThreadPage({ seedFollowers: ['member:builder'] })
    const dialog = await openTransferDialog(b)
    fireEvent.click(within(dialog).getByRole('button', { name: '转交给 @builder' }))
    await waitFor(() => expect(b.transferTask).toHaveBeenCalledWith(expect.objectContaining({ target: 'member:builder' })))
    // The Host's activity row lands in the feed, but a long Thread scrolls it away from the band the
    // Human just used, so the band states the result itself.
    const receipt = await b.view.findByText('已转交给 @builder')
    expect(receipt.getAttribute('role')).toBe('status')
    // The receipt is derived from the projection, so when responsibility moves again the line
    // retires instead of claiming the Task is still where the earlier write put it.
    expect(await b.view.findByText(/把负责人从/)).toBeTruthy()
    await b.runtime.dispose()
  })

  it('keeps each refusing control\'s failure on its own line inside the band', async () => {
    const b = await seedThreadPage({ seedFollowers: ['member:builder'] })
    // Two controls can fail in one render; each states its own cause, so the reader is not asked to
    // work out which of two actions the one message belongs to.
    b.failAttention('关注状态不可用')
    b.seedTransferOutcome('failure')
    fireEvent.click(await b.view.findByRole('button', { name: '关注此 Thread' }))
    await waitFor(() => expect(b.view.getByRole('alert').textContent).toContain('关注状态不可用'))
    const dialog = await openTransferDialog(b)
    fireEvent.click(within(dialog).getByRole('button', { name: '转交给 @builder' }))
    // A dialog states its own failure where the reader is looking, in the same in-place band line the
    // follow control uses rather than the whole-surface replacement that centres itself over the band.
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('transfer unavailable (spec)'))
    expect(hasClass(within(dialog).getByRole('alert'), 'actionError')).toBe(true)
    // The band's own line stands behind the dialog, unchanged and still the same kind of line.
    const bandAlert = b.view.getAllByRole('alert').find(node => node.textContent?.includes('关注状态不可用'))
    expect(bandAlert).toBeTruthy()
    expect(hasClass(bandAlert ?? null, 'actionError')).toBe(true)
    await b.runtime.dispose()
  })

  it('keeps the previous follow standing and shows the failure when the write is refused', async () => {
    const b = await seedThreadPage({ seedFollowers: [] })
    fireEvent.click(await b.view.findByRole('button', { name: '关注此 Thread' }))
    await waitFor(() => expect(b.changeAttention).toHaveBeenCalled())
    expect(await b.view.findByRole('button', { name: '取消关注此 Thread' })).toBeTruthy()
    // The next write fails: the control must not flip, and the failure must stay
    // on a recoverable surface beside the untouched button.
    b.failAttention('关注状态不可用')
    fireEvent.click(b.view.getByRole('button', { name: '取消关注此 Thread' }))
    expect(await b.view.findByRole('alert')).toBeTruthy()
    expect(b.view.getByRole('alert').textContent).toContain('关注状态不可用')
    expect(b.view.getByRole('button', { name: '取消关注此 Thread' }).getAttribute('aria-pressed')).toBe('true')
    await b.runtime.dispose()
  })

  it('commits a fresh follow after an unfollow instead of replaying the first one', async () => {
    const b = await seedThreadPage({ seedFollowers: [] })
    fireEvent.click(await b.view.findByRole('button', { name: '关注此 Thread' }))
    await waitFor(() => expect(b.changeAttention).toHaveBeenCalledTimes(1))
    expect(await b.view.findByRole('button', { name: '取消关注此 Thread' })).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: '取消关注此 Thread' }))
    await waitFor(() => expect(b.changeAttention).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(b.view.queryByRole('button', { name: '取消关注此 Thread' })).toBeNull())
    // Following again must be a new operation, not the first one replayed. The Host
    // answers a requestId it has already committed from its cache — so a reused id
    // would hand back the first follow's row and leave the button claiming a
    // standing the Host's own follower set does not hold.
    fireEvent.click(b.view.getByRole('button', { name: '关注此 Thread' }))
    await waitFor(() => expect(b.changeAttention).toHaveBeenCalledTimes(3))
    const ids = b.changeAttention.mock.calls.map(call => call[0].requestId)
    expect(new Set(ids).size).toBe(3)
    expect((await b.view.findByRole('button', { name: '取消关注此 Thread' })).getAttribute('aria-pressed')).toBe('true')
    await b.runtime.dispose()
  })

  it('follows the Host observation when another face changes the standing', async () => {
    const b = await seedThreadPage({ seedFollowers: [] })
    await b.view.findByRole('button', { name: '关注此 Thread' })
    // Another face — the discussion panel, or a second client — follows this Thread.
    // The Host projects it, and the subscription tick is what carries it here.
    b.threadObservations.mockImplementation(async () => ({ ok: true as const, value: { items: [], followers: ['member:human'] } }))
    b.publishProjectUpdate()
    // The control paints what the Host last answered, without the Human touching it.
    await waitFor(() => expect(b.view.queryByRole('button', { name: '取消关注此 Thread' })).not.toBeNull())
    // And it stays in step the other way: stepping back must be offered as an unfollow.
    b.threadObservations.mockImplementation(async () => ({ ok: true as const, value: { items: [], followers: [] } }))
    b.publishProjectUpdate()
    await waitFor(() => expect(b.view.queryByRole('button', { name: '取消关注此 Thread' })).toBeNull())
    await b.runtime.dispose()
  })

  it('offers this Thread\'s followers and hands the Task to the one the Human picks', async () => {
    const b = await seedThreadPage({ seedFollowers: ['member:builder', 'member:human'] })
    const dialog = await openTransferDialog(b)
    // The follower set is the whole offer: the Human is this Task's current accountable, so the one
    // candidate left is the Agent that follows this Thread — not every Project owner the Host knows.
    expect(candidateLabels(dialog)).toEqual(['转交给 @builder'])
    fireEvent.click(within(dialog).getByRole('button', { name: '转交给 @builder' }))
    await waitFor(() => expect(b.transferTask).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'task:1', target: 'member:builder' })))
    // The Host's own transfer row lands in the feed, exactly as an accept or close lands its own, and
    // the committed write closes the dialog instead of leaving it asking for the same decision again.
    expect(await b.view.findByText(/把负责人从/)).toBeTruthy()
    await waitFor(() => expect(b.view.queryByRole('dialog', { name: '转交负责人' })).toBeNull())
    await b.runtime.dispose()
  })

  it('explains an empty candidate list instead of offering nobody', async () => {
    const b = await seedThreadPage({ seedFollowers: [] })
    const dialog = await openTransferDialog(b)
    expect(candidateLabels(dialog)).toEqual([])
    // Nobody follows this Thread, so there is no one the dialog may offer; the empty state is the only
    // place that says why, which is why the control stays pressable instead of vanishing.
    expect(within(dialog).getByRole('status').textContent).toContain('没有关注者')
    expect(b.view.getByRole('button', { name: '转交负责人' })).toBeTruthy()
    await b.runtime.dispose()
  })

  it('keeps the Task on screen when the Host fences the transfer behind the unread gate', async () => {
    const b = await seedThreadPage({ seedFollowers: ['member:builder'] })
    b.seedTransferOutcome('unread_required')
    const dialog = await openTransferDialog(b)
    fireEvent.click(within(dialog).getByRole('button', { name: '转交给 @builder' }))
    await waitFor(() => expect(b.transferTask).toHaveBeenCalled())
    // A fence is a business answer, not a crash: the Task's current accountable stands, the dialog gets
    // out of the way, and the band states the refusal where the write started.
    expect(await b.view.findByRole('alert').then(node => node.textContent)).toContain('未读')
    expect(b.view.queryByRole('dialog', { name: '转交负责人' })).toBeNull()
    await b.runtime.dispose()
  })

  it('keeps the transfer control on a closed Task so a finished one can still be mended', async () => {
    const b = await seedThreadPage({ seedFollowers: ['member:builder'] })
    // Only a Member actor is confined to open Tasks, and this surface is the Human's: a closed Task
    // whose accountable left the Project is mended from here, so the control must not vanish with
    // the resolution. The write itself stays fenced by the Host.
    fireEvent.click(await b.view.findByRole('button', { name: '关闭任务' }))
    await waitFor(() => expect(b.changeTask).toHaveBeenCalledWith(expect.objectContaining({ action: 'close' })))
    await waitFor(() => expect(b.view.getByText('任务已关闭，重新打开后可继续讨论')).toBeTruthy())
    const dialog = await openTransferDialog(b)
    fireEvent.click(within(dialog).getByRole('button', { name: '转交给 @builder' }))
    await waitFor(() => expect(b.transferTask).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'task:1', target: 'member:builder' })))
    await b.runtime.dispose()
  })

  it('offers the Human only while the Human follows this Thread, which is how a broken Task is mended', async () => {
    const b = await seedThreadPage({ seedFollowers: ['member:builder'] })
    // The Human does not follow this Thread yet, so the Human is not a candidate: the offer is the
    // follower set, and the Host's own `humanMemberId` adds no entry to it.
    const first = await openTransferDialog(b)
    expect(candidateLabels(first)).toEqual(['转交给 @builder'])
    fireEvent.click(within(first).getByRole('button', { name: '转交给 @builder' }))
    await waitFor(() => expect(b.transferTask).toHaveBeenCalledWith(expect.objectContaining({ target: 'member:builder' })))
    // The Human follows: the Host's observation now carries its own id, so the dialog offers it back —
    // which is what mends a Task whose Agent accountable left the Project.
    b.threadObservations.mockImplementation(async () => ({ ok: true as const, value: { items: [], followers: ['member:builder', 'member:human'] } }))
    b.publishProjectUpdate()
    const second = await openTransferDialog(b)
    await waitFor(() => expect(candidateLabels(second)).toEqual(['转交给你自己']))
    fireEvent.click(within(second).getByRole('button', { name: '转交给你自己' }))
    await waitFor(() => expect(b.transferTask).toHaveBeenCalledWith(expect.objectContaining({ target: 'member:human' })))
    await b.runtime.dispose()
  })

  it('re-reads the Thread after an unread fence and the wider history after a stale one', async () => {
    const b = await seedThreadPage({ seedFollowers: ['member:builder'] })
    // An unread fence is answered with a durable read plus a drain, exactly as accept or close does.
    b.seedTransferOutcome('unread_required')
    const readsBefore = b.readThread.mock.calls.length
    const dialog = await openTransferDialog(b)
    fireEvent.click(within(dialog).getByRole('button', { name: '转交给 @builder' }))
    await waitFor(() => expect(b.transferTask).toHaveBeenCalled())
    await waitFor(() => expect(b.readThread.mock.calls.length).toBeGreaterThan(readsBefore))
    // The Task's accountable stays the Human: a fence moves nothing.
    expect(await b.view.findByRole('alert').then(node => node.textContent)).toContain('未读')
    await b.runtime.dispose()
  })

  it('re-reads the wider history after a stale revision so the retry sees the current Task', async () => {
    const b = await seedThreadPage({ seedFollowers: ['member:builder'] })
    // A stale revision re-projects the Thread rather than leaving a stale one on screen.
    b.seedTransferOutcome('stale_revision')
    const historyBefore = b.loadThreadHistory.mock.calls.length
    const dialog = await openTransferDialog(b)
    fireEvent.click(within(dialog).getByRole('button', { name: '转交给 @builder' }))
    await waitFor(() => expect(b.transferTask).toHaveBeenCalled())
    await waitFor(() => expect(b.loadThreadHistory.mock.calls.length).toBeGreaterThan(historyBefore))
    expect(await b.view.findByRole('alert').then(node => node.textContent)).toContain('发生变化')
    await b.runtime.dispose()
  })

  it('shows a failed follow write on the discussion panel beside the untouched control', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskless: true, seedFollowers: [], seededMessages: [
      { body: '帮我看看这个方案', occurredAt: '2026-10-14T09:00:00.000Z' },
    ] })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await b.view.findByRole('button', { name: /^打开讨论：/ }))
    const panel = await b.view.findByRole('complementary', { name: '讨论' })
    b.failAttention('关注状态不可用')
    fireEvent.click(await within(panel).findByRole('button', { name: '关注此 Thread' }))
    // The failure is stated on the panel's own alert surface, not dropped: the Human can see why.
    const alert = await within(panel).findByRole('alert')
    expect(alert.textContent).toContain('关注状态不可用')
    // The control keeps its previous standing instead of claiming a follow that never landed.
    expect(within(panel).getByRole('button', { name: '关注此 Thread' }).getAttribute('aria-pressed')).toBe('false')
    await b.runtime.dispose()
  })

  it('offers the same follow control on the discussion panel and writes through the same Remote', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskless: true, seedFollowers: [], seededMessages: [
      { body: '帮我看看这个方案', occurredAt: '2026-10-14T09:00:00.000Z' },
    ] })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await b.view.findByRole('button', { name: /^打开讨论：/ }))
    const panel = await b.view.findByRole('complementary', { name: '讨论' })
    const panelFollow = await within(panel).findByRole('button', { name: '关注此 Thread' })
    expect(panelFollow.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(panelFollow)
    await waitFor(() => expect(b.changeAttention).toHaveBeenCalledWith(expect.objectContaining({ action: 'follow', threadRef: 'thread:1' })))
    expect((await within(panel).findByRole('button', { name: '取消关注此 Thread' })).getAttribute('aria-pressed')).toBe('true')
    // The panel is a taskless Thread's face: the transfer control belongs to the
    // Thread page, so the panel offers no responsibility entry point at all.
    expect(within(panel).queryByRole('button', { name: '转交负责人' })).toBeNull()
    await b.runtime.dispose()
  })

  it('keeps a stale transfer recoverable: the refusal re-reads and the Task stands', async () => {
    const b = await seedThreadPage({ seedFollowers: ['member:builder'] })
    const readsBefore = b.loadThreadHistory.mock.calls.length
    b.seedTransferOutcome('stale_revision')
    const dialog = await openTransferDialog(b)
    fireEvent.click(within(dialog).getByRole('button', { name: '转交给 @builder' }))
    await waitFor(() => expect(b.transferTask).toHaveBeenCalled())
    expect(await b.view.findByRole('alert').then(node => node.textContent)).toContain('发生变化')
    // The page re-reads the wider history rather than stranding the reader on a stale projection.
    await waitFor(() => expect(b.loadThreadHistory.mock.calls.length).toBeGreaterThan(readsBefore))
    // The Human stays the accountable, and the control stays available for a retry.
    expect(b.view.getByRole('button', { name: '转交负责人' })).toBeTruthy()
    await b.runtime.dispose()
  })

  it('shows a failed transfer as an error that leaves the control usable', async () => {
    const b = await seedThreadPage({ seedFollowers: ['member:builder'] })
    b.seedTransferOutcome('failure')
    const dialog = await openTransferDialog(b)
    fireEvent.click(within(dialog).getByRole('button', { name: '转交给 @builder' }))
    expect(await within(dialog).findByRole('alert').then(node => node.textContent)).toContain('transfer unavailable (spec)')
    // A failed write is recoverable in place: the row is offered again, and pressing it retries.
    await waitFor(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: '转交给 @builder' }))
      expect(b.transferTask).toHaveBeenCalledTimes(2)
    })
    // The second failure keeps the same recoverable surface rather than locking the control.
    expect(within(dialog).getByRole('alert').textContent).toContain('transfer unavailable (spec)')
    await b.runtime.dispose()
  })

  it('announces a running write in the full phrase the shortened visible word cannot say', async () => {
    const b = await seedThreadPage({ seedFollowers: ['member:builder'] })
    await b.view.findByRole('button', { name: '转交负责人' })
    // Both writes are held open, so the pending render is a state this spec can read rather than a
    // frame that has already passed: the point under test is what the control says while it runs.
    let releaseFollow!: () => void
    const followGate = new Promise<void>(resolve => { releaseFollow = resolve })
    const commitFollow = b.changeAttention.getMockImplementation()!
    b.changeAttention.mockImplementationOnce(async request => { await followGate; return commitFollow(request) })
    fireEvent.click(b.view.getByRole('button', { name: '关注此 Thread' }))
    // The visible word shortens to fit the band; the accessible name does not, because a reader who
    // cannot see the band still has to be told the write is running. A name frozen at the idle phrase
    // would announce the action as if nothing were happening.
    const pendingFollow = await b.view.findByRole('button', { name: '正在更新关注状态…' })
    expect(pendingFollow.textContent).toBe('更新中…')
    expect((pendingFollow as HTMLButtonElement).disabled).toBe(true)
    releaseFollow()
    // The long name is only the pending standing: the settled control announces its idle phrase again.
    expect(await b.view.findByRole('button', { name: '取消关注此 Thread' })).toBeTruthy()
    expect(b.view.queryByRole('button', { name: '正在更新关注状态…' })).toBeNull()

    let releaseTransfer!: () => void
    const transferGate = new Promise<void>(resolve => { releaseTransfer = resolve })
    const commitTransfer = b.transferTask.getMockImplementation()!
    b.transferTask.mockImplementationOnce(async request => { await transferGate; return commitTransfer(request) })
    const dialog = await openTransferDialog(b)
    fireEvent.click(within(dialog).getByRole('button', { name: '转交给 @builder' }))
    const pendingTransfer = await b.view.findByRole('button', { name: '正在转交负责人…' })
    expect(pendingTransfer.textContent).toBe('转交中…')
    expect((pendingTransfer as HTMLButtonElement).disabled).toBe(true)
    // While the write runs, every candidate row is disabled too: the dialog cannot start a second one.
    expect((within(dialog).getByRole('button', { name: '转交给 @builder' }) as HTMLButtonElement).disabled).toBe(true)
    releaseTransfer()
    await waitFor(() => expect(b.transferTask).toHaveBeenCalledWith(expect.objectContaining({ target: 'member:builder' })))
    await b.runtime.dispose()
  })

  it('announces a running follow write on the discussion panel the same way', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskless: true, seedFollowers: [], seededMessages: [
      { body: '帮我看看这个方案', occurredAt: '2026-10-14T09:00:00.000Z' },
    ] })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await b.view.findByRole('button', { name: /^打开讨论：/ }))
    const panel = await b.view.findByRole('complementary', { name: '讨论' })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const commit = b.changeAttention.getMockImplementation()!
    b.changeAttention.mockImplementationOnce(async request => { await gate; return commit(request) })
    fireEvent.click(await within(panel).findByRole('button', { name: '关注此 Thread' }))
    // The panel carries the same control in its own room, so it makes the same promise while running.
    const pending = await within(panel).findByRole('button', { name: '正在更新关注状态…' })
    expect(pending.textContent).toBe('更新中…')
    release()
    expect((await within(panel).findByRole('button', { name: '取消关注此 Thread' })).getAttribute('aria-pressed')).toBe('true')
    await b.runtime.dispose()
  })

  it('restores the follow standing a reload answers with, from the Host observation alone', async () => {
    // The Human followed before the reload; the projection that comes back says so,
    // which is the state a restored page must display rather than its own guess.
    const b = await seedThreadPage({ seedFollowers: ['member:human'] })
    const following = await b.view.findByRole('button', { name: '取消关注此 Thread' })
    expect(following.getAttribute('aria-pressed')).toBe('true')
    // No write happened on this visit: the standing came from the observation read.
    expect(b.changeAttention).not.toHaveBeenCalled()
    await b.runtime.dispose()
  })

  // The follower set the Host projects is every Member's Attention, not the Human's row alone. Each
  // case below pins one side of the identity question: a set that holds only other Members, a set
  // that holds the Human, and a write whose re-read answers with the set that fooled the control.
  describe('reads the Human\'s own standing out of the whole follower set', () => {
    it('is not following when the set holds only other Members', async () => {
      // Two Agents follow, the Human does not. The set is non-empty, so a control that asks
      // "is anyone following?" reads this as followed — the wrong answer, in both directions.
      const b = await seedThreadPage({ seedFollowers: ['member:builder', 'member:reviewer'] })
      const follow = await b.view.findByRole('button', { name: '关注此 Thread' })
      expect(follow.getAttribute('aria-pressed')).toBe('false')
      // The visible verb says the same thing the attribute does: a mismatch between the two is
      // the exact defect, where the label read 「关注」 while the button stayed pressed.
      expect(follow.textContent).toBe('关注')
      await b.runtime.dispose()
    })

    it('is following when the set holds the Human among other Members', async () => {
      const b = await seedThreadPage({ seedFollowers: ['member:builder', 'member:human', 'member:reviewer'] })
      const follow = await b.view.findByRole('button', { name: '取消关注此 Thread' })
      expect(follow.getAttribute('aria-pressed')).toBe('true')
      await b.runtime.dispose()
    })

    it('stays unfollowed after the unfollow, even though other Members still follow', async () => {
      // The defect's own scenario: the Human unfollows, the Agents stay, and the re-read answers
      // with a non-empty set. The pressed state must come from the Human's row in that set.
      const b = await seedThreadPage({ seedFollowers: ['member:builder', 'member:human', 'member:reviewer'] })
      fireEvent.click(await b.view.findByRole('button', { name: '取消关注此 Thread' }))
      await waitFor(() => expect(b.changeAttention).toHaveBeenCalledWith(expect.objectContaining({ action: 'unfollow', taskRef: 'task:1' })))
      // The re-read that follows the write is what used to overwrite the standing with "someone follows".
      await waitFor(() => expect(b.threadObservations.mock.calls.length).toBeGreaterThan(1))
      const follow = b.view.getByRole('button', { name: '关注此 Thread' })
      expect(follow.getAttribute('aria-pressed')).toBe('false')
      // And the pressed fill goes with the attribute: the fill is a class, so it needs its own check.
      expect(hasClass(follow, 'toggleOn')).toBe(false)
      // The Human's unfollow did not touch the other Members' Attention, which is the set the
      // mention composer still ranks from — the fix must not clear it either. The read goes through
      // the Host double, so the set it answers with is the one the control also read.
      const observation = await b.threadObservations.getMockImplementation()!({ taskRef: 'task:1' })
      expect(observation.value.followers).toEqual(['member:builder', 'member:reviewer'])
      await b.runtime.dispose()
    })

    it('does not claim an existing follow when only other Members follow', async () => {
      // The other direction of the same defect: pressing follow here used to answer
      // "already following" from the Host, because the control thought it was followed already.
      const b = await seedThreadPage({ seedFollowers: ['member:builder'] })
      fireEvent.click(await b.view.findByRole('button', { name: '关注此 Thread' }))
      await waitFor(() => expect(b.changeAttention).toHaveBeenCalledWith(expect.objectContaining({ action: 'follow', taskRef: 'task:1' })))
      expect((await b.view.findByRole('button', { name: '取消关注此 Thread' })).getAttribute('aria-pressed')).toBe('true')
      await b.runtime.dispose()
    })
  })
})
