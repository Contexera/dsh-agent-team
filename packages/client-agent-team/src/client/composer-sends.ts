import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamAttachmentId,
  AgentTeamMemberId,
  AgentTeamMessageRef,
  AgentTeamPostMainMessageRequest,
  AgentTeamPutAttachmentRequest,
  AgentTeamPutAttachmentResult,
  AgentTeamReplyRequest,
  AgentTeamRequestId,
} from '@contexera/dsh-agent-team/types'
import type { TeamDraftKey, TeamDraftState, TeamDraftStore } from './drafts.ts'
import { isUncertainRemoteFailure, mintRequestId, uploadComposerFiles, type ComposerUpload } from './requests.ts'

type SubmissionFields = 'requestId' | 'attachments' | 'attachmentPaths'
export type ReplyAddress = Omit<AgentTeamReplyRequest, SubmissionFields>
export type ProjectSendMode = 'main' | 'discussion' | 'task'
/** The composer's quote banner, independent of whether the target is still in the loaded timeline. */
export interface ReplyTarget {
  /** Absent when the parent could not be resolved and cannot name an author. */
  readonly memberId?: AgentTeamMemberId
  readonly senderName: string
  readonly excerpt: string
}

/** The display snapshot travels with a Main send attempt; only `messageRef` reaches the Host. */
export interface ProjectReply extends ReplyTarget {
  readonly messageRef: AgentTeamMessageRef
}

export type ProjectAddress = Omit<AgentTeamPostMainMessageRequest, SubmissionFields | 'replyToMessageRef'> & {
  readonly mode: ProjectSendMode
  readonly replyTo?: ProjectReply
}

type SendAddress = { readonly workspaceId: AgentTeamPutAttachmentRequest['workspaceId'] }
type SendResult = { readonly kind: string }
type ComposerRequest<Address> = Address & { readonly requestId: AgentTeamRequestId; readonly attachments?: readonly AgentTeamAttachmentId[] }

interface SendTransport<Address, Result> {
  readonly submit: (request: ComposerRequest<Address>) => Promise<RemoteResult<Result>>
  readonly putAttachment: (request: AgentTeamPutAttachmentRequest) => Promise<RemoteResult<AgentTeamPutAttachmentResult>>
}

type SendOutcome<Result> =
  | { readonly kind: 'superseded' }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'answered'; readonly result: RemoteResult<Result>; readonly clearedDraft: boolean }

type SendSettlement<Result> = SendOutcome<Result> & { readonly uploads: readonly ComposerUpload[] }

interface SendAttempt<Address, Result> {
  readonly address: Address
  uploads: readonly ComposerUpload[]
  request?: ComposerRequest<Address>
  pending?: Promise<SendSettlement<Result>> | undefined
}

/** An attempt can outlive its composer, but never the Client or the draft that submitted it. */
export class ComposerSends<Address extends SendAddress, Result extends SendResult> {
  private attempts = new WeakMap<TeamDraftState, SendAttempt<Address, Result>>()

  constructor(private readonly drafts: Pick<TeamDraftStore, 'getSnapshot' | 'clear'>) {}

  restore(key: TeamDraftKey) {
    const attempt = this.attempts.get(this.drafts.getSnapshot(key))
    if (attempt !== undefined) return { address: attempt.address, uploads: attempt.uploads, pending: attempt.pending }
  }

  changeSelection(key: TeamDraftKey): void {
    this.attempts.delete(this.drafts.getSnapshot(key))
  }

  send(key: TeamDraftKey, address: Address, uploads: readonly ComposerUpload[], transport: SendTransport<Address, Result>): Promise<SendSettlement<Result>> {
    const snapshot = this.drafts.getSnapshot(key)
    let attempt = this.attempts.get(snapshot)
    if (attempt === undefined) {
      attempt = { address, uploads }
      this.attempts.set(snapshot, attempt)
    }
    return attempt.pending ??= this.settle(key, snapshot, attempt, transport).finally(() => { attempt.pending = undefined })
  }

  dispose(): void {
    this.attempts = new WeakMap()
  }

  private async settle(key: TeamDraftKey, snapshot: TeamDraftState, attempt: SendAttempt<Address, Result>, transport: SendTransport<Address, Result>): Promise<SendSettlement<Result>> {
    const ownsDraft = () => this.drafts.getSnapshot(key) === snapshot && this.attempts.get(snapshot) === attempt
    try {
      if (attempt.request === undefined) {
        const upload = await uploadComposerFiles(transport.putAttachment, attempt.address.workspaceId, attempt.uploads)
        attempt.uploads = upload.uploads
        if (!ownsDraft()) return { kind: 'superseded', uploads: attempt.uploads }
        if (!upload.ok) return { kind: 'failed', error: upload.error, uploads: attempt.uploads }
        attempt.request = {
          ...attempt.address, requestId: mintRequestId(),
          ...(upload.attachmentIds.length === 0 ? {} : { attachments: upload.attachmentIds }),
        }
      }

      const result = await transport.submit(attempt.request)
      const owns = ownsDraft()
      const committed = result.ok && result.value.kind === 'committed'
      if (this.attempts.get(snapshot) === attempt && (result.ok || !isUncertainRemoteFailure(result.error))) this.attempts.delete(snapshot)
      if (!owns && !committed) return { kind: 'superseded', uploads: attempt.uploads }
      const clearedDraft = owns && committed
      if (clearedDraft) this.drafts.clear(key)
      return { kind: 'answered', result, clearedDraft, uploads: attempt.uploads }
    } catch (cause) {
      if (!ownsDraft()) return { kind: 'superseded', uploads: attempt.uploads }
      return { kind: 'failed', error: cause instanceof Error ? cause.message : String(cause), uploads: attempt.uploads }
    }
  }
}
