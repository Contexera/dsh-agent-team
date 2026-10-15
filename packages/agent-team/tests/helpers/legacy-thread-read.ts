import type { AgentTeamThreadReadReceipt, AgentTeamThreadReadResult, AgentTeamThreadReadSnapshot } from '../../src/types.ts'

export function snapshotReadData(data: AgentTeamThreadReadReceipt, picture: Omit<AgentTeamThreadReadResult, 'receipt'>): AgentTeamThreadReadSnapshot {
  return {
    workspaceId: data.workspaceId,
    memberId: data.memberId,
    ...(picture.task === undefined ? {} : { task: picture.task }),
    thread: picture.thread,
    claims: picture.claims,
    anchor: picture.anchor,
    anchorMentions: picture.anchorMentions,
    facts: picture.facts,
    readThroughSequence: picture.readThroughSequence,
    remainingUnreadCount: picture.remainingUnreadCount,
    ...(picture.attention === undefined ? {} : { attention: picture.attention }),
    inbox: data.inbox,
  }
}

/**
 * The slim receipt the current code stores for the same read. Tests use it to
 * build the counterfactual ledger a pre-receipt installation would have written
 * had it never frozen a picture — same progress, same Inbox delta, no picture.
 */
export function receiptReadData(data: AgentTeamThreadReadSnapshot): AgentTeamThreadReadReceipt {
  return {
    workspaceId: data.workspaceId,
    memberId: data.memberId,
    threadRef: data.thread.threadRef,
    ...(data.task === undefined ? {} : { taskRef: data.task.taskRef }),
    readThroughSequence: data.readThroughSequence,
    inbox: data.inbox,
  }
}
