import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamMemberId,
  AgentTeamRequestId,
  AgentTeamTask,
  AgentTeamTaskRef,
  AgentTeamThreadAttentionRequest,
  AgentTeamThreadAttentionResult,
  AgentTeamThreadObservations,
  AgentTeamThreadObservationsRequest,
  AgentTeamThreadRef,
  AgentTeamTransferTaskCommittedResult,
  AgentTeamTransferTaskRequest,
  AgentTeamTransferTaskResult,
} from '@contexera/dsh-agent-team/types'
import { mintRequestId } from './requests.ts'

/** One Human Attention write, answered by the Host's own projection of the Thread's current followers. */
export type AttentionWrite = (request: AgentTeamThreadAttentionRequest) => Promise<RemoteResult<AgentTeamThreadAttentionResult>>
export type AttentionObservation = (request: AgentTeamThreadObservationsRequest) => Promise<RemoteResult<AgentTeamThreadObservations>>

/**
 * Whether one Member follows a Thread, asked of the Host's whole follower set.
 *
 * The set holds every Member whose Attention is on the Thread, so "does the Human follow?" is a question about the
 * Human's own id rather than about the set's size: a set holding other Members is not a followed Thread for this
 * reader. An id that has not been projected yet leaves the question unanswered — `undefined` — because guessing an
 * id would let another Member's Attention be read as the Human's.
 */
function followsIn(followers: readonly AgentTeamMemberId[] | ReadonlySet<AgentTeamMemberId>, humanMemberId: AgentTeamMemberId | undefined): boolean | undefined {
  if (humanMemberId === undefined) return undefined
  return (followers instanceof Set ? followers : new Set(followers)).has(humanMemberId)
}

export interface ThreadFollowState {
  /** Whether the Human follows this Thread right now; undefined until the Host has answered. */
  readonly following: boolean | undefined
  readonly pending: boolean
  readonly error: string | undefined
  /** Write one follow or unfollow; the Host's answer is the only authority on what happened. */
  readonly toggle: (action: 'follow' | 'unfollow') => Promise<void>
}

/**
 * The Human's follow state for one Thread, read from the Host's Attention observation and written through the Human
 * Remote. Both faces that can open a Thread share this hook, so the control's display rule — the Host's current
 * observation, never an optimistic guess — and its recovery on failure live in one place.
 *
 * The observation is the Thread's whole follower set: every Member whose Attention is on it, not the Human's row
 * alone. The Human's standing is therefore that set *asked about the Human's own id*, which is why the caller hands
 * the id in rather than the hook assuming one: the Host projects it, and a set that holds other Members must read as
 * not following just as an empty one does.
 *
 * A write never optimistically flips the state: the button shows what the Host last answered, so a refused or failed
 * write leaves the previous standing on screen instead of a claim the next read would contradict.
 */
export function useThreadFollow(
  changeAttention: AttentionWrite,
  threadObservations: AttentionObservation,
  request: { readonly workspaceId: WorkspaceId; readonly threadRef?: AgentTeamThreadRef; readonly taskRef?: AgentTeamTaskRef },
  /** The observation a face has already read on mount, so the control starts from the answer that read landed instead of asking again. */
  observed?: ReadonlySet<AgentTeamMemberId> | undefined,
  /** The Human's own Member id, from the Host's projection; undefined keeps the standing unanswered rather than guessing one. */
  humanMemberId?: AgentTeamMemberId | undefined,
): ThreadFollowState {
  const [following, setFollowing] = useState<boolean | undefined>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  // The requestId a retry reuses: the Host answers a repeated id from its idempotency cache, so a lost answer converges instead of writing twice.
  const requestIds = useRef(new Map<string, AgentTeamRequestId>())
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  // The observation is the display authority. Reading it again after every write is what makes a follow or
  // unfollow visible on the other face too, without either face keeping its own copy of the standing.
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await threadObservations({ workspaceId: request.workspaceId, ...(request.threadRef === undefined ? {} : { threadRef: request.threadRef }), ...(request.taskRef === undefined ? {} : { taskRef: request.taskRef }) })
      if (!mounted.current) return
      // The follower set is every Member's Attention, so the Human's standing is the answer to a
      // question about the Human's own id. Until that id has been projected the standing stays
      // unanswered: guessing an id would let another Member's Attention read as the Human's.
      if (result.ok) setFollowing(followsIn(result.value.followers, humanMemberId))
    } catch {
      // A failed observation leaves the previous standing in place; the write itself reports its own failure.
    }
  }, [threadObservations, request.workspaceId, request.threadRef, request.taskRef, humanMemberId])

  // A face that hands its own observation in takes each answer as the standing; a face with
  // none asks for one. Either way the control paints what the Host last answered.
  useEffect(() => {
    if (observed === undefined) { void refresh(); return }
    setFollowing(followsIn(observed, humanMemberId))
  }, [observed, refresh, humanMemberId])

  const toggle = useCallback(async (action: 'follow' | 'unfollow'): Promise<void> => {
    if (pending) return
    setPending(true)
    setError(undefined)
    const requestId = requestIds.current.get(action) ?? mintRequestId()
    requestIds.current.set(action, requestId)
    try {
      const result = await changeAttention({ requestId, workspaceId: request.workspaceId, ...(request.threadRef === undefined ? {} : { threadRef: request.threadRef }), ...(request.taskRef === undefined ? {} : { taskRef: request.taskRef }), action })
      if (!mounted.current) return
      if (!result.ok) { setError(result.error.message); return }
      // The result carries the durable Attention row, present after a follow and absent after an
      // unfollow. The re-read that follows re-projects the whole follower set, which is what the
      // other face of the Thread reads too — so both faces agree without either keeping a copy.
      setFollowing(result.value.attention !== undefined)
      await refresh()
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setPending(false)
    }
  }, [pending, changeAttention, refresh, request.workspaceId, request.threadRef, request.taskRef])

  return { following, pending, error, toggle }
}

