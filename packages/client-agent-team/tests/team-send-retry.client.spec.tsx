// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fireEvent, waitFor } from '@testing-library/react'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { AgentTeamPostMainMessageRequest, AgentTeamPutAttachmentRequest, AgentTeamReplyRequest } from '@contexera/dsh-agent-team/types'
import { pressStartTask, runtimeWithTeam } from './harness.tsx'
usePinnedBrowserLanguages('zh-CN')

type Runtime = Awaited<ReturnType<typeof runtimeWithTeam>>
type PutRequestFixture = Omit<AgentTeamPutAttachmentRequest, 'mediaType'> & { readonly mediaType?: string | undefined }
type PostRequestFixture = Omit<AgentTeamPostMainMessageRequest, 'attachments'> & {
  readonly attachments?: AgentTeamPostMainMessageRequest['attachments']
}

const carrierFailure = (endpoint: string): { ok: false; error: RemoteError<'gateway/internal'> } => ({
  ok: false,
  error: new RemoteError('gateway/internal', `client api: ${endpoint} failed: socket closed`, {}),
})

async function openProject(): Promise<Runtime> {
  const runtime = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true })
  fireEvent.click(await runtime.view.findByRole('button', { name: '# engineering' }))
  await runtime.view.findByRole('tab', { name: '主对话' })
  return runtime
}

const typeDraft = (runtime: Runtime, text: string): void => {
  fireEvent.change(runtime.view.getByRole('textbox', { name: '消息内容' }), { target: { value: text } })
}

const addFiles = async (runtime: Runtime, files: readonly File[]): Promise<void> => {
  const input = runtime.view.container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files } })
  await waitFor(() => {
    expect(runtime.view.container.querySelectorAll('ul[aria-label="添加附件"] > li')).toHaveLength(files.length)
  })
}

const waitForSend = async (runtime: Runtime): Promise<HTMLButtonElement> => {
  let button: HTMLButtonElement | undefined
  await waitFor(() => {
    button = runtime.view.getByRole('button', { name: '发送' }) as HTMLButtonElement
    expect(button.hasAttribute('disabled')).toBe(false)
  })
  return button!
}

