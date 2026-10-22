import type { AgentTeamMemberId } from './types.ts'

/** Error families automatic recovery may act on. Classification uses the Harness's structured data first (stable code, then HTTP status); only an error with no usable code falls back to conservative string signatures. Any other structured code without a 429/503 status (provider, credential, quota, context, or request state) stays manual, as does unstructured wording matching neither signature. */
export type RecoverableErrorKind = 'transient network' | 'rate limiting'

const TRANSIENT_NETWORK_PATTERNS = [/fetch failed/i, /econnreset/i, /etimedout/i, /socket hang up/i]
const RATE_LIMIT_PATTERNS = [/\b429\b/, /rate limit/i, /\b503\b/, /overloaded/i]

/** Reads the stable code/status off any Harness-shaped failure by own fields, since a cross-package copy of `dsh-llm` loses `instanceof`. */
function structuredFailure(error: unknown): { readonly code?: string; readonly status?: number } {
  if (typeof error !== 'object' || error === null) return {}
  const root = error as { code?: unknown; status?: unknown; failure?: unknown }
  const failure = typeof root.failure === 'object' && root.failure !== null
    ? root.failure as { code?: unknown; status?: unknown }
    : undefined
  const code = typeof failure?.code === 'string' && failure.code.length > 0 ? failure.code
    : typeof root.code === 'string' && root.code.length > 0 ? root.code : undefined
  if (code === undefined) return {}
  const status = typeof failure?.status === 'number' && Number.isInteger(failure.status) ? failure.status
    : typeof root.status === 'number' && Number.isInteger(root.status) ? root.status : undefined
  return { code, ...status === undefined ? {} : { status } }
}

/** The readable message of an arbitrary thrown value. */
function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(error)
}

/** One thrown value as a single-line diagnostic: error name, stable code if any, and message. Stacks and cause chains stay with the Harness exporter. */
export function failureDetail(error: unknown): string {
  const message = failureMessage(error)
  if (!(error instanceof Error)) return message
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? `${error.name} code '${code}': ${message}` : `${error.name}: ${message}`
}

/** Classify one `agent/error` occurrence into the family automatic recovery may act on, or `undefined` when a wake cannot help. */
export function classifyRecoverableError(error: unknown): RecoverableErrorKind | undefined {
  // Structured data outranks wording: a Harness code decides alone, and message signatures run only when no usable code exists (`UNKNOWN` is a folded foreign error whose taxonomy Team must not trust).
  const { code, status } = structuredFailure(error)
  if (code !== undefined && code !== 'UNKNOWN') return kindFromProvenance(code, status)
  const message = failureMessage(error)
  if (RATE_LIMIT_PATTERNS.some(pattern => pattern.test(message))) return 'rate limiting'
  if (TRANSIENT_NETWORK_PATTERNS.some(pattern => pattern.test(message))) return 'transient network'
  return undefined
}

/** Classifies one Harness failure code: recoverable families map directly, any other code stays manual unless a matching HTTP status shows rate limiting. */
function kindFromProvenance(code: string, status: number | undefined): RecoverableErrorKind | undefined {
  if (code === 'RATE_LIMIT') return 'rate limiting'
  if (code === 'TRANSPORT' || code === 'TIMEOUT') return 'transient network'
  if (status === 429 || status === 503) return 'rate limiting'
  return undefined
}

/** Why one Member's automatic recovery episode ended. */
export type RecoveryClearReason =
  | 'clean-turn'
  | 'non-recoverable'
  | 'wake-failed'
  | 'session-disposed'
  | 'manual'
  | 'host-disposed'

/** One observable step of a Member's automatic recovery. Every decision is reported because none is reconstructible from `agent/error` events alone: terminal errors cancel pending wakeups, stood-down episodes suppress later ones, and a wake with a missing target ends tracking silently. */
export type RecoveryFact =
  | {
      readonly kind: 'scheduled'
      readonly memberId: AgentTeamMemberId
      readonly errorKind: RecoverableErrorKind
      readonly consecutiveFailures: number
      readonly maxConsecutiveErrors: number
      readonly delayMs: number
    }
  | {
      readonly kind: 'woke'
      readonly memberId: AgentTeamMemberId
      readonly consecutiveFailures: number
    }
  | {
      readonly kind: 'stood-down'
      readonly memberId: AgentTeamMemberId
      readonly errorKind: RecoverableErrorKind
      readonly consecutiveFailures: number
      readonly maxConsecutiveErrors: number
    }
  | {
      readonly kind: 'cleared'
      readonly memberId: AgentTeamMemberId
      readonly reason: RecoveryClearReason
      readonly consecutiveFailures: number
      /** Wakeups the clear cancelled; with `stoodDown` this is what a silent stop would have hidden. */
      readonly pendingWakes: number
      readonly stoodDown: boolean
      /** The wake failure that ended tracking, for `wake-failed`; never a stack. */
      readonly detail?: string
    }