export type TransferWrite = (request: AgentTeamTransferTaskRequest) => Promise<RemoteResult<AgentTeamTransferTaskResult>>

/** Why the Host declined the transfer, in the shape the caller localizes. */
export type TransferRefusal =
  | { readonly kind: 'unread_required'; readonly unreadCount: number }
  | { readonly kind: 'stale_revision' }

export interface TaskTransferState {
  readonly pending: boolean
  /** A Remote failure or a thrown call; the recoverable surface shows it beside the untouched control. */
  readonly error: string | undefined
  /** A business fence the Host answered with; the caller re-reads and keeps the surface recoverable. */
  readonly refusal: TransferRefusal | undefined
  /** The target a committed transfer landed on, so the surface can state the new accountable instead of leaving the reader to infer it from a feed row. */
  readonly landedOn: AgentTeamMemberId | undefined
  /** Hand this Task to one legal accountable; the Host decides whether the target is legal and whether the Human may move it now. */
  readonly transfer: (target: AgentTeamMemberId) => Promise<void>
}

/**
 * The Human's Task responsibility transfer, shared by the Thread page and the discussion panel. The Client offers a
 * target the Host already projected as a legal accountable and re-implements neither the authority rules nor the
 * fences: an unread or stale answer arrives as a typed outcome — the same control flow the accept, close, and reopen
 * buttons already model — and every refusal leaves the Task's current accountable on screen untouched.
 */
export function useTaskTransfer(
  transferTask: TransferWrite,
  request: {
    readonly workspaceId: WorkspaceId
    readonly taskRef: AgentTeamTask['taskRef']
    /** Read at call time: the caller's projection may have moved on since this render. */
    readonly revisionOf: () => number | undefined
    /** Called with the committed result, so the caller merges the Host's own transfer activity row and re-reads. */
    readonly onCommitted: (committed: AgentTeamTransferTaskCommittedResult) => void | Promise<void>
    /**
     * Called with the fence the Host answered, so the caller re-reads through its own recovery path. A
     * refusal is not a failure to swallow: the Task's projection moved on, so the surface must converge
     * on the Host's current state instead of leaving a stale one beside the message.
     */
    readonly onRefusal?: ((refusal: TransferRefusal) => void | Promise<void>) | undefined
  },
): TaskTransferState {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [refusal, setRefusal] = useState<TransferRefusal>()
  const [landedOn, setLandedOn] = useState<AgentTeamMemberId>()
  const requestIds = useRef(new Map<string, AgentTeamRequestId>())
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const transfer = useCallback(async (target: AgentTeamMemberId): Promise<void> => {
    if (pending) return
    const baseRevision = request.revisionOf()
    if (baseRevision === undefined) return
    setPending(true)
    setError(undefined)
    setRefusal(undefined)
    setLandedOn(undefined)
    const requestId = requestIds.current.get(target) ?? mintRequestId()
    requestIds.current.set(target, requestId)
    try {
      const result = await transferTask({ requestId, workspaceId: request.workspaceId, taskRef: request.taskRef, target, baseRevision })
      if (!mounted.current) return
      if (!result.ok) { setError(result.error.message); return }
      if (result.value.kind === 'committed') {
        requestIds.current.delete(target)
        // Stated from the Host's committed answer, not from the target that was asked for: the surface
        // names who holds the Task now, and a later refusal clears it again.
        setLandedOn(target)
        await request.onCommitted(result.value)
      } else if (result.value.kind === 'unread_required') {
        requestIds.current.delete(target)
        const refusal: TransferRefusal = { kind: 'unread_required', unreadCount: result.value.unreadCount }
        setRefusal(refusal)
        await request.onRefusal?.(refusal)
      } else {
        requestIds.current.delete(target)
        const refusal: TransferRefusal = { kind: 'stale_revision' }
        setRefusal(refusal)
        await request.onRefusal?.(refusal)
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setPending(false)
    }
  }, [pending, transferTask, request])

  return { pending, error, refusal, landedOn, transfer }
}
