import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamAttachmentId, AgentTeamGetAttachmentResult, AgentTeamGetAttachmentRequest } from '@contexera/dsh-agent-team/types'
import { cachedAttachmentDataUrl, loadAttachmentDataUrl, type GetAttachment } from '../src/client/attachment-preview.ts'

const attachment = (value: string, mediaType = 'image/png') => ({
  attachmentId: `attachment:${value}` as AgentTeamAttachmentId,
  mediaType,
})
const image: AgentTeamGetAttachmentResult = { name: 'design.png', mediaType: 'image/png', byteSize: 3, bytesBase64: 'cG5n' }

describe('attachment preview failure handling', () => {
  it('settles a gone entry on the stable code and never reaches the Host again', async () => {
    const target = attachment('gone')
    const get = vi.fn(async (_request: AgentTeamGetAttachmentRequest) => ({
      ok: false as const,
      error: new RemoteError('team/attachment-not-found', `attachment '${target.attachmentId}' is no longer cached`, { attachmentId: target.attachmentId }),
    }))
    await expect(loadAttachmentDataUrl(get, target)).resolves.toBeNull()
    expect(cachedAttachmentDataUrl(target.attachmentId)).toBeNull()
    await expect(loadAttachmentDataUrl(async () => { throw new Error('Host must not be called again') }, target)).resolves.toBeNull()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('keeps an unknown failure out of the cache so a later attempt can recover', async () => {
    const target = attachment('flaky')
    const get = vi.fn<GetAttachment>()
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'carrier hiccup (test seam)', {}) })
      .mockResolvedValueOnce({ ok: true, value: image })
    await expect(loadAttachmentDataUrl(get, target)).resolves.toBeNull()
    expect(cachedAttachmentDataUrl(target.attachmentId)).toBeUndefined()
    await expect(loadAttachmentDataUrl(get, target)).resolves.toBe('data:image/png;base64,cG5n')
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('still caches a successful preview and a non-image success', async () => {
    const picture = attachment('picture')
    const okGet = vi.fn<GetAttachment>().mockResolvedValue({ ok: true, value: image })
    await expect(loadAttachmentDataUrl(okGet, picture)).resolves.toBe('data:image/png;base64,cG5n')
    await expect(loadAttachmentDataUrl(okGet, picture)).resolves.toBe('data:image/png;base64,cG5n')
    expect(okGet).toHaveBeenCalledTimes(1)

    const document = attachment('document', 'application/pdf')
    await expect(loadAttachmentDataUrl(okGet, document)).resolves.toBeNull()
    expect(cachedAttachmentDataUrl(document.attachmentId)).toBeNull()
    expect(okGet).toHaveBeenCalledTimes(2)
  })
})
