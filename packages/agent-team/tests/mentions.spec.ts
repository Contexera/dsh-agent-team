import { describe, expect, it } from 'vitest'
import { hasAllMarker, resolveBodyMentions, scanBodyHandles } from '../src/mentions.ts'
import type { AgentTeamBodyMentionCandidate } from '../src/mentions.ts'
import type { AgentTeamMemberId } from '../src/types.ts'
import { MENTION_BODY_FIXTURE } from './fixtures/mention-bodies.ts'

const memberId = (value: string): AgentTeamMemberId => `member:${value}` as AgentTeamMemberId
const SENDER = memberId('sender')

const candidate = (handle: string, id = handle): AgentTeamBodyMentionCandidate =>
  Object.freeze({ memberId: memberId(id), handle })

const CANDIDATES: readonly AgentTeamBodyMentionCandidate[] = Object.freeze([
  candidate('Reeve'), candidate('tars'), candidate('Aster'),
])

/** Resolve against the shared roster; ids come back as short suffixes for readable assertions. */
const resolve = (body: string, candidates: readonly AgentTeamBodyMentionCandidate[] = CANDIDATES) => {
  const resolution = resolveBodyMentions(body, candidates, SENDER)
  return { names: resolution.memberIds.map(id => (id as string).replace('member:', '')), all: resolution.all }
}

describe('resolveBodyMentions requires an authored @', () => {
  it('resolves an @Handle and ignores the same name without one', () => {
    expect(resolve('@tars, please take this')).toEqual({ names: ['tars'], all: false })
    expect(resolve('tars, please take this')).toEqual({ names: [], all: false })
    expect(resolve('Reeve is the reviewer here')).toEqual({ names: [], all: false })
  })

  it('matches handles case-insensitively and returns each Member once', () => {
    expect(resolve('@REEVE and @reeve and @Reeve')).toEqual({ names: ['Reeve'], all: false })
  })

  it('returns Members in candidate order and never the sender', () => {
    expect(resolve('@tars @Aster @Reeve')).toEqual({ names: ['Reeve', 'tars', 'Aster'], all: false })
    // A Message never mentions its own author: the sender drops out of the roster.
    expect(resolve('@sender, note to self', [candidate('sender'), candidate('tars')])).toEqual({ names: [], all: false })
  })

  it('requires a word boundary, so an address or a longer word is not a mention', () => {
    expect(resolve('mail@tars.example')).toEqual({ names: [], all: false })
    expect(resolve('see @tarsish and @tars2')).toEqual({ names: [], all: false })
    expect(resolve('(@tars)')).toEqual({ names: ['tars'], all: false })
    // Punctuation ends a handle, exactly as the Client's chip segmentation reads
    // it, so a chip and a delivery always agree on where a handle stops.
    expect(resolve('@tars-like work')).toEqual({ names: ['tars'], all: false })
  })

  it('prefers the longest handle, so a prefix never steals a longer name', () => {
    const roster = [candidate('reeve'), candidate('reeves')]
    expect(resolve('@reeves, please look', roster)).toEqual({ names: ['reeves'], all: false })
    expect(resolve('@reeve, please look', roster)).toEqual({ names: ['reeve'], all: false })
  })

  it('escapes regular-expression characters in a handle', () => {
    expect(resolve('@a+b take it', [candidate('a+b')])).toEqual({ names: ['a+b'], all: false })
  })
})

describe('resolveBodyMentions quotes code instead of calling it', () => {
  it('ignores a fenced block, including the names around it', () => {
    expect(resolve('Talk about it:\n```\n@tars @Reeve\n```\n@Aster takes it')).toEqual({ names: ['Aster'], all: false })
  })

  it('ignores an inline code span but reads the prose beside it', () => {
    expect(resolve('Quote `@tars` and then call @Reeve')).toEqual({ names: ['Reeve'], all: false })
  })

  it('ignores an inline span that opens before a fence-like run', () => {
    expect(resolve('`@tars`')).toEqual({ names: [], all: false })
  })
})

describe('resolveBodyMentions reports the @all marker', () => {
  it('reports @all without expanding it: the caller snapshots the roster', () => {
    expect(resolve('@all, standup in ten')).toEqual({ names: [], all: true })
    expect(resolve('@All')).toEqual({ names: [], all: true })
  })

  it('keeps the marker out of prose and code', () => {
    expect(resolve('@allowlist and @all2')).toEqual({ names: [], all: false })
    expect(resolve('`@all`')).toEqual({ names: [], all: false })
    expect(resolve('```\n@all\n```')).toEqual({ names: [], all: false })
    // The marker ends on the same word boundary a handle does: letters and
    // digits continue a word, punctuation ends it.
    expect(resolve('@all-hands, please read')).toEqual({ names: [], all: true })
  })

  it('reports a named Member and the marker together', () => {
    expect(resolve('@tars @all')).toEqual({ names: ['tars'], all: true })
  })

  it('reports the marker even when the roster resolves no one', () => {
    expect(resolve('@all', [candidate('sender')])).toEqual({ names: [], all: true })
  })
})

describe('shared mention-body fixture: Host delivery', () => {
  // The Client spec reads the same fixture through its own rendering and
  // preview: both sides must answer every nasty body identically.
  const candidates = MENTION_BODY_FIXTURE.roster.map(handle => candidate(handle))
  for (const { body, handles, all } of MENTION_BODY_FIXTURE.cases) {
    it(`resolves ${JSON.stringify(body)}`, () => {
      const resolution = resolveBodyMentions(body, candidates, SENDER)
      const names = resolution.memberIds.map(id => (id as string).replace(/^member:/, ''))
      expect([...names].sort()).toEqual([...handles].sort())
      expect(resolution.all).toBe(all)
      expect(hasAllMarker(body)).toBe(all)
    })
  }
})

describe('scanBodyHandles reports ranges in body order', () => {
  it('locates each call with its canonical handle and span', () => {
    const candidates = MENTION_BODY_FIXTURE.roster.map(handle => candidate(handle))
    expect(scanBodyHandles('@tars then @Reeve', candidates.map(candidate => candidate.handle))).toEqual([
      { handle: 'tars', start: 0, end: 5 },
      { handle: 'Reeve', start: 11, end: 17 },
    ])
  })

  it('reads nothing outside the roster and nothing inside code', () => {
    expect(scanBodyHandles('`@tars` and @stranger', ['tars'])).toEqual([])
  })
})
