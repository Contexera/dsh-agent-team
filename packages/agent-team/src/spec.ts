import { z } from 'zod'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { AgentTeamMemberCapabilities, AgentTeamModelSelection } from './types.ts'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {
  AgentTeamActivityRef,
  AgentTeamAttachmentId,
  AgentTeamChannelRef,
  AgentTeamClaimRef,
  AgentTeamContextCheckpointRef,
  AgentTeamMemberId,
  AgentTeamMessageRef,
  AgentTeamOperation,
  AgentTeamOperationId,
  AgentTeamRequestId,
  AgentTeamTaskRef,
  AgentTeamThreadRef,
} from './types.ts'

const operationIdSchema = z.string().regex(/^operation:[^:]+$/).transform(value => value as AgentTeamOperationId)
const requestIdSchema = z.string().min(1).transform(value => value as AgentTeamRequestId)
const memberIdSchema = z.string().regex(/^member:[^:]+$/).transform(value => value as AgentTeamMemberId)
const workspaceIdSchema = z.string().min(1).transform(value => value as WorkspaceId)
const sessionIdSchema = z.string().min(1).transform(value => value as SessionId)
const sessionSeqSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(value => value as SessionSeq)
const contextCheckpointRefSchema = z.string().regex(/^(context-checkpoint-[0-9a-f]{64}|team-boundary-[0-9a-f]{64})$/).transform(value => value as AgentTeamContextCheckpointRef)
const channelRefSchema = z.string().regex(/^channel:[^:]+$/).transform(value => value as AgentTeamChannelRef)
const messageRefSchema = z.string().regex(/^message:[^:]+$/).transform(value => value as AgentTeamMessageRef)
const taskRefSchema = z.string().regex(/^task:[^:]+$/).transform(value => value as AgentTeamTaskRef)
const threadRefSchema = z.string().regex(/^thread:[^:]+$/).transform(value => value as AgentTeamThreadRef)
const claimRefSchema = z.string().regex(/^claim:[^:]+$/).transform(value => value as AgentTeamClaimRef)
const activityRefSchema = z.string().regex(/^activity:[^:]+$/).transform(value => value as AgentTeamActivityRef)
const attachmentIdSchema = z.string().min(1).transform(value => value as AgentTeamAttachmentId)

const actorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), memberId: memberIdSchema, handle: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('member'), memberId: memberIdSchema, handle: z.string().min(1) }).strict(),
])

const operationBase = {
  sequence: z.number().int().positive(),
  operationId: operationIdSchema,
  requestId: requestIdSchema,
  occurredAt: z.string().datetime(),
  actor: actorSchema,
}

const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).transform(value => value as ReasoningEffortId).optional(),
}).strict().transform(({ provider, model, reasoningEffort }): AgentTeamModelSelection => ({
  provider,
  model,
  ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
}))

// Pure intent: allow-list entries are plain strings. They are never
// validated against a known-name set here — committing must survive Harness
// upgrades that rename or remove tools, so divergence is derived at
// activation instead (see AgentTeamCapabilityWarning).
const memberCapabilitiesSchema = z.object({
  // Deliberate interface reservation, no UI writes it today: Runtime Revision
  // manifests depend on this seam — do not remove during cleanup.
  tools: z.object({ allow: z.array(z.string().min(1)) }).strict().transform(omitUndefined).optional(),
  skills: z.object({ allow: z.array(z.string().min(1)) }).strict().transform(omitUndefined).optional(),
}).strict().transform(({ tools, skills }): AgentTeamMemberCapabilities => ({
  ...(tools === undefined ? {} : { tools }),
  ...(skills === undefined ? {} : { skills }),
}))

const memberSchema = z.object({
  memberId: memberIdSchema,
  sessionId: sessionIdSchema,
  workspaceId: workspaceIdSchema,
  handle: z.string().min(1),
  description: z.string(),
  presetId: z.string().min(1),
  // Ledgers written before per-Member model selection existed omit the field.
  model: modelSelectionSchema.optional(),
  // Ledgers written before member capabilities existed omit the field.
  capabilities: memberCapabilitiesSchema.optional(),
  privateMemoryPath: z.string().min(1),
  state: z.union([z.literal('enabled'), z.literal('suspended'), z.literal('inactive'), z.literal('archived')]),
}).strict()

const channelSchema = z.object({
  channelRef: channelRefSchema,
  workspaceId: workspaceIdSchema,
  name: z.string().min(1),
  description: z.string(),
  createdAtSequence: z.number().int().positive(),
  // Ledgers written before Channel archival existed omit the field.
  state: z.enum(['active', 'archived']).default('active'),
}).strict()

