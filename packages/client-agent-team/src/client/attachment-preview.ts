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

/**
 * The slot's Remote result union without importing the slots module: an
 * expected failure arrives as a stable `code`, and any other error stays
 * unknown to this cache.
 */
export type GetAttachment = (request: AgentTeamGetAttachmentRequest) => Promise<RemoteResult<AgentTeamGetAttachmentResult>>

/**
 * Thumbnail data URLs live in one session-wide cache: message lists re-render
 * often, and each miss costs a Host round-trip plus a base64 decode. Only a
 * settled answer is cached: a gone entry resolves to `null` so the chip stays
 * on the expired label, while an unknown failure caches nothing and lets a
 * later mount retry the Host.
 */
const dataUrlCache = new Map<AgentTeamAttachmentId, string | null>()

export function cachedAttachmentDataUrl(attachmentId: AgentTeamAttachmentId): string | null | undefined {
  return dataUrlCache.get(attachmentId)
}

export async function loadAttachmentDataUrl(getAttachment: GetAttachment, attachment: { attachmentId: AgentTeamAttachmentId; mediaType: string }): Promise<string | null> {
  const cached = dataUrlCache.get(attachment.attachmentId)
  if (cached !== undefined) return cached
  const result = await getAttachment({ attachmentId: attachment.attachmentId })
  if (!result.ok) {
    // Discriminate by code, never by message: the stable not-found code is a
    // settled fact, everything else (carrier, Host, unknown future codes) is
    // transient from this cache's point of view.
    if (result.error.code === 'team/attachment-not-found') dataUrlCache.set(attachment.attachmentId, null)
    return null
  }
  const url = attachment.mediaType.startsWith('image/') ? `data:${attachment.mediaType};base64,${result.value.bytesBase64}` : null
  dataUrlCache.set(attachment.attachmentId, url)
  return url
}

/** Human-readable byte size for attachment chips. */
export function formatByteSize(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`
  if (byteSize < 1024 * 1024) return `${(byteSize / 1024).toFixed(0)} KB`
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`
}
