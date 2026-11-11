import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamAttachmentId, AgentTeamGetAttachmentRequest, AgentTeamGetAttachmentResult } from '@contexera/dsh-agent-team/types'

/** Base64 one file payload in chunks so large uploads stay off the call-stack limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunk))
  }
  return btoa(binary)
}

/** The slot's Remote result union without importing the slots module. */
export type GetAttachment = (request: AgentTeamGetAttachmentRequest) => Promise<RemoteResult<AgentTeamGetAttachmentResult>>

export type AttachmentPreviewOutcome =
  | { readonly kind: 'ready'; readonly dataUrl: string }
  | { readonly kind: 'not-previewable' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed' }

/** Session-wide cache for usable bytes only. Missing and failed reads stay retryable. */
const dataUrlCache = new Map<AgentTeamAttachmentId, string>()
const inFlight = new Map<AgentTeamAttachmentId, Promise<AttachmentPreviewOutcome>>()

export function cachedAttachmentDataUrl(attachmentId: AgentTeamAttachmentId): string | undefined {
  return dataUrlCache.get(attachmentId)
}

export function invalidateAttachmentDataUrl(attachmentId: AgentTeamAttachmentId): void {
  dataUrlCache.delete(attachmentId)
}

async function readAttachmentPreview(getAttachment: GetAttachment, attachment: { attachmentId: AgentTeamAttachmentId; mediaType: string }): Promise<AttachmentPreviewOutcome> {
  const cached = dataUrlCache.get(attachment.attachmentId)
  if (cached !== undefined) return { kind: 'ready', dataUrl: cached }
  let result: RemoteResult<AgentTeamGetAttachmentResult>
  try {
    result = await getAttachment({ attachmentId: attachment.attachmentId })
  } catch {
    return { kind: 'failed' }
  }
  if (!result.ok) {
    return { kind: result.error.code === 'team/attachment-not-found' ? 'missing' : 'failed' }
  }
  if (!attachment.mediaType.startsWith('image/')) return { kind: 'not-previewable' }
  const dataUrl = `data:${attachment.mediaType};base64,${result.value.bytesBase64}`
  dataUrlCache.set(attachment.attachmentId, dataUrl)
  return { kind: 'ready', dataUrl }
}

export async function loadAttachmentPreview(getAttachment: GetAttachment, attachment: { attachmentId: AgentTeamAttachmentId; mediaType: string }): Promise<AttachmentPreviewOutcome> {
  const cached = dataUrlCache.get(attachment.attachmentId)
  if (cached !== undefined) return { kind: 'ready', dataUrl: cached }
  const pending = inFlight.get(attachment.attachmentId)
  if (pending !== undefined) return pending
  const request = readAttachmentPreview(getAttachment, attachment).finally(() => {
    inFlight.delete(attachment.attachmentId)
  })
  inFlight.set(attachment.attachmentId, request)
  return request
}

export function formatByteSize(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`
  if (byteSize < 1024 * 1024) return `${(byteSize / 1024).toFixed(0)} KB`
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`
}