// Ledgers written before message occurredAt or attachments existed store bare
// messages; the union schema below stamps occurredAt on load and leaves absent
// attachment metadata undefined, so old ledgers replay unchanged.
const attachmentSchema = z.object({
  attachmentId: attachmentIdSchema,
  name: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
}).strict()
function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}

const messageSchema = z.object({
  messageRef: messageRefSchema,
  channelRef: channelRefSchema,
  threadRef: threadRefSchema,
  taskRef: taskRefSchema.optional(),
  sender: memberIdSchema,
  body: z.string().min(1),
  attachments: z.array(attachmentSchema).optional(),
  /**
   * The Message this one answers, when it is a reply.
   *
   * Durable records are parsed strictly at every open, so a field the write
   * path stores and this schema does not name makes the whole domain fail to
   * reopen — the record is on disk, and every later mount dies on it. Adding a
   * durable field therefore means adding it here in the same change.
   */
  replyToMessageRef: messageRefSchema.optional(),
  topLevel: z.boolean(),
  sequence: z.number().int().positive(),
  occurredAt: z.string().datetime().optional(),
}).strict().transform(omitUndefined)

type StoredMessage = z.output<typeof messageSchema>

/** Stamp one bare stored message with the wrapping operation's occurrence instant; complete messages pass through unchanged. */
function stampMessage(occurredAt: string, message: StoredMessage): Omit<StoredMessage, 'occurredAt'> & { occurredAt: string } {
  const { occurredAt: stored } = message
  return stored === undefined ? { ...message, occurredAt } : { ...message, occurredAt: stored }
}

/** Stamp every bare stored message that carries its instant inside the same operation; Thread reads resolve cross-operation instants in the ledger. */
function stampOperationMessages(operation: z.output<typeof storedAgentTeamOperationSchema>): AgentTeamOperation {
  if (operation.kind === 'team/message-sent') {
    return { ...operation, data: { ...operation.data, message: stampMessage(operation.occurredAt, operation.data.message) } } as AgentTeamOperation
  }
  if (operation.kind === 'team/thread-replied') {
    return { ...operation, data: { ...operation.data, message: stampMessage(operation.occurredAt, operation.data.message) } } as AgentTeamOperation
  }
  return operation as AgentTeamOperation
}

const taskSchema = z.object({
  taskRef: taskRefSchema,
  channelRef: channelRefSchema,
  threadRef: threadRefSchema,
  status: z.union([z.literal('todo'), z.literal('in_progress'), z.literal('in_review'), z.literal('done'), z.literal('closed')]),
  resolution: z.union([z.literal('open'), z.literal('accepted'), z.literal('closed')]),
}).strict()

const threadSchema = z.object({
  threadRef: threadRefSchema,
  taskRef: taskRefSchema.optional(),
  revision: z.number().int().positive(),
}).strict().transform(omitUndefined)

const attentionSchema = z.object({
  memberId: memberIdSchema,
  threadRef: threadRefSchema,
  startSequence: z.number().int().positive(),
  readThroughSequence: z.number().int().nonnegative(),
}).strict()

const attentionKeySchema = z.object({
  memberId: memberIdSchema,
  threadRef: threadRefSchema,
}).strict()

const directMarkerSchema = z.object({
  memberId: memberIdSchema,
  threadRef: threadRefSchema,
  messageRef: messageRefSchema,
  sequence: z.number().int().positive(),
}).strict()

const activityMarkerSchema = z.object({
  memberId: memberIdSchema,
  threadRef: threadRefSchema,
  activityRef: activityRefSchema,
  sequence: z.number().int().positive(),
}).strict()

const inboxDeltaSchema = z.object({
  attention: z.object({
    set: z.array(attentionSchema),
    removed: z.array(attentionKeySchema),
  }).strict(),
  directMarkers: z.object({
    added: z.array(directMarkerSchema),
    removed: z.array(directMarkerSchema),
  }).strict(),
  activityMarkers: z.object({
    added: z.array(activityMarkerSchema),
    removed: z.array(activityMarkerSchema),
  }).strict(),
}).strict()

const claimSchema = z.object({
  claimRef: claimRefSchema,
  taskRef: taskRefSchema,
  threadRef: threadRefSchema,
  owner: memberIdSchema,
  direction: z.string().min(1),
  normalizedDirection: z.string().min(1),
  state: z.union([z.literal('active'), z.literal('done'), z.literal('released')]),
}).strict()

const activityBase = {
  activityRef: activityRefSchema,
  taskRef: taskRefSchema,
  threadRef: threadRefSchema,
  actor: memberIdSchema,
  sequence: z.number().int().positive(),
}

