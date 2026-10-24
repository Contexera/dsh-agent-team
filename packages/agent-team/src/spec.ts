import { z } from 'zod'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { AgentTeamMemberCapabilities, AgentTeamModelSelection } from './types.ts'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {
  AgentTeamActivityRef,
  AgentTeamAttachmentId,
  AgentTeamProjectRef,
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
const sessionLogOffsetSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(value => value as SessionLogOffset)
const contextCheckpointRefSchema = z.string().regex(/^(context-checkpoint-[0-9a-f]{64}|team-boundary-[0-9a-f]{64})$/).transform(value => value as AgentTeamContextCheckpointRef)
const projectRefSchema = z.string().regex(/^(project|channel):[^:]+$/).transform(value => value.replace(/^channel:/, 'project:') as AgentTeamProjectRef)
const messageRefSchema = z.string().regex(/^message:[^:]+$/).transform(value => value as AgentTeamMessageRef)
const taskRefSchema = z.string().regex(/^task:[^:]+$/).transform(value => value as AgentTeamTaskRef)
const threadRefSchema = z.string().regex(/^thread:[^:]+$/).transform(value => value as AgentTeamThreadRef)
const claimRefSchema = z.string().regex(/^claim:[^:]+$/).transform(value => value as AgentTeamClaimRef)
const activityRefSchema = z.string().regex(/^activity:[^:]+$/).transform(value => value as AgentTeamActivityRef)
const attachmentIdSchema = z.string().min(1).transform(value => value as AgentTeamAttachmentId)

const actorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), memberId: memberIdSchema, handle: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('member'), memberId: memberIdSchema, handle: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('host'), handle: z.literal('agent-team') }).strict(),
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

