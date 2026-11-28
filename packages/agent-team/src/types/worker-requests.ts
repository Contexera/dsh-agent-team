/** Remote contracts for Worker runs: start and settle writes, run views, stop, inspection and steering. */
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace"
import type {
  AgentTeamMemberActor,
  AgentTeamMemberId,
  AgentTeamOperationId,
  AgentTeamProjectRef,
  AgentTeamRequestId,
  AgentTeamTaskRef,
  AgentTeamThreadRef,
  AgentTeamWorkerFragmentKind,
  AgentTeamWorkerRef,
  AgentTeamWorkerSettledActivity,
  AgentTeamWorkerSettlement,
  AgentTeamWorkerStage,
  AgentTeamWorkerStartRecord,
  AgentTeamWorkerStartedActivity,
  AgentTeamWorkerState,
} from "./entities.ts"
import type { AgentTeamOperationReceipt } from "./operation-receipt.ts"

/** The private half of one delegated Worker run, as the notice that wakes its initiator carries it. */
export interface AgentTeamWorkerAnswer {
  readonly workerRef: AgentTeamWorkerRef
  /** The Worker's final answer, text only, bounded when it was stored; absent when it produced none. */
  readonly output?: string | undefined
  /** Safe failure summary, never a native cause. */
  readonly diagnostic?: string | undefined
}

/**
 * Host-internal write that opens a delegated Worker run. The Host has already
 * resolved the target and authorized the caller; the ledger re-derives both, so
 * a replayed record can only exist for a binding that was legal when it was
 * written. The opening instant is the operation's own, never a caller's clock.
 */
export interface AgentTeamWorkerStartWrite {
  readonly requestId: AgentTeamRequestId
  readonly actor: AgentTeamMemberActor
  readonly workspaceId: WorkspaceId
  readonly execution: Omit<AgentTeamWorkerStartRecord, 'startedAt'>
}

/** One recorded opening of a delegated Worker run, as a resend resolves it. */
export interface AgentTeamWorkerStartedRecorded {
  readonly receipt: AgentTeamOperationReceipt
  /** The binding the record fixed; the run itself is `running` by definition here. */
  readonly execution: AgentTeamWorkerStartRecord
  readonly activity?: AgentTeamWorkerStartedActivity | undefined
}

/**
 * Host-internal write that closes a delegated Worker run. The Host makes it
 * once, when the execution ends: the run is keyed on its own ref, so a repeated
 * callback resolves the record it already wrote instead of ending it twice.
 */
export interface AgentTeamWorkerSettleWrite {
  readonly requestId: AgentTeamRequestId
  readonly settlement: Omit<AgentTeamWorkerSettlement, 'settledAt'>
}

/** One recorded ending of a delegated Worker run. */
export interface AgentTeamWorkerSettledRecorded {
  readonly receipt: AgentTeamOperationReceipt
  readonly workerRef: AgentTeamWorkerRef
  readonly state: AgentTeamWorkerSettledActivity['state']
  readonly settledAt: string
  readonly activity?: AgentTeamWorkerSettledActivity | undefined
}

/**
 * How one delegated Worker run stands, as a Thread read derives it. `state` is
 * the execution record's own durable state; `unconfirmed` marks a record left
 * in `running` with no live execution behind it in this Host, which happens
 * when the Host that started the run no longer holds its handle. Such a run is
 * never re-run and never automatically retried, so the only honest thing to
 * report is that its result cannot be confirmed.
 */
export interface AgentTeamWorkerStateView {
  readonly workerRef: AgentTeamWorkerRef
  readonly state: AgentTeamWorkerState
  readonly unconfirmed: boolean
  /** The Host that started the run has been asked to stop it and has not confirmed cleanup yet. Derived, never stored. */
  readonly stopping?: boolean | undefined
}

/**
 * How one Worker run stands in the Human's own run list. `stopping` is the live
 * request this Host has not confirmed yet; `unconfirmed` is a record a previous
 * Host left running, which this Host cannot stop or take over. The three terminal
 * states are a run's own durable ending, listed so the Human can read its
 * diagnostic after the process exited — never as if it were still live.
 */
export type AgentTeamWorkerRunViewState = 'running' | 'stopping' | 'unconfirmed'
  | Exclude<AgentTeamWorkerState, 'running'>

/** One Worker run, live or ended, as the Human's edit-Agent surface lists it. */
export interface AgentTeamWorkerRunView {
  readonly workerRef: AgentTeamWorkerRef
  readonly projectRef: AgentTeamProjectRef
  readonly engine: import('../worker-settings.ts').WorkerEngine
  readonly state: AgentTeamWorkerRunViewState
  /** A bounded preview of the task the Worker was given; the full text stays in the private execution record. */
  readonly task: string
  readonly startedAt: string
  /** The Thread the run reports into; absent on a Project-only delegation. */
  readonly threadRef?: AgentTeamThreadRef | undefined
  readonly taskRef?: AgentTeamTaskRef | undefined
}

/** The Human's read of one Member's Worker runs. */
export interface AgentTeamWorkerRunListRequest {
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
}

