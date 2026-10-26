import { describe, expect, it } from 'vitest'
import { chunkRunsWithDays, chunkTimeline, daySeparatorLabel, isRunGap, placeCards, type TimelineEntry } from '../src/client/team-separators.ts'

interface Row {
  readonly sender?: string | undefined
  readonly at?: string | undefined
}

const senderOf = (row: Row): string | undefined => row.sender
const occurredAtOf = (row: Row): string | undefined => row.at

describe('timeline day separators', () => {
  it('keeps one same-sender run within a single day', () => {
    const blocks = chunkRunsWithDays<Row>([
      { sender: 'a', at: '2026-08-21T09:00:00Z' },
      { sender: 'a', at: '2026-08-21T09:05:00Z' },
    ], senderOf, occurredAtOf)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'run', items: { length: 2 } })
  })

  it('breaks the run and injects one marker at a day change', () => {
    const blocks = chunkRunsWithDays<Row>([
      { sender: 'a', at: '2026-08-20T09:00:00Z' },
      { sender: 'a', at: '2026-08-21T04:00:00Z' },
      { sender: 'a', at: '2026-08-21T02:00:00Z' },
    ], senderOf, occurredAtOf)
    expect(blocks.map(block => block.kind)).toEqual(['run', 'day', 'run'])
    const marker = blocks[1]
    if (marker?.kind === 'day') expect(marker.label).toBe('08-21')
    const tail = blocks[2]
    if (tail?.kind === 'run') expect(tail.items).toHaveLength(2)
  })

  it('lets activities inherit the surrounding day without triggering markers', () => {
    const blocks = chunkRunsWithDays<Row>([
      { sender: 'a', at: '2026-08-21T09:00:00Z' },
      { sender: undefined },
      { sender: undefined },
      { sender: 'a', at: '2026-08-21T10:00:00Z' },
    ], senderOf, occurredAtOf)
    expect(blocks.filter(block => block.kind === 'day')).toHaveLength(0)
    expect(blocks).toHaveLength(4)
  })

  it('labels cross-year days with the full date', () => {
    expect(daySeparatorLabel('2027-01-02T00:30:00Z', new Date('2026-12-31T00:00:00Z'))).toBe('2027-01-02')
    expect(daySeparatorLabel('2026-08-21T00:30:00Z', new Date('2026-08-22T00:00:00Z'))).toBe('08-21')
  })

  it('starts a fresh run for a different sender on the same day', () => {
    const blocks = chunkRunsWithDays<Row>([
      { sender: 'a', at: '2026-08-21T09:00:00Z' },
      { sender: 'b', at: '2026-08-21T09:30:00Z' },
    ], senderOf, occurredAtOf)
    expect(blocks).toHaveLength(2)
    expect(blocks.every(block => block.kind === 'run')).toBe(true)
  })
})

describe('same-sender turn gap', () => {
  it('marks waits of at least five minutes as separate turns', () => {
    expect(isRunGap('2026-08-21T09:00:00.000Z', '2026-08-21T09:05:00.000Z')).toBe(true)
    expect(isRunGap('2026-08-21T09:00:00.000Z', '2026-08-21T09:04:59.000Z')).toBe(false)
  })

  it('stays silent without two valid instants', () => {
    expect(isRunGap(undefined, '2026-08-21T09:05:00.000Z')).toBe(false)
    expect(isRunGap('2026-08-21T09:00:00.000Z', undefined)).toBe(false)
    expect(isRunGap('not-a-date', '2026-08-21T09:05:00.000Z')).toBe(false)
    expect(isRunGap('2026-08-21T09:00:00.000Z', '2026-08-21T08:59:00.000Z')).toBe(false)
  })
})

interface Fact {
  readonly sequence: number
  readonly sender?: string | undefined
  readonly at?: string | undefined
}

const factSender = (fact: Fact): string | undefined => fact.sender
const factAt = (fact: Fact): string | undefined => fact.at

/** A derived card names the sequence of the fact it was derived from, which is the only place it may appear. */
interface Card {
  readonly key: string
  readonly sequence: number
}

const cardOf = (card: Card) => ({ sequence: card.sequence, key: card.key })