const claimActivitySchema = z.object({
  ...activityBase,
  kind: z.union([z.literal('claim'), z.literal('done'), z.literal('release')]),
  claimRef: claimRefSchema,
}).strict()

const taskActivitySchema = z.object({
  ...activityBase,
  kind: z.union([z.literal('promote'), z.literal('accept'), z.literal('close'), z.literal('reopen')]),
  releasedClaimRefs: z.array(claimRefSchema).min(1).optional(),
  completedClaimRefs: z.array(claimRefSchema).min(1).optional(),
  acceptedClaimRefs: z.array(claimRefSchema).optional(),
}).strict()

const claimsReleasedActivitySchema = z.object({
  ...activityBase,
  kind: z.literal('claims_released'),
  claimRefs: z.array(claimRefSchema).min(1),
}).strict()

const activitySchema = z.discriminatedUnion('kind', [claimActivitySchema, taskActivitySchema, claimsReleasedActivitySchema])

const threadFactSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), sequence: z.number().int().positive(), message: messageSchema,
    mentions: z.array(memberIdSchema), occurredAt: z.string().datetime().optional() }).strict(),
  z.object({ kind: z.literal('activity'), sequence: z.number().int().positive(), activity: activitySchema,
    occurredAt: z.string().datetime().optional() }).strict(),
])

const readFactSchema = z.object({
  fact: threadFactSchema,
  unread: z.boolean(),
  direct: z.boolean(),
}).strict()

const claimOperation = (kind: 'team/claim-created' | 'team/claim-done' | 'team/claim-released') => z.object({
  ...operationBase,
  previousOperationId: operationIdSchema.nullable(),
  kind: z.literal(kind),
  data: z.object({
    workspaceId: workspaceIdSchema,
    baseRevision: z.number().int().positive(),
    activity: claimActivitySchema,
    claim: claimSchema,
    task: taskSchema,
    thread: threadSchema,
    inbox: inboxDeltaSchema,
  }).strict(),
}).strict()

/**
 * The five departure-fact collections a releasing operation persists. All four
 * release kinds carry this snapshot under their own `kind` literal and their own
 * identifying fields; the durable half that must stay identical lives here once,
 * so a new release kind cannot silently drop or invent a field.
 */
const releaseSnapshotFields = {
  claims: z.array(claimSchema),
  activities: z.array(claimsReleasedActivitySchema),
  tasks: z.array(taskSchema),
  threads: z.array(threadSchema),
  inbox: inboxDeltaSchema,
}

/** The receipt form every new read writes: the progress it made and the Inbox delta it consumed. */
const threadReadReceiptDataSchema = z.object({
  workspaceId: workspaceIdSchema,
  memberId: memberIdSchema,
  threadRef: threadRefSchema,
  taskRef: taskRefSchema.optional(),
  readThroughSequence: z.number().int().nonnegative(),
  inbox: inboxDeltaSchema,
}).strict().transform(omitUndefined)

/**
 * The pre-receipt Thread-read snapshot. Still accepted so a ledger written
 * before the receipt form keeps opening; both shapes are strict, so a stored
 * record parses as exactly one of them.
 */
const threadReadSnapshotDataSchema = z.object({
  workspaceId: workspaceIdSchema,
  memberId: memberIdSchema,
  task: taskSchema.optional(),
  thread: threadSchema,
  claims: z.array(claimSchema),
  anchor: messageSchema,
  anchorMentions: z.array(memberIdSchema),
  facts: z.array(readFactSchema),
  readThroughSequence: z.number().int().nonnegative(),
  remainingUnreadCount: z.number().int().nonnegative(),
  earlierFactCount: z.number().int().nonnegative().optional(),
  attention: attentionSchema.optional(),
  inbox: inboxDeltaSchema,
}).strict().transform(omitUndefined)