export interface AgentTeamWorkerRunListResult {
  readonly runs: readonly AgentTeamWorkerRunView[]
}

/** The Human's stop request for one execution, addressed by its Team-owned ref. */
export interface AgentTeamWorkerStopRequest {
  readonly workspaceId: WorkspaceId
  readonly workerRef: AgentTeamWorkerRef
  /** The Member whose edit surface asked; the Host stops only a run that Member initiated. */
  readonly memberId: AgentTeamMemberId
}

/**
 * What the Human's stop surface learns about one execution, as structured facts
 * rather than a sentence to parse. `ended` carries the state the run really
 * reached — a run that finished first is not a stopped run, and a cleanup the
 * engine never confirmed is `failed` with the Host's own `diagnostic`. `pending`
 * means cleanup or recording is still in flight. `unconfirmed` means this Host
 * cannot supply an ending, because it lost the handle or recording failed.
 */
export type AgentTeamWorkerStopResult =
  | {
    readonly kind: 'ended'
    readonly workerRef: AgentTeamWorkerRef
    readonly state: Exclude<AgentTeamWorkerState, 'running'>
    readonly settledAt?: string | undefined
    readonly diagnostic?: string | undefined
  }
  | { readonly kind: 'pending'; readonly workerRef: AgentTeamWorkerRef; readonly message: string }
  | { readonly kind: 'unconfirmed'; readonly workerRef: AgentTeamWorkerRef; readonly message: string }

/** One bounded piece of a run's native record, as the diagnostic read returns it. */
export interface AgentTeamWorkerInspectionFragment {
  readonly kind: AgentTeamWorkerFragmentKind
  readonly text: string
}

/**
 * What a look-up could take from the engine's own record. `read` carries the
 * bounded fragments; every other kind keeps the Team's summary and names the one
 * reason the native record could not answer — a missing file, an unreadable one,
 * nothing ever written, a shape this Team does not read, or a record that holds
 * no turn with the recorded id. A surface never has to guess whether an empty
 * list means "nothing happened" or "nothing could be read".
 */
export type AgentTeamWorkerInspectionHistory =
  | {
    readonly kind: 'read'
    readonly fragments: readonly AgentTeamWorkerInspectionFragment[]
    /** Fragments withheld because their text looked like a credential. */
    readonly withheld: number
    /** The record outran the reader's bound, so later records were not read. */
    readonly truncated: boolean
  }
  | { readonly kind: 'missing'; readonly reason: string }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'unpersisted'; readonly reason: string }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'unmatched'; readonly reason: string }

/**
 * One delegated Worker run as its initiator or the Human may read it by number:
 * the same summary the Thread carries, the native identities the settlement
 * recorded, and whatever the engine's own record still answers. It is built on
 * demand and never stored — the ledger keeps the anchors, not the record.
 */
export interface AgentTeamWorkerInspection {
  readonly workerRef: AgentTeamWorkerRef
  readonly projectRef: AgentTeamProjectRef
  readonly engine: import('../worker-settings.ts').WorkerEngine
  readonly state: AgentTeamWorkerState
  /** No live execution backs this record any more, so its ending cannot be confirmed. */
  readonly unconfirmed: boolean
  readonly startedAt: string
  readonly settledAt?: string | undefined
  readonly threadRef?: AgentTeamThreadRef | undefined
  readonly taskRef?: AgentTeamTaskRef | undefined
  /** The public layer: the sentence the Thread already carries. */
  readonly summary: string
  /** Where a failed run came apart; absent when it did not fail. */
  readonly stage?: AgentTeamWorkerStage | undefined
  /** The engine's own identities, as recorded; a missing one says the run never reached it. */
  readonly native: {
    readonly threadId?: string | undefined
    /** The anchor older ledgers recorded; it names one turn, not necessarily every turn the execution drove. */
    readonly turnId?: string | undefined
    /** The bounded native turn anchors retained by this execution's settlement. */
    readonly turnIds?: readonly string[] | undefined
    /** The bounded native input UUIDs retained by this execution's settlement. */
    readonly inputIds?: readonly string[] | undefined
    readonly storage?: string | undefined
  }
  readonly history: AgentTeamWorkerInspectionHistory
}

/** The Human's read of one execution's diagnostic, addressed by its Team-owned ref. */
export interface AgentTeamWorkerInspectRequest {
  readonly workspaceId: WorkspaceId
  readonly workerRef: AgentTeamWorkerRef
  /** The Member whose edit surface asked; only a run that Member initiated is answered. */
  readonly memberId: AgentTeamMemberId
}

/**
 * One Member's instruction to a Worker execution it delegated. A live execution
 * may take it in the current turn or a later turn of the same native session. A
 * cleanly ended execution resumes that native session as a linked execution.
 * The request id is the idempotency key: a resend with the same instruction
 * answers with the first receipt, and the same id with a different instruction
 * is refused rather than sent.
 */
export interface AgentTeamWorkerSteerRequest {
  readonly workerRef: AgentTeamWorkerRef
  readonly instruction: string
  readonly requestId: AgentTeamRequestId
}