export interface RecoveryCoordinatorOptions {
  /** Performs a delayed recovery wakeup; throwing means the Member is gone and tracking stops. */
  readonly wake: (memberId: AgentTeamMemberId) => void
  /** Every recovery state change, once per change: the only way a decision here leaves the coordinator. */
  readonly report?: (fact: RecoveryFact) => void
  /** Delay between a recoverable error and its automatic recovery wakeup. */
  readonly delayMs?: number
  /** Consecutive recoverable errors allowed before automatic recovery stands down. */
  readonly maxConsecutiveErrors?: number
}

interface EpisodeState {
  consecutiveFailures: number
  timers: Set<ReturnType<typeof setTimeout>>
  stoodDown?: boolean | undefined
}

export const RECOVERY_DELAY_MS = 120_000
export const RECOVERY_MAX_CONSECUTIVE_ERRORS = 3

/** Per-member automatic recovery episodes. An episode is every recoverable `agent/error` until a clean turn end, regardless of text or family; each of the first two occurrences schedules its own wakeup. */
export class RecoveryCoordinator {
  private readonly episodes = new Map<AgentTeamMemberId, EpisodeState>()
  private readonly wake: RecoveryCoordinatorOptions['wake']
  private readonly report: RecoveryCoordinatorOptions['report']
  private readonly delayMs: number
  private readonly maxConsecutiveErrors: number

  constructor(options: RecoveryCoordinatorOptions) {
    this.wake = options.wake
    this.report = options.report
    this.delayMs = options.delayMs ?? RECOVERY_DELAY_MS
    this.maxConsecutiveErrors = options.maxConsecutiveErrors ?? RECOVERY_MAX_CONSECUTIVE_ERRORS
  }

  /** Observe one `agent/error` occurrence for a Member; `error` is the raw event payload. */
  onError(memberId: AgentTeamMemberId, error: unknown): void {
    const errorKind = classifyRecoverableError(error)
    if (errorKind === undefined) {
      // A non-recoverable failure cancels anything pending: retrying cannot help.
      this.stopTracking(memberId, 'non-recoverable')
      return
    }

    let episode = this.episodes.get(memberId)
    if (episode === undefined) {
      episode = { consecutiveFailures: 0, timers: new Set() }
      this.episodes.set(memberId, episode)
    }
    if (episode.stoodDown === true) return

    episode.consecutiveFailures += 1
    if (episode.consecutiveFailures >= this.maxConsecutiveErrors) {
      this.cancelTimers(episode)
      episode.stoodDown = true
      this.emit({
        kind: 'stood-down', memberId, errorKind,
        consecutiveFailures: episode.consecutiveFailures, maxConsecutiveErrors: this.maxConsecutiveErrors,
      })
      return
    }

    const timer = setTimeout(() => {
      episode!.timers.delete(timer)
      this.emit({ kind: 'woke', memberId, consecutiveFailures: episode!.consecutiveFailures })
      try {
        this.wake(memberId)
      } catch (error) {
        // The target is gone: the operator gets the reason instead of a silent
        // end, and the message is the only part of the failure worth keeping.
        this.stopTracking(memberId, 'wake-failed', failureDetail(error))
      }
    }, this.delayMs)
    episode.timers.add(timer)
    this.emit({
      kind: 'scheduled', memberId, errorKind,
      consecutiveFailures: episode.consecutiveFailures, maxConsecutiveErrors: this.maxConsecutiveErrors, delayMs: this.delayMs,
    })
  }

  /** A turn ended cleanly (running→idle without an error): the episode is over. */
  onCleanTurnEnd(memberId: AgentTeamMemberId): void {
    this.stopTracking(memberId, 'clean-turn')
  }

  /** End one Member's episode; `reason` says who ended it, and only a live episode reports. */
  stopTracking(memberId: AgentTeamMemberId, reason: RecoveryClearReason, detail?: string): void {
    const episode = this.episodes.get(memberId)
    if (episode === undefined) return
    const pendingWakes = episode.timers.size
    this.cancelTimers(episode)
    this.episodes.delete(memberId)
    this.emit({
      kind: 'cleared', memberId, reason,
      consecutiveFailures: episode.consecutiveFailures,
      pendingWakes,
      stoodDown: episode.stoodDown === true,
      ...(detail === undefined ? {} : { detail }),
    })
  }

  dispose(): void {
    // Snapshot first: `stopTracking` deletes the entry it clears, and each
    // Member's clear must be reported before the next one is visited.
    for (const memberId of Array.from(this.episodes.keys())) this.stopTracking(memberId, 'host-disposed')
  }

  private emit(fact: RecoveryFact): void {
    this.report?.(fact)
  }

  private cancelTimers(episode: EpisodeState): void {
    for (const timer of episode.timers) clearTimeout(timer)
    episode.timers.clear()
  }
}