describe('Team send retry', () => {
  it('reuses partial uploads and the Main request after both responses are lost', async () => {
    const runtime = await openProject()
    const originalPut = runtime.putAttachment.getMockImplementation()!
    const storedUploads = new Map<string, Awaited<ReturnType<typeof originalPut>>>()
    let loseSecondUpload = true
    runtime.putAttachment.mockImplementation((async (request: PutRequestFixture) => {
      const stored = storedUploads.get(request.requestId)
      if (stored !== undefined) return stored
      const { mediaType, ...rest } = request
      const uploaded = await originalPut({ ...rest, ...(mediaType === undefined ? {} : { mediaType }) })
      storedUploads.set(request.requestId, uploaded)
      if (storedUploads.size === 2 && loseSecondUpload) {
        loseSecondUpload = false
        return carrierFailure('agentTeam/putAttachment')
      }
      return uploaded
    }) as never)

    const originalPost = runtime.postMainMessage.getMockImplementation()!
    const committed = new Map<string, Awaited<ReturnType<typeof originalPost>>>()
    let losePostResponse = false
    runtime.postMainMessage.mockImplementation((async (request: PostRequestFixture) => {
      let result = committed.get(request.requestId)
      if (result === undefined) {
        const { attachments, ...rest } = request
        result = await originalPost({ ...rest, ...(attachments === undefined ? {} : { attachments }) })
        committed.set(request.requestId, result)
      }
      if (losePostResponse) {
        losePostResponse = false
        return carrierFailure('agentTeam/postMainMessage')
      }
      return result
    }) as never)

    await addFiles(runtime, [
      new File(['one'], 'one.png', { type: 'image/png' }),
      new File(['two'], 'two.png', { type: 'image/png' }),
    ])
    typeDraft(runtime, '两条附件')
    fireEvent.click(await waitForSend(runtime))
    await waitFor(() => { expect(runtime.putAttachment).toHaveBeenCalledTimes(2) })

    losePostResponse = true
    fireEvent.click(await waitForSend(runtime))
    await waitFor(() => { expect(runtime.postMainMessage).toHaveBeenCalledTimes(1) })

    fireEvent.click(await waitForSend(runtime))
    await waitFor(() => { expect(runtime.postMainMessage).toHaveBeenCalledTimes(2) })

    const uploads = runtime.putAttachment.mock.calls.map(([request]) => request)
    expect(uploads).toHaveLength(3)
    expect(uploads[1]!.requestId).toBe(uploads[2]!.requestId)
    expect(uploads[0]!.requestId).not.toBe(uploads[1]!.requestId)
    const posts = runtime.postMainMessage.mock.calls.map(([request]) => request)
    expect(posts[1]).toEqual(posts[0])
    expect(posts[1]!.attachments).toEqual(['attachment:1', 'attachment:2'])
  })

  it('replays a thrown Task start with the same request and attachment', async () => {
    const runtime = await openProject()
    pressStartTask(runtime.view)
    await addFiles(runtime, [new File(['task'], 'task.png', { type: 'image/png' })])
    typeDraft(runtime, '新任务')
    runtime.startThread.mockRejectedValueOnce(new Error('offline before dispatch'))

    fireEvent.click(await waitForSend(runtime))
    await waitFor(() => { expect(runtime.startThread).toHaveBeenCalledTimes(1) })
    fireEvent.click(await waitForSend(runtime))
    await waitFor(() => { expect(runtime.startThread).toHaveBeenCalledTimes(2) })

    const first = runtime.startThread.mock.calls[0]![0]
    const second = runtime.startThread.mock.calls[1]![0]
    expect(second).toEqual(first)
    expect(second).toMatchObject({ kind: 'task', attachments: ['attachment:1'] })
    expect(runtime.putAttachment).toHaveBeenCalledTimes(1)
  })

  it('replays a Thread reply after its committed message refreshes the revision', async () => {
    const runtime = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialProjects: true,
      seededMessages: [{ body: '开个任务', occurredAt: '2026-08-21T09:00:00.000Z' }],
    })
    fireEvent.click(await runtime.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await runtime.view.findByRole('button', { name: /^打开 Task #1：/ }))
    await runtime.view.findByRole('heading', { name: 'Task #1' })
    const historyReadsBefore = runtime.loadThreadHistory.mock.calls.length

    const originalReply = runtime.reply.getMockImplementation()!
    const committed = new Map<string, Awaited<ReturnType<typeof originalReply>>>()
    let loseReplyResponse = true
    runtime.reply.mockImplementation((async (request: AgentTeamReplyRequest) => {
      let result = committed.get(request.requestId)
      if (result === undefined) {
        result = await originalReply(request)
        committed.set(request.requestId, result)
      }
      if (loseReplyResponse) {
        loseReplyResponse = false
        runtime.publishAgentReply()
        return carrierFailure('agentTeam/reply')
      }
      return result
    }) as never)

    await addFiles(runtime, [new File(['reply'], 'reply.png', { type: 'image/png' })])
    typeDraft(runtime, '刷新后重试')
    fireEvent.click(await waitForSend(runtime))
    await waitFor(() => { expect(runtime.reply).toHaveBeenCalledTimes(1) })
    await waitFor(() => { expect(runtime.loadThreadHistory.mock.calls.length).toBeGreaterThan(historyReadsBefore) })

    // A later Task action moves the Thread past the receipt this retry will return.
    await runtime.changeTask({ action: 'accept' })
    runtime.publishAgentReply()
    const fresherReads = runtime.loadThreadHistory.mock.calls.length
    await waitFor(() => { expect(runtime.loadThreadHistory.mock.calls.length).toBeGreaterThan(fresherReads) })
    expect(await runtime.view.findByText('已完成')).toBeTruthy()

    fireEvent.click(await waitForSend(runtime))
    await waitFor(() => { expect(runtime.reply).toHaveBeenCalledTimes(2) })

    const first = runtime.reply.mock.calls[0]![0]
    const second = runtime.reply.mock.calls[1]![0]
    expect(second).toEqual(first)
    expect(second).toMatchObject({ baseRevision: 2, attachments: ['attachment:1'] })
    expect(runtime.putAttachment).toHaveBeenCalledTimes(1)
    expect(await runtime.view.findByText('已完成')).toBeTruthy()
  })

  it('starts a new Main request after the draft changes', async () => {
    const runtime = await openProject()
    runtime.postMainMessage.mockResolvedValueOnce(carrierFailure('agentTeam/postMainMessage') as never)
    typeDraft(runtime, '第一版')
    fireEvent.click(await waitForSend(runtime))
    await waitFor(() => { expect(runtime.postMainMessage).toHaveBeenCalledTimes(1) })

    typeDraft(runtime, '第二版')
    fireEvent.click(await waitForSend(runtime))
    await waitFor(() => { expect(runtime.postMainMessage).toHaveBeenCalledTimes(2) })

    const first = runtime.postMainMessage.mock.calls[0]![0]
    const second = runtime.postMainMessage.mock.calls[1]![0]
    expect(second.body).toBe('第二版')
    expect(second.requestId).not.toBe(first.requestId)
  })

  it('guards a rapid second Main submit', async () => {
    const runtime = await openProject()
    typeDraft(runtime, '只发一次')
    const send = await waitForSend(runtime)
    fireEvent.click(send)
    fireEvent.click(send)
    await waitFor(() => { expect(runtime.postMainMessage).toHaveBeenCalledTimes(1) })
    await waitFor(() => {
      expect((runtime.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement).readOnly).toBe(false)
    })
    expect(runtime.postMainMessage).toHaveBeenCalledTimes(1)
  })

  it('does not let an old Main completion clear a newer draft', async () => {
    const runtime = await openProject()
    const originalPost = runtime.postMainMessage.getMockImplementation()!
    let resolvePost!: () => void
    runtime.postMainMessage.mockImplementationOnce(async request => {
      const result = await originalPost(request)
      return new Promise<Awaited<ReturnType<typeof originalPost>>>(resolve => {
        resolvePost = () => { resolve(result) }
      })
    })

    typeDraft(runtime, '旧草稿')
    fireEvent.click(await waitForSend(runtime))
    await waitFor(() => { expect(runtime.postMainMessage).toHaveBeenCalledTimes(1) })
    const input = runtime.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '新草稿' } })
    resolvePost()
    await waitForSend(runtime)
    expect(input.value).toBe('新草稿')

    fireEvent.click(runtime.view.getByRole('button', { name: '发送' }))
    await waitFor(() => { expect(runtime.postMainMessage).toHaveBeenCalledTimes(2) })
    const [oldRequest] = runtime.postMainMessage.mock.calls[0]!
    const [newRequest] = runtime.postMainMessage.mock.calls[1]!
    expect(newRequest.body).toBe('新草稿')
    expect(newRequest.requestId).not.toBe(oldRequest.requestId)
  })

  it('clears a confirmed Main draft before a failing refresh', async () => {
    const runtime = await openProject()
    expect(await runtime.view.findByText('主对话还没有内容')).toBeTruthy()
    await addFiles(runtime, [new File(['sent'], 'sent.png', { type: 'image/png' })])
    typeDraft(runtime, '已经提交')
    runtime.mainStreamHistory.mockRejectedValueOnce(new Error('refresh failed') as never)

    fireEvent.click(await waitForSend(runtime))
    expect((await runtime.view.findAllByText('refresh failed')).length).toBeGreaterThan(0)
    expect((runtime.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement).value).toBe('')
    expect(runtime.view.container.querySelectorAll('ul[aria-label="添加附件"] > li')).toHaveLength(0)
  })

  it('does not open the board for a superseded Task start', async () => {
    const runtime = await openProject()
    pressStartTask(runtime.view)
    const originalStart = runtime.startThread.getMockImplementation()!
    let resolveStart!: () => void
    runtime.startThread.mockImplementationOnce(async request => {
      const result = await originalStart(request)
      return new Promise<Awaited<ReturnType<typeof originalStart>>>(resolve => {
        resolveStart = () => { resolve(result) }
      })
    })

    typeDraft(runtime, '旧任务')
    fireEvent.click(await waitForSend(runtime))
    await waitFor(() => { expect(runtime.startThread).toHaveBeenCalledTimes(1) })
    const input = runtime.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '新任务草稿' } })
    resolveStart()
    await waitFor(() => { expect(input.readOnly).toBe(false) })

    expect(input.value).toBe('新任务草稿')
    expect(runtime.view.getByRole('heading', { name: '# engineering' })).toBeTruthy()
    expect(runtime.view.queryByRole('heading', { name: 'Task #1' })).toBeNull()
  })

  it('guards a rapid Thread submit and keeps an edit made while the reply is in flight', async () => {
    const runtime = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialProjects: true,
      seededMessages: [{ body: '开个任务', occurredAt: '2026-08-21T09:00:00.000Z' }],
    })
    fireEvent.click(await runtime.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await runtime.view.findByRole('button', { name: /^打开 Task #1：/ }))
    await runtime.view.findByRole('heading', { name: 'Task #1' })

    const originalReply = runtime.reply.getMockImplementation()!
    let resolveReply!: () => void
    runtime.reply.mockImplementationOnce(async request => {
      const result = await originalReply(request)
      return new Promise<Awaited<ReturnType<typeof originalReply>>>(resolve => {
        resolveReply = () => { resolve(result) }
      })
    })

    typeDraft(runtime, '旧回复')
    const send = await waitForSend(runtime)
    fireEvent.click(send)
    fireEvent.click(send)
    await waitFor(() => { expect(runtime.reply).toHaveBeenCalledTimes(1) })
    const input = runtime.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '新回复' } })
    resolveReply()
    await waitForSend(runtime)
    expect(input.value).toBe('新回复')

    fireEvent.click(runtime.view.getByRole('button', { name: '发送' }))
    await waitFor(() => { expect(runtime.reply).toHaveBeenCalledTimes(2) })
    const [oldRequest] = runtime.reply.mock.calls[0]!
    const [newRequest] = runtime.reply.mock.calls[1]!
    expect(newRequest.body).toBe('新回复')
    expect(newRequest.requestId).not.toBe(oldRequest.requestId)
  })
})