describe('derived cards in a fact timeline', () => {
  it('places each card at its creation sequence rather than at the end', () => {
    const facts: Fact[] = [{ sequence: 1 }, { sequence: 3 }, { sequence: 5 }]
    const entries = placeCards(facts, [{ key: 'card-b', sequence: 4 }, { key: 'card-a', sequence: 2 }], fact => fact.sequence, cardOf)
    expect(entries.map(entry => entry.kind === 'fact' ? `fact:${entry.fact.sequence}` : `card:${entry.key}`))
      .toEqual(['fact:1', 'card:card-a', 'fact:3', 'card:card-b', 'fact:5'])
  })

  it('keeps several cards on one sequence in a stable order and trails the rest', () => {
    const facts: Fact[] = [{ sequence: 1 }]
    const entries = placeCards(facts, [{ key: 'card-z', sequence: 2 }, { key: 'card-a', sequence: 2 }, { key: 'card-t', sequence: 9 }], fact => fact.sequence, cardOf)
    expect(entries.map(entry => entry.kind === 'fact' ? 'fact' : entry.key)).toEqual(['fact', 'card-a', 'card-z', 'card-t'])
    expect(placeCards<Fact, Card>([], [{ key: 'card-a', sequence: 1 }], fact => fact.sequence, cardOf)).toEqual([{ kind: 'card', key: 'card-a', card: { key: 'card-a', sequence: 1 } }])
  })

  it('breaks the surrounding run, inherits the day, and never becomes a lone fact', () => {
    const facts: Fact[] = [
      { sequence: 1, sender: 'a', at: '2026-08-21T09:00:00Z' },
      { sequence: 2, sender: 'a', at: '2026-08-21T09:01:00Z' },
      { sequence: 4, sender: 'a', at: '2026-08-21T09:04:00Z' },
    ]
    const entries = placeCards(facts, [{ key: 'card-a', sequence: 3 }], fact => fact.sequence, cardOf)
    const nodes = chunkTimeline<Fact, Card>(entries, factSender, factAt)
    expect(nodes.map(node => node.kind)).toEqual(['run', 'card', 'run'])
    // One day: the card carries no instant of its own, so it triggers no divider.
    expect(nodes.filter(node => node.kind === 'day')).toHaveLength(0)
    const [head, card, tail] = nodes
    if (head?.kind === 'run') expect(head.items.map(fact => fact.sequence)).toEqual([1, 2])
    if (card?.kind === 'card') expect(card.key).toBe('card-a')
    if (tail?.kind === 'run') expect(tail.items.map(fact => fact.sequence)).toEqual([4])
  })

  it('marks the unread boundary above the first marked fact only, and ends the run before it', () => {
    const facts: Fact[] = [
      { sequence: 1, sender: 'a', at: '2026-08-21T09:00:00Z' },
      { sequence: 2, sender: 'a', at: '2026-08-21T09:01:00Z' },
      { sequence: 3, sender: 'a', at: '2026-08-21T09:02:00Z' },
    ]
    const entries: readonly TimelineEntry<Fact, Card>[] = facts.map(fact => ({ kind: 'fact', fact }))
    // The page draws one boundary at the first unread fact, so a run that straddles it is split there.
    const nodes = chunkTimeline<Fact, Card>(entries, factSender, factAt, fact => fact.sequence === 2)
    expect(nodes.map(node => node.kind)).toEqual(['run', 'boundary', 'run'])
    const [head, , tail] = nodes
    if (head?.kind === 'run') expect(head.items.map(fact => fact.sequence)).toEqual([1])
    if (tail?.kind === 'run') expect(tail.items.map(fact => fact.sequence)).toEqual([2, 3])
  })

  it('puts the boundary after a day divider and keeps activities out of runs', () => {
    const facts: Fact[] = [
      { sequence: 1, sender: 'a', at: '2026-08-20T09:00:00Z' },
      { sequence: 2, at: '2026-08-21T09:00:00Z' },
      { sequence: 3, sender: 'a', at: '2026-08-21T09:01:00Z' },
    ]
    const entries: readonly TimelineEntry<Fact, Card>[] = facts.map(fact => ({ kind: 'fact', fact }))
    const nodes = chunkTimeline<Fact, Card>(entries, factSender, factAt, fact => fact.sequence === 2)
    expect(nodes.map(node => node.kind)).toEqual(['run', 'day', 'boundary', 'lone', 'run'])
    if (nodes[1]?.kind === 'day') expect(nodes[1].label).toBe('08-21')
    // Without a marker of its own a sender-less activity is still its own node, never a run member.
    const plain = chunkTimeline<Fact, Card>([{ kind: 'fact', fact: facts[1]! }, { kind: 'fact', fact: facts[2]! }], factSender, factAt)
    expect(plain.map(node => node.kind)).toEqual(['lone', 'run'])
  })
})
