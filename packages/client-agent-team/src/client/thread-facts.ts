import type { AgentTeamMemberId, AgentTeamMessage, AgentTeamThreadFact } from '@contexera/dsh-agent-team/types'
import { mentionNameOf, mentionNamesOf, type MentionHandle } from './team-formatters.ts'

/** Identity of one rendered fact: a Message or an activity, each with its own durable ref. */
export type ThreadFactKey = string

export function factKey(fact: AgentTeamThreadFact): ThreadFactKey {
  return fact.kind === 'message' ? `message:${fact.message.messageRef}` : `activity:${fact.activity.activityRef}`
}

/** Wrap a Message as the `message` fact the timeline renders, with the mentions its send recorded. */
export function messageFact(message: AgentTeamMessage, mentions: readonly AgentTeamMemberId[] = []): AgentTeamThreadFact {
  return { kind: 'message', sequence: message.sequence, message, mentions, occurredAt: message.occurredAt }
}

/** Union of fact groups in sequence order; a later duplicate of one ref replaces the earlier copy. */
export function mergeFacts(...groups: readonly (readonly AgentTeamThreadFact[])[]): readonly AgentTeamThreadFact[] {
  const byKey = new Map<ThreadFactKey, AgentTeamThreadFact>()
  for (const group of groups) for (const fact of group) byKey.set(factKey(fact), fact)
  return [...byKey.values()].sort((left, right) => left.sequence - right.sequence)
}

export function minSequence(facts: readonly AgentTeamThreadFact[]): number | undefined {
  return facts.reduce<number | undefined>((minimum, fact) => minimum === undefined ? fact.sequence : Math.min(minimum, fact.sequence), undefined)
}

/**
 * A fact owns its mention array, so the rendered name list is cached against
 * that array. Every roster refresh replaces the handles map with a fresh Map of
 * identical content, so the cache compares the resolved names rather than the
 * map identity: identity stays stable while the names are unchanged, which is
 * what keeps a memoized row from re-rendering on every refresh.
 */
const mentionNamesCache = new WeakMap<readonly AgentTeamMemberId[], readonly MentionHandle[]>()

export function stableMentionNames(mentions: readonly AgentTeamMemberId[], handles: ReadonlyMap<AgentTeamMemberId, string>, humanName: string): readonly MentionHandle[] {
  const names = mentionNamesOf(mentions, handles, humanName)
  const cached = mentionNamesCache.get(mentions)
  if (cached !== undefined && cached.length === names.length && cached.every((name, index) => mentionNameOf(name) === mentionNameOf(names[index]!))) return cached
  mentionNamesCache.set(mentions, names)
  return names
}