// Allow-list entries are plain strings, never validated against known names here: committing must survive Harness upgrades that rename or remove tools, so divergence is derived at activation (see AgentTeamCapabilityWarning).
const memberCapabilitiesSchema = z.object({
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

const projectSchema = z.object({
  projectRef: projectRefSchema,
  workspaceId: workspaceIdSchema,
  name: z.string().min(1),
  description: z.string(),
  createdAtSequence: z.number().int().positive(),
  // Ledgers written before Project archival existed omit the field.
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
  projectRef: projectRefSchema,
  threadRef: threadRefSchema,
  taskRef: taskRefSchema.optional(),
  sender: memberIdSchema,
  body: z.string().min(1),
  attachments: z.array(attachmentSchema).optional(),
  /**
   * The Message this one answers, when it is a reply.
   *
   * Records are parsed strictly at every open, so a durable field the write path stores but this schema omits makes the whole domain fail to reopen; add durable fields here in the same change.
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
  if (operation.kind === 'team/thread-started') {
    return { ...operation, data: { ...operation.data, anchor: stampMessage(operation.occurredAt, operation.data.anchor) } } as AgentTeamOperation
  }
  return operation as AgentTeamOperation
}

const taskSchema = z.object({
  taskRef: taskRefSchema,
  projectRef: projectRefSchema,
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

const mainMessageSchema = z.object({
  messageRef: messageRefSchema,
  projectRef: projectRefSchema,
  scope: z.literal('main'),
  sender: memberIdSchema,
  body: z.string().min(1),
  attachments: z.array(attachmentSchema).optional(),
  replyToMessageRef: messageRefSchema.optional(),
  sequence: z.number().int().positive(),
  occurredAt: z.string().datetime(),
}).strict().transform(omitUndefined)

const mainActivitySchema = z.object({
  activityRef: activityRefSchema,
  projectRef: projectRefSchema,
  kind: z.union([z.literal('owner-added'), z.literal('owner-removed')]),
  memberId: memberIdSchema,
  actor: memberIdSchema,
  sequence: z.number().int().positive(),
  occurredAt: z.string().datetime(),
}).strict()

const mainMarkerSchema = z.union([
  z.object({ memberId: memberIdSchema, projectRef: projectRefSchema, messageRef: messageRefSchema, sequence: z.number().int().positive() }).strict(),
  z.object({ memberId: memberIdSchema, projectRef: projectRefSchema, activityRef: activityRefSchema, sequence: z.number().int().positive() }).strict(),
])

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
  mainMarkers: z.object({
    added: z.array(mainMarkerSchema),
    removed: z.array(mainMarkerSchema),
  }).strict().optional(),
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

/** Departure facts a releasing operation persists. Every release kind carries this snapshot once here, so a new kind cannot drop or invent a field. */
const releaseSnapshotSchema = {
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

/** Pre-receipt Thread-read snapshot, still accepted so older ledgers open; both shapes are strict, so a record parses as exactly one. */
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
    kind: z.literal('team/project-created'),
    data: z.object({
      workspaceId: workspaceIdSchema,
      project: projectSchema,
      memberIds: z.array(memberIdSchema),
    }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/member-added'),
    data: z.object({ member: memberSchema, projectRefs: z.array(projectRefSchema) }).strict(),
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
      ...releaseSnapshotSchema,
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
    kind: z.literal('team/member-session-recycled'),
    data: z.object({
      member: memberSchema,
      previousSessionId: sessionIdSchema,
      newSessionId: sessionIdSchema,
      inputFromSeq: sessionLogOffsetSchema.optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/rules-version-adopted'),
    data: z.object({ version: z.number().int().min(2) }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/project-owner-added'),
    data: z.object({ workspaceId: workspaceIdSchema, projectRef: projectRefSchema, memberId: memberIdSchema,
      activity: mainActivitySchema, inbox: inboxDeltaSchema }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/project-owner-removed'),
    data: z.object({ workspaceId: workspaceIdSchema, projectRef: projectRefSchema, memberId: memberIdSchema,
      activity: mainActivitySchema, inbox: inboxDeltaSchema }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/project-updated'),
    data: z.object({ workspaceId: workspaceIdSchema, project: projectSchema }).strict(),
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
    kind: z.literal('team/project-member-added'),
    data: z.object({ workspaceId: workspaceIdSchema, projectRef: projectRefSchema, memberId: memberIdSchema }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/project-member-removed'),
    data: z.object({
      workspaceId: workspaceIdSchema,
      projectRef: projectRefSchema,
      memberId: memberIdSchema,
      ...releaseSnapshotSchema,
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
      ...releaseSnapshotSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/project-archived'),
    data: z.object({
      workspaceId: workspaceIdSchema,
      project: projectSchema,
      ...releaseSnapshotSchema,
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
    kind: z.literal('team/main-message-posted'),
    data: z.object({
      workspaceId: workspaceIdSchema,
      mentions: z.array(memberIdSchema),
      message: mainMessageSchema,
      inbox: inboxDeltaSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/main-stream-read'),
    data: z.object({
      workspaceId: workspaceIdSchema,
      projectRef: projectRefSchema,
      memberId: memberIdSchema,
      readThroughSequence: z.number().int().nonnegative(),
      inbox: inboxDeltaSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...operationBase,
    previousOperationId: operationIdSchema.nullable(),
    kind: z.literal('team/thread-started'),
    data: z.object({
      workspaceId: workspaceIdSchema,
      projectRef: projectRefSchema,
      kind: z.union([z.literal('discussion'), z.literal('task')]),
      mentions: z.array(memberIdSchema),
      anchor: messageSchema,
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
      ...releaseSnapshotSchema,
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

/**
 * Project was called Channel before, and stored bytes are never rewritten, so a record may carry either spelling.
 * Both decode to the Project form. Only the top-level kind and the renamed keys change here (refs normalize in
 * `projectRefSchema`); message bodies pass through, and the Channel refs they cite still resolve.
 */
const channelSpellingKinds: ReadonlyMap<string, string> = new Map([
  ['team/channel-created', 'team/project-created'],
  ['team/channel-updated', 'team/project-updated'],
  ['team/channel-archived', 'team/project-archived'],
  ['team/channel-member-added', 'team/project-member-added'],
  ['team/channel-member-removed', 'team/project-member-removed'],
])
const channelSpellingKeys: ReadonlyMap<string, string> = new Map([
  ['channel', 'project'],
  ['channelRef', 'projectRef'],
  ['channelRefs', 'projectRefs'],
])

function projectSpellingKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectSpellingKeys)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => {
    const renamed = channelSpellingKeys.get(key)
    // An object holding both spellings keeps the Channel key, which the strict schema then rejects.
    return [renamed === undefined || Object.hasOwn(record, renamed) ? key : renamed, projectSpellingKeys(entry)]
  }))
}

function projectSpelling(stored: unknown): unknown {
  const renamed = projectSpellingKeys(stored)
  if (renamed === null || typeof renamed !== 'object' || Array.isArray(renamed)) return renamed
  const { kind } = renamed as { kind?: unknown }
  const projectKind = typeof kind === 'string' ? channelSpellingKinds.get(kind) : undefined
  return projectKind === undefined ? renamed : { ...renamed, kind: projectKind }
}

/** Durable validator for the closed Agent Team operation union; ledgers written before message occurredAt existed normalize on load. */
export const agentTeamOperationSchema: z.ZodType<AgentTeamOperation> = z.preprocess(projectSpelling, storedAgentTeamOperationSchema).transform(stampOperationMessages)

/** Versioned durable declaration. The version moves only when a stored record would mean something different: there is no migration, so a bump breaks every existing ledger. Additive operation kinds stay at v1. */
export const agentTeamDomainSpec = defineDomain({
  name: 'agent_team',
  version: 1,
  tables: {
    operations: domainTable<AgentTeamOperationId, AgentTeamOperation>(agentTeamOperationSchema),
  },
})
