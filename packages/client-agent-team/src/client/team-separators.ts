export type TimelineBlock<T> =
  | { readonly kind: 'run'; readonly items: readonly T[] }
  | { readonly kind: 'day'; readonly label: string }

/**
 * One entry of a timeline that mixes facts with projections that are not facts — a Task derived from the discussion is
 * the only such projection today. A projected card has no sender and no instant of its own, so it never joins a run and
 * never introduces a day separator.
 */
export type TimelineEntry<T, C> =
  | { readonly kind: 'fact'; readonly fact: T }
  | { readonly kind: 'card'; readonly key: string; readonly card: C }

/** Where a projected card sits: the sequence of the fact it was derived from, and the identity its React key needs. */
export interface TimelineCardPlacement {
  readonly sequence: number
  readonly key: string
}

/** One node of a rendered timeline: a same-sender run, a day divider, a projected card, the unread boundary, or a lone activity. */
export type TimelineNode<T, C> =
  | { readonly kind: 'run'; readonly items: readonly T[] }
  | { readonly kind: 'day'; readonly label: string }
  | { readonly kind: 'card'; readonly key: string; readonly card: C }
  | { readonly kind: 'boundary' }
  | { readonly kind: 'lone'; readonly fact: T }

/** Same-sender messages at least this many minutes apart count as separate turns. */
export const RUN_GAP_MINUTES = 5

/** Only a real waiting gap earns a time divider; rapid bursts stay one run. */
export function isRunGap(previousOccurredAt: string | undefined, occurredAt: string | undefined): boolean {
  if (previousOccurredAt === undefined || occurredAt === undefined) return false
  const previous = Date.parse(previousOccurredAt)
  const at = Date.parse(occurredAt)
  return !Number.isNaN(previous) && !Number.isNaN(at) && at - previous >= RUN_GAP_MINUTES * 60_000
}

const pad = (value: number): string => String(value).padStart(2, '0')

export function localDateKey(occurredAt: string): string {
  const at = new Date(occurredAt)
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** MM-DD within the current year, YYYY-MM-DD across years. */
export function daySeparatorLabel(occurredAt: string, now = new Date()): string {
  const key = localDateKey(occurredAt)
  return key.startsWith(String(now.getFullYear())) ? key.slice(5) : key
}

/** Breaks a run at every calendar-day change. Items without a wall-clock instant (activities) inherit the preceding message's day and never trigger a boundary. */
export function chunkRunsWithDays<T>(items: readonly T[], senderOf: (item: T) => string | undefined, occurredAtOf: (item: T) => string | undefined): readonly TimelineBlock<T>[] {
  const blocks: TimelineBlock<T>[] = []
  let lastDate: string | undefined
  for (const item of items) {
    const occurredAt = occurredAtOf(item)
    if (occurredAt === undefined) {
      blocks.push({ kind: 'run', items: [item] })
      continue
    }
    const date = localDateKey(occurredAt)
    if (lastDate !== undefined && date !== lastDate) {
      blocks.push({ kind: 'day', label: daySeparatorLabel(occurredAt) })
      // The boundary also ends any open same-sender run before it.
      lastDate = date
    } else if (lastDate === undefined) {
      lastDate = date
    }
    let last = blocks[blocks.length - 1]
    if (last?.kind === 'run' && senderOf(last.items[last.items.length - 1]!) === senderOf(item)) {
      last = { kind: 'run', items: [...last.items, item] }
      blocks[blocks.length - 1] = last
    } else {
      blocks.push({ kind: 'run', items: [item] })
    }
  }
  return blocks
}

/**
 * Merge facts and projected cards into one sequence-ordered stream. A card sits before the first fact with a greater
 * sequence, so it keeps the place where its Task was created instead of collecting at the end of the timeline.
 */
export function placeCards<T, C>(
  facts: readonly T[],
  cards: readonly C[],
  sequenceOf: (fact: T) => number,
  placementOf: (card: C) => TimelineCardPlacement,
): readonly TimelineEntry<T, C>[] {
  const pending = cards
    .map(card => ({ placed: placementOf(card), card }))
    .sort((left, right) => left.placed.sequence - right.placed.sequence || left.placed.key.localeCompare(right.placed.key))
  const entries: TimelineEntry<T, C>[] = []
  let next = 0
  const drainBefore = (sequence: number): void => {
    while (next < pending.length && pending[next]!.placed.sequence < sequence) {
      const entry = pending[next]!
      entries.push({ kind: 'card', key: entry.placed.key, card: entry.card })
      next += 1
    }
  }
  for (const fact of facts) {
    drainBefore(sequenceOf(fact))
    entries.push({ kind: 'fact', fact })
  }
  drainBefore(Number.POSITIVE_INFINITY)
  return entries
}

/**
 * Group a merged fact/card stream into render nodes. A card breaks the surrounding run and inherits the current day, the
 * boundary sits before the first fact it marks, and a fact with no sender (an activity) never joins a run.
 */
export function chunkTimeline<T, C>(
  entries: readonly TimelineEntry<T, C>[],
  senderOf: (fact: T) => string | undefined,
  occurredAtOf: (fact: T) => string | undefined,
  isBoundaryOf: (fact: T) => boolean = () => false,
): readonly TimelineNode<T, C>[] {
  const nodes: TimelineNode<T, C>[] = []
  let run: T[] = []
  let lastDay: string | undefined
  const flushRun = (): void => {
    if (run.length > 0) nodes.push({ kind: 'run', items: run })
    run = []
  }
  for (const entry of entries) {
    if (entry.kind === 'card') {
      flushRun()
      nodes.push({ kind: 'card', key: entry.key, card: entry.card })
      continue
    }
    const fact = entry.fact
    const occurredAt = occurredAtOf(fact)
    if (occurredAt !== undefined) {
      const day = localDateKey(occurredAt)
      if (lastDay !== undefined && day !== lastDay) {
        flushRun()
        nodes.push({ kind: 'day', label: daySeparatorLabel(occurredAt) })
      }
      lastDay = day
    }
    if (isBoundaryOf(fact)) {
      flushRun()
      nodes.push({ kind: 'boundary' })
    }
    const sender = senderOf(fact)
    if (sender === undefined) {
      flushRun()
      nodes.push({ kind: 'lone', fact })
      continue
    }
    const last = run[run.length - 1]
    if (last !== undefined && senderOf(last) === sender) {
      run.push(fact)
      continue
    }
    flushRun()
    run.push(fact)
  }
  flushRun()
  return nodes
}