/**
 * What the steer call did. `submitted` means the native session accepted the
 * instruction into its current execution, not that the model read it or that it
 * landed in a fixed turn. `started` means the source execution had ended, so the
 * Host created a linked execution by resuming the same native session and sent
 * this instruction as its opening input.
 */
export interface AgentTeamWorkerSteerResult {
  readonly workerRef: AgentTeamWorkerRef
  readonly engine: import('../worker-settings.ts').WorkerEngine
  readonly state: 'submitted' | 'started'
  /** Where OAR delivered the input: the running turn, a later queued turn, or an idle session's next turn. */
  readonly landed?: 'steered' | 'queued' | 'prompted' | undefined
  /** The turn the engine said it steered into, when its acknowledgement named one. */
  readonly turnId?: string | undefined
  /** The execution this continuation resumed; present only when `state` is `started`. */
  readonly continuedFrom?: AgentTeamWorkerRef | undefined
  readonly runState: AgentTeamWorkerState | 'unconfirmed' | 'stopping'
}

/** One refusal sentence the Host may replay exactly, already bounded at the delivery boundary. */
export interface AgentTeamWorkerSteerRefusal {
  readonly code: string
  readonly message: string
}

/**
 * The durable outcome of one steer request. `ambiguous` includes both a native
 * transport whose delivery is unknown and an admission that never reached a
 * recorded result; neither may be retried automatically.
 */
export type AgentTeamWorkerSteerStoredOutcome =
  | { readonly kind: 'submitted'; readonly result: AgentTeamWorkerSteerResult }
  | { readonly kind: 'refused'; readonly refusal: AgentTeamWorkerSteerRefusal }
  | { readonly kind: 'ambiguous'; readonly refusal: AgentTeamWorkerSteerRefusal }

/**
 * Host-internal admission of one steer request id, written before any native
 * delivery. An alias names the canonical request whose submitted result a
 * same-text retry answers with; it performs no native side effect.
 */
export interface AgentTeamWorkerSteerAdmissionWrite {
  readonly requestId: AgentTeamRequestId
  readonly actor: import('./entities.ts').AgentTeamMemberActor
  readonly workspaceId: import('@deepseek-ai/dsh-workspace').WorkspaceId
  readonly workerRef: AgentTeamWorkerRef
  readonly instruction: string
  readonly initiatedBy: AgentTeamMemberId
  /** The ended execution this admission resumes, when the receiving execution does not exist yet. */
  readonly continuedFrom?: AgentTeamWorkerRef | undefined
  readonly aliasOf?: AgentTeamRequestId | undefined
}

/** One admission or alias as replay resolves it. */
export interface AgentTeamWorkerSteerAdmission {
  readonly kind: 'admitted'
  readonly requestId: AgentTeamRequestId
  readonly operationId: AgentTeamOperationId
  readonly workspaceId: WorkspaceId
  readonly workerRef: AgentTeamWorkerRef
  readonly instruction: string
  readonly initiatedBy: AgentTeamMemberId
  readonly continuedFrom?: AgentTeamWorkerRef | undefined
  readonly aliasOf?: AgentTeamRequestId | undefined
  /** Absent means the request was admitted but no outcome was stored. */
  readonly outcome?: AgentTeamWorkerSteerStoredOutcome | undefined
}

/** One request id already belongs to a non-steer operation or a start that cannot answer a steer. */
export interface AgentTeamWorkerSteerRequestConflict {
  readonly kind: 'conflict'
  readonly requestId: AgentTeamRequestId
}

/** What one request id means in the steer projection. */
export type AgentTeamWorkerSteerRequestState = AgentTeamWorkerSteerAdmission | AgentTeamWorkerSteerRequestConflict

/**
 * What a delegation target names, as the Host resolves it before it writes
 * anything or starts a process. A Thread and a Task agree about each other or
 * the target is contradictory; an explicitly named Project must also contain
 * that Thread, rather than being silently replaced by the derived Project.
 */
export type AgentTeamDelegationTarget =
  | {
    readonly kind: 'thread'
    readonly workspaceId: WorkspaceId
    readonly projectRef: AgentTeamProjectRef
    readonly threadRef: AgentTeamThreadRef
    /** The Thread's own Task; a run bound to a taskful Thread carries it too. */
    readonly taskRef?: AgentTeamTaskRef | undefined
  }
  | { readonly kind: 'project'; readonly workspaceId: WorkspaceId; readonly projectRef: AgentTeamProjectRef }
  | { readonly kind: 'target-required' }
  | { readonly kind: 'project-unknown'; readonly projectRef: AgentTeamProjectRef }
  | { readonly kind: 'thread-unknown'; readonly threadRef: AgentTeamThreadRef }
  | { readonly kind: 'task-unknown'; readonly taskRef: AgentTeamTaskRef }
  | { readonly kind: 'target-conflict'; readonly threadRef: AgentTeamThreadRef; readonly taskRef: AgentTeamTaskRef }
  | { readonly kind: 'project-conflict'; readonly projectRef: AgentTeamProjectRef; readonly threadRef: AgentTeamThreadRef }
