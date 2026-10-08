import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamAttachmentId, AgentTeamPutAttachmentRequest, AgentTeamPutAttachmentResult, AgentTeamRequestId,
} from '@contexera/dsh-agent-team/types'
import { bytesToBase64 } from './attachment-preview.ts'

/** Fresh idempotency identity for one Client-initiated durable request. */
export const mintRequestId = (): AgentTeamRequestId => crypto.randomUUID() as AgentTeamRequestId

/**
 * Upload composer files in order. One failure stops with the error text; the
 * caller keeps its chips so a retry uploads only the still-pending files.
 */
export const uploadComposerFiles = async (
  putAttachment: (request: AgentTeamPutAttachmentRequest) => Promise<RemoteResult<AgentTeamPutAttachmentResult>>,
  workspaceId: AgentTeamPutAttachmentRequest['workspaceId'],
  files: readonly File[],
): Promise<{ ok: true; attachmentIds: readonly AgentTeamAttachmentId[] } | { ok: false; error: string }> => {
  const attachmentIds: AgentTeamAttachmentId[] = []
  for (const file of files) {
    const uploaded = await putAttachment({
      requestId: mintRequestId(), workspaceId,
      name: file.name,
      mediaType: file.type === '' ? undefined : file.type,
      bytesBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    })
    if (!uploaded.ok) return { ok: false, error: uploaded.error.message }
    attachmentIds.push(uploaded.value.attachmentId)
  }
  return { ok: true, attachmentIds }
}
