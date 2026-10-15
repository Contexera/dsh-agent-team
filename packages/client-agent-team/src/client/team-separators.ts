/** One rendered timeline block: a same-sender run or an injected day marker. */
export type TimelineBlock<T> =
  | { readonly kind: 'run'; readonly items: readonly T[] }
  | { readonly kind: 'day'; readonly label: string }

/** Same-sender messages at least this many minutes apart count as separate turns. */
export const RUN_GAP_MINUTES = 5

/**
 * Whether two adjacent same-sender run items are separated by a real waiting
 * gap: only such gaps earn an explicit time divider, while rapid bursts stay
 * merged into one seamless run.
 */
export function isRunGap(previousOccurredAt: string | undefined, occurredAt: string | undefined): boolean {
  if (previousOccurredAt === undefined || occurredAt === undefined) return false
  const previous = Date.parse(previousOccurredAt)
  const at = Date.parse(occurredAt)
  return !Number.isNaN(previous) && !Number.isNaN(at) && at - previous >= RUN_GAP_MINUTES * 60_000
}

const pad = (value: number): string => String(value).padStart(2, '0')

export function timelineDayKey(occurredAt: string): string {
  return localDateKey(occurredAt)
}

function localDateKey(occurredAt: string): string {
  const at = new Date(occurredAt)
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * Numeric day label matching the message-time convention: MM-DD within the
 * current year, full YYYY-MM-DD across years.
 */
export function daySeparatorLabel(occurredAt: string, now = new Date()): string {
  const key = localDateKey(occurredAt)
  return key.startsWith(String(now.getFullYear())) ? key.slice(5) : key
}

/**
 * Chunk one ordered timeline into same-sender runs, breaking a run at every
 * calendar-day change so identity chrome restarts across days. Items without a
 * wall-clock instant (activities) inherit the preceding message's day and never
 * trigger a boundary; callers interleave activity rows between returned blocks.
 */
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
