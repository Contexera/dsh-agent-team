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

/** One Agent Project owner besides the Human, the only legal transfer target the Host projects. */
function seedProjectOwner(b: Bench): void {
  const baseView = b.viewProjects.getMockImplementation()!
  b.viewProjects.mockImplementation(async (request: { threadRef?: string; topLevelOnly?: boolean }) => {
    const result = await baseView(request)
    if (!result.ok) return result
    return { ok: true as const, value: { ...result.value, owners: [{ projectRef: 'project:engineering', memberId: 'member:builder' }] } }
  })
  b.publishProjectUpdate()
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

  it('hands an open Task to a Project owner the Host projected and merges the transfer activity', async () => {
    const b = await seedThreadPage({ seedFollowers: [] })
    seedProjectOwner(b)
    const menuButton = await b.view.findByRole('button', { name: '转交负责人' })
    fireEvent.click(menuButton)
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
    await waitFor(() => expect(b.transferTask).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'task:1', target: 'member:builder' })))
    // The Host's own transfer row lands in the feed, exactly as an accept or close lands its own.
    // The menu trigger also carries the word, so the activity row is matched by its full sentence.
    expect(await b.view.findByText(/把负责人从/)).toBeTruthy()
    await b.runtime.dispose()
  })

  it('keeps the Task on screen when the Host fences the transfer behind the unread gate', async () => {
    const b = await seedThreadPage({ seedFollowers: [] })
    seedProjectOwner(b)
    b.seedTransferOutcome('unread_required')
    fireEvent.click(await b.view.findByRole('button', { name: '转交负责人' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
    await waitFor(() => expect(b.transferTask).toHaveBeenCalled())
    // A fence is a business answer, not a crash: the Task's current accountable
    // stands, and the refusal says what to do next.
    expect(await b.view.findByRole('alert').then(node => node.textContent)).toContain('未读')
    await b.runtime.dispose()
  })

  it('keeps the transfer control on a closed Task so a finished one can still be mended', async () => {
    const b = await seedThreadPage({ seedFollowers: [] })
    seedProjectOwner(b)
    // Only a Member actor is confined to open Tasks, and this surface is the Human's: a closed Task
    // whose accountable left the Project is mended from here, so the control must not vanish with
    // the resolution. The write itself stays fenced by the Host.
    fireEvent.click(await b.view.findByRole('button', { name: '关闭任务' }))
    await waitFor(() => expect(b.changeTask).toHaveBeenCalledWith(expect.objectContaining({ action: 'close' })))
    await waitFor(() => expect(b.view.getByText('任务已关闭，重新打开后可继续讨论')).toBeTruthy())
    const mendTrigger = b.view.getByRole('button', { name: '转交负责人' })
    await waitFor(() => expect(mendTrigger).toBeTruthy())
    fireEvent.click(mendTrigger)
    await waitFor(() => expect(within(document.body).getAllByRole('menuitem').length).toBeGreaterThan(0))
    fireEvent.click(within(document.body).getByRole('menuitem', { name: /builder/ }))
    await waitFor(() => expect(b.transferTask).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'task:1', target: 'member:builder' })))
    await b.runtime.dispose()
  })

  it('offers the Human as a transfer target, which is how a broken Task is mended', async () => {
    const b = await seedThreadPage({ seedFollowers: [] })
    seedProjectOwner(b)
    // The seeded Task is accountable to the Human already, so the mend path needs one that is not:
    // hand it to the Agent owner first, which also proves the two targets are distinct.
    fireEvent.click(await b.view.findByRole('button', { name: '转交负责人' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
    await waitFor(() => expect(b.transferTask).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'task:1', target: 'member:builder' })))
    // The Host never lists the Human in `owners`; `humanMemberId` is its own answer, so the menu
    // carries both. A Task whose accountable left the Project is mended this way.
    fireEvent.click(b.view.getByRole('button', { name: '转交负责人' }))
    await waitFor(() => expect(within(document.body).getAllByRole('menuitem').length).toBeGreaterThan(0))
    const options = within(document.body).getAllByRole('menuitem').map(item => item.textContent ?? '')
    expect(options).toEqual(['转交给你自己'])
    fireEvent.click(within(document.body).getByRole('menuitem', { name: '转交给你自己' }))
    await waitFor(() => expect(b.transferTask).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'task:1', target: 'member:human' })))
    expect(await b.view.findByText(/把负责人从/)).toBeTruthy()
    await b.runtime.dispose()
  })

  it('re-reads the Thread after an unread fence and the wider history after a stale one', async () => {
    const b = await seedThreadPage({ seedFollowers: [] })
    seedProjectOwner(b)
    // An unread fence is answered with a durable read plus a drain, exactly as accept or close does.
    b.seedTransferOutcome('unread_required')
    const readsBefore = b.readThread.mock.calls.length
    fireEvent.click(await b.view.findByRole('button', { name: '转交负责人' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
    await waitFor(() => expect(b.transferTask).toHaveBeenCalled())
    await waitFor(() => expect(b.readThread.mock.calls.length).toBeGreaterThan(readsBefore))
    // The Task's accountable stays the Human: a fence moves nothing.
    expect(await b.view.findByRole('alert').then(node => node.textContent)).toContain('未读')
    await b.runtime.dispose()
  })

  it('re-reads the wider history after a stale revision so the retry sees the current Task', async () => {
    const b = await seedThreadPage({ seedFollowers: [] })
    seedProjectOwner(b)
    // A stale revision re-projects the Thread rather than leaving a stale one on screen.
    b.seedTransferOutcome('stale_revision')
    const historyBefore = b.loadThreadHistory.mock.calls.length
    fireEvent.click(await b.view.findByRole('button', { name: '转交负责人' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
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
    const b = await seedThreadPage({ seedFollowers: [] })
    seedProjectOwner(b)
    const readsBefore = b.loadThreadHistory.mock.calls.length
    b.seedTransferOutcome('stale_revision')
    fireEvent.click(await b.view.findByRole('button', { name: '转交负责人' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
    await waitFor(() => expect(b.transferTask).toHaveBeenCalled())
    expect(await b.view.findByRole('alert').then(node => node.textContent)).toContain('发生变化')
    // The page re-reads the wider history rather than stranding the reader on a stale projection.
    await waitFor(() => expect(b.loadThreadHistory.mock.calls.length).toBeGreaterThan(readsBefore))
    // The Human stays the accountable, and the control stays available for a retry.
    expect(b.view.getByRole('button', { name: '转交负责人' })).toBeTruthy()
    await b.runtime.dispose()
  })

  it('shows a failed transfer as an error that leaves the control usable', async () => {
    const b = await seedThreadPage({ seedFollowers: [] })
    seedProjectOwner(b)
    b.seedTransferOutcome('failure')
    fireEvent.click(await b.view.findByRole('button', { name: '转交负责人' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
    expect(await b.view.findByRole('alert').then(node => node.textContent)).toContain('transfer unavailable (spec)')
    // A failed write is recoverable: the entry is offered again, and pressing it is allowed.
    // The menu list is a portal the runtime re-renders between the query and the click, so the
    // interaction itself is retried until the second call actually lands.
    await waitFor(() => {
      fireEvent.click(b.view.getByRole('button', { name: '转交负责人' }))
      fireEvent.click(within(document.body).getByRole('menuitem', { name: /builder/ }))
      expect(b.transferTask).toHaveBeenCalledTimes(2)
    })
    // The second failure keeps the same recoverable surface rather than locking the control.
    expect(b.view.getByRole('alert').textContent).toContain('transfer unavailable (spec)')
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
})
