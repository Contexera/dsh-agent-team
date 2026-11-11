import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamAttachmentId, AgentTeamGetAttachmentResult } from '@contexera/dsh-agent-team/types'
import { cachedAttachmentDataUrl, invalidateAttachmentDataUrl, loadAttachmentPreview, type GetAttachment } from '../src/client/attachment-preview.ts'

const attachment = (value: string, mediaType = 'image/png') => ({
  attachmentId: `attachment:${value}` as AgentTeamAttachmentId,
  mediaType,
})
const image: AgentTeamGetAttachmentResult = { name: 'design.png', mediaType: 'image/png', byteSize: 3, bytesBase64: 'cG5n' }

describe('attachment preview outcomes', () => {
  it('reports a confirmed miss without preventing the same id from being read again', async () => {
    const target = attachment('missing-retry')
    const get = vi.fn<GetAttachment>()
      .mockResolvedValueOnce({
        ok: false,
        error: new RemoteError('team/attachment-not-found', `attachment '${target.attachmentId}' is no longer cached`, { attachmentId: target.attachmentId }),
      })
      .mockResolvedValueOnce({ ok: true, value: image })

    await expect(loadAttachmentPreview(get, target)).resolves.toEqual({ kind: 'missing' })
    expect(cachedAttachmentDataUrl(target.attachmentId)).toBeUndefined()
    await expect(loadAttachmentPreview(get, target)).resolves.toEqual({ kind: 'ready', dataUrl: 'data:image/png;base64,cG5n' })
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('keeps a general Remote failure retryable', async () => {
    const target = attachment('remote-failure')
    const get = vi.fn<GetAttachment>()
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'carrier hiccup (test seam)', {}) })
      .mockResolvedValueOnce({ ok: true, value: image })

    await expect(loadAttachmentPreview(get, target)).resolves.toEqual({ kind: 'failed' })
    expect(cachedAttachmentDataUrl(target.attachmentId)).toBeUndefined()
    await expect(loadAttachmentPreview(get, target)).resolves.toEqual({ kind: 'ready', dataUrl: 'data:image/png;base64,cG5n' })
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('turns a thrown read into a retryable failure', async () => {
    const target = attachment('thrown-read')
    const get = vi.fn<GetAttachment>()
      .mockRejectedValueOnce(new Error('read threw (test seam)'))
      .mockResolvedValueOnce({ ok: true, value: image })

    await expect(loadAttachmentPreview(get, target)).resolves.toEqual({ kind: 'failed' })
    await expect(loadAttachmentPreview(get, target)).resolves.toEqual({ kind: 'ready', dataUrl: 'data:image/png;base64,cG5n' })
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('caches usable image bytes and can invalidate a failed browser decode', async () => {
    const target = attachment('decode-invalidation')
    const get = vi.fn<GetAttachment>().mockResolvedValue({ ok: true, value: image })

    await expect(loadAttachmentPreview(get, target)).resolves.toEqual({ kind: 'ready', dataUrl: 'data:image/png;base64,cG5n' })
    await expect(loadAttachmentPreview(get, target)).resolves.toEqual({ kind: 'ready', dataUrl: 'data:image/png;base64,cG5n' })
    expect(get).toHaveBeenCalledTimes(1)

    invalidateAttachmentDataUrl(target.attachmentId)
    expect(cachedAttachmentDataUrl(target.attachmentId)).toBeUndefined()
    await expect(loadAttachmentPreview(get, target)).resolves.toEqual({ kind: 'ready', dataUrl: 'data:image/png;base64,cG5n' })
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('does not cache a successful response that has no image preview', async () => {
    const target = attachment('document', 'application/pdf')
    const get = vi.fn<GetAttachment>().mockResolvedValue({ ok: true, value: { ...image, name: 'spec.pdf', mediaType: 'application/pdf' } })

    await expect(loadAttachmentPreview(get, target)).resolves.toEqual({ kind: 'not-previewable' })
    expect(cachedAttachmentDataUrl(target.attachmentId)).toBeUndefined()
    await expect(loadAttachmentPreview(get, target)).resolves.toEqual({ kind: 'not-previewable' })
    expect(get).toHaveBeenCalledTimes(2)
  })
})