/** Closed Agent Team operation union before occurrence stamping. */
const storedAgentTeamOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    ...operationBase,
    previousOperationId: z.null(),
    kind: z.literal('team/initialized'),
    data: z.object({ humanMemberId: memberIdSchema }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/channel-created'),
    data: z.object({
      workspaceId: workspaceIdSchema,
      channel: channelSchema,
      memberIds: z.array(memberIdSchema),
    }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/member-added'),
    data: z.object({ member: memberSchema, channelRefs: z.array(channelRefSchema) }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/member-suspended'),
    data: z.object({ member: memberSchema }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/member-resumed'),
    data: z.object({ member: memberSchema }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/member-archived'),
    data: z.object({
      member: memberSchema,
      ...releaseSnapshotFields,
    }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/member-session-restarted'),
    data: z.object({ member: memberSchema }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/member-context-cleared'),
    data: z.object({ member: memberSchema }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/member-session-renewed'),
    data: z.object({ member: memberSchema, previousSessionId: sessionIdSchema }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/member-session-rolled-over'),
    data: z.object({
      member: memberSchema,
      previousSessionId: sessionIdSchema,
      newSessionId: sessionIdSchema,
      sourceSessionId: sessionIdSchema.optional(),
      sourceThroughSeq: sessionSeqSchema.optional(),
      handoffEventSeq: sessionSeqSchema,
      checkpointRef: contextCheckpointRefSchema.optional(),
      trigger: z.enum(['model', 'pressure']),
    }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/channel-updated'),
    data: z.object({ workspaceId: workspaceIdSchema, channel: channelSchema }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/member-updated'),
    data: z.object({ member: memberSchema }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/channel-member-added'),
    data: z.object({ workspaceId: workspaceIdSchema, channelRef: channelRefSchema, memberId: memberIdSchema }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/channel-member-removed'),
    data: z.object({
      workspaceId: workspaceIdSchema,
      channelRef: channelRefSchema,
      memberId: memberIdSchema,
      ...releaseSnapshotFields,
    }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/member-workspace-joined'),
    data: z.object({
      workspaceId: workspaceIdSchema,
      memberId: memberIdSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/member-workspace-left'),
    data: z.object({
      workspaceId: workspaceIdSchema,
      memberId: memberIdSchema,
      ...releaseSnapshotFields,
    }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/channel-archived'),
    data: z.object({
      workspaceId: workspaceIdSchema,
      channel: channelSchema,
      ...releaseSnapshotFields,
    }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/message-sent'),
    data: z.object({
      workspaceId: workspaceIdSchema,
      mentions: z.array(memberIdSchema),
      message: messageSchema,
      task: taskSchema.optional(),
      thread: threadSchema,
      inbox: inboxDeltaSchema,
    }).strict().transform(omitUndefined),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/thread-replied'),
    data: z.object({
      workspaceId: workspaceIdSchema,
      baseRevision: z.number().int().positive(),
      mentions: z.array(memberIdSchema),
      message: messageSchema,
      task: taskSchema.optional(),
      thread: threadSchema,
      inbox: inboxDeltaSchema,
    }).strict().transform(omitUndefined),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/thread-promoted'),
    data: z.object({
      workspaceId: workspaceIdSchema,
      baseRevision: z.number().int().positive(),
      activity: taskActivitySchema,
      task: taskSchema,
      thread: threadSchema,
      inbox: inboxDeltaSchema,
    }).strict(),
  }).strict(),
  claimOperation('team/claim-created'),
  claimOperation('team/claim-done'),
  claimOperation('team/claim-released'),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/task-changed'),
    data: z.object({
      workspaceId: workspaceIdSchema,
      baseRevision: z.number().int().positive(),
      activity: taskActivitySchema,
      task: taskSchema,
      thread: threadSchema,
      claims: z.array(claimSchema),
      inbox: inboxDeltaSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/thread-attention-changed'),
    data: z.object({
      workspaceId: workspaceIdSchema,
      action: z.union([z.literal('follow'), z.literal('unfollow')]),
      memberId: memberIdSchema,
      task: taskSchema.optional(),
      thread: threadSchema,
      inbox: inboxDeltaSchema,
    }).strict().transform(omitUndefined),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/thread-read'),
    data: z.union([threadReadReceiptDataSchema, threadReadSnapshotDataSchema]),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/member-removed'),
    data: z.object({
      member: memberSchema,
      ...releaseSnapshotFields,
    }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/dm-sent'),
    data: z.object({
      workspaceId: workspaceIdSchema,
      senderMemberId: memberIdSchema,
      recipientMemberId: memberIdSchema,
      body: z.string().min(1),
    }).strict(),
  }).strict(),
])

/** Durable validator for the closed Agent Team operation union; ledgers written before message occurredAt existed normalize on load. */
export const agentTeamOperationSchema: z.ZodType<AgentTeamOperation> = storedAgentTeamOperationSchema.transform(stampOperationMessages)

/** Versioned durable Agent Team declaration; v1 is the first public ledger format and older local media reject at open. */
export const agentTeamDomainSpec = defineDomain({
  name: 'agent_team',
  version: 1,
  tables: {
    operations: domainTable<AgentTeamOperationId, AgentTeamOperation>(agentTeamOperationSchema),
  },
})
