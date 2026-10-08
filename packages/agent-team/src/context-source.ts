/**
 * Producer-attributed message sources for Agent Team context management.
 *
 * Both sources ride ordinary `UserMessage`s under this plugin's own
 * producer kind with the `snapshot` context form — Session format V4 admits
 * exactly that shape and refuses the retired `{ kind: 'plugin', plugin: … }`
 * wrapper at write time. See `docs/dsh-release-compatibility.md`
 * § "Session message sources".
 *
 * Everything the Host needs to read back therefore rides the admitted payload
 * slots: the handoff envelope and the checkpoint correlation both travel as
 * named {@link ContextSnapshotSection} contributions, distinguished by their
 * stable section names. Sections are the format's designed slot for structured
 * producer payload, and they render as named contributions on any
 * snapshot-aware surface.
 *
 * The validators below are the single place that recognizes these messages, so
 * callers never match on localized body text. Writing them belongs to the
 * context-continuity engine's codec, which Team constructs with its own plugin
 * identity and prose (`context-continuity-host.ts`): one writer, so the
 * envelope Team reads back can never drift from the one it wrote.
 * @module @contexera/dsh-agent-team/context-source
 */

import type { ContextFormed, ContextSnapshotSection, MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'

/** The producer kind attributing every Agent Team message source. */
export const AGENT_TEAM_PLUGIN_ID = '@wowyuarm/dsh-agent-team'

/**
 * The kind the Harness's V4 read-time conversion renames this plugin's
 * released V3 `plugin` sources into: `plugin:` + the producer id, with the
 * `plugin` key dropped and every payload field (`form`, `sections`,
 * `summary`) preserved. History read through the new line carries exactly
 * this shape, so the read side recognizes both identities below.
 */
export const AGENT_TEAM_V3_RENAMED_KIND = `plugin:${AGENT_TEAM_PLUGIN_ID}`

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The kind this plugin writes now; V4 admission requires a producer-owned kind. */
    [AGENT_TEAM_PLUGIN_ID]: { kind: typeof AGENT_TEAM_PLUGIN_ID } & ContextFormed
    /** The converted shape of this plugin's released V3 history; read-side only. */
    [AGENT_TEAM_V3_RENAMED_KIND]: { kind: typeof AGENT_TEAM_V3_RENAMED_KIND } & ContextFormed
  }
}

/** The source shapes carrying this plugin's attribution: its current kind and the read-time conversion of its V3 history. */
export type AgentTeamMessageSource = Extract<MessageSource, { kind: typeof AGENT_TEAM_PLUGIN_ID | typeof AGENT_TEAM_V3_RENAMED_KIND }>

/** The kind the read-time conversion renames one producer's released V3 sources into. */
export const v3RenamedSourceKind = <const P extends string>(producer: P): `plugin:${P}` => `plugin:${producer}`

/**
 * Whether one source kind is a producer's own: the kind it writes now and the
 * read-time conversion of its released V3 history. Both identities are matched
 * by exact kind equality — never by a `plugin:` prefix test, which would claim
 * third-party producers' rows as that producer's facts.
 */
export function matchesProducerKind(kind: string | undefined, producer: string): boolean {
  return kind === producer || kind === v3RenamedSourceKind(producer)
}

/** Whether one message source carries this plugin's own attribution. */
export function isAgentTeamSource(source: MessageSource): source is AgentTeamMessageSource {
  return matchesProducerKind(source.kind, AGENT_TEAM_PLUGIN_ID)
}

/**
 * Whether one source kind carries this plugin's attribution, for call sites
 * whose sources arrive untyped.
 */
export function isAgentTeamSourceKind(kind: string | undefined): boolean {
  return matchesProducerKind(kind, AGENT_TEAM_PLUGIN_ID)
}

/** Handoff snapshot section name carrying the model-authored prose. */
export const HANDOFF_SECTION_NAME = 'HANDOFF'

/** Stable section name marking a checkpoint continuation and carrying its ref. */
export const CHECKPOINT_SECTION_NAME = 'Checkpoint'

/**
 * The rollover handoff envelope: the model-authored prose plus the verifiable
 * Host facts, all as named snapshot contributions.
 */
export interface AgentTeamContextHandoff {
  /** The Member's Session before this rollover. */
  readonly previousSessionId: string
  /** The rollover generation this handoff opened. */
  readonly newSessionId: string
  /** Why the rollover happened. */
  readonly trigger: 'model' | 'pressure'
  /** Seq of the successful `context_rollover` tool result in the previous Session log. */
  readonly handoffEventSeq: number
  /** The checkpoint a return was seeded from; absent on a fresh rollover. */
  readonly checkpointRef?: string
  /** Workspace paths the handoff called out as relevant. */
  readonly relatedFiles?: readonly string[]
  /** Named contributions, starting with the model-authored handoff prose. */
  readonly sections: readonly ContextSnapshotSection[]
}

/**
 * Read one message's snapshot sections when it is this plugin's own snapshot.
 * @param message - candidate user message.
 * @returns the sections, or `undefined` when another producer owns the message.
 */
function ownSections(message: UserMessage): readonly ContextSnapshotSection[] | undefined {
  const source = message.source
  if (!isAgentTeamSource(source)) return undefined
  if (source.form !== 'snapshot') return undefined
  return source.sections
}

/** The text of one named section, or undefined when it is absent. */
function sectionText(sections: readonly ContextSnapshotSection[], name: string): string | undefined {
  return sections.find(section => section.name === name)?.text
}

/**
 * Decode the `Related files` section. The Host writes the exact path array as
 * JSON, which round-trips every path a file system admits — including one
 * containing a comma, which the `', '`-joined form this replaced could not.
 * Sections written before that encoding are still read; the legacy split is a
 * read-side accommodation for old generations, never a write path.
 */
function parseRelatedFiles(text: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed) && parsed.every(path => typeof path === 'string' && path.length > 0)) {
      return parsed as readonly string[]
    }
  } catch {
    // Not JSON: the section predates the JSON encoding.
  }
  return text.split(', ').filter(path => path.length > 0)
}

/**
 * The rollover handoff one message carries, when it is one.
 * @param message - candidate user message.
 * @returns the envelope, or `undefined` when the message is not a handoff.
 */
export function handoffOf(message: UserMessage): AgentTeamContextHandoff | undefined {
  const sections = ownSections(message)
  if (sections === undefined) return undefined
  const handoff = sectionText(sections, HANDOFF_SECTION_NAME)
  if (handoff === undefined) return undefined
  const previousSessionId = sectionText(sections, HANDOFF_PREVIOUS_SESSION)
  const newSessionId = sectionText(sections, HANDOFF_NEW_SESSION)
  const trigger = sectionText(sections, HANDOFF_TRIGGER)
  const handoffEventSeq = sectionText(sections, HANDOFF_EVENT_SEQ)
  if (previousSessionId === undefined || newSessionId === undefined) return undefined
  if (trigger !== 'model' && trigger !== 'pressure') return undefined
  const seq = Number(handoffEventSeq)
  if (handoffEventSeq === undefined || !Number.isSafeInteger(seq)) return undefined
  const checkpointRef = sectionText(sections, HANDOFF_CHECKPOINT)
  const relatedFiles = sectionText(sections, HANDOFF_RELATED_FILES)
  return {
    previousSessionId,
    newSessionId,
    trigger,
    handoffEventSeq: seq,
    ...(checkpointRef === undefined ? {} : { checkpointRef }),
    ...(relatedFiles === undefined ? {} : { relatedFiles: parseRelatedFiles(relatedFiles) }),
    sections,
  }
}

/**
 * The checkpoint ref one continuation notice carries, when the message is one.
 * @param message - candidate user message.
 * @returns the checkpoint ref, or `undefined` when the message is not a continuation.
 */
export function continuationCheckpointRefOf(message: UserMessage): string | undefined {
  const sections = ownSections(message)
  if (sections === undefined || sections.length !== 1) return undefined
  const ref = sectionText(sections, CHECKPOINT_SECTION_NAME)
  return ref === undefined || ref.length === 0 ? undefined : ref
}

/** Whether one user message is a rollover handoff snapshot. */
export function isHandoffMessage(message: UserMessage): boolean {
  return handoffOf(message) !== undefined
}

/** Whether one user message is a checkpoint continuation, optionally for one checkpoint. */
export function isCheckpointContinuationMessage(message: UserMessage, checkpointRef?: string): boolean {
  const ref = continuationCheckpointRefOf(message)
  return ref !== undefined && (checkpointRef === undefined || ref === checkpointRef)
}

/**
 * Whether one message carries a rollover-handoff or checkpoint-continuation
 * envelope. Ordinary Team notices share this plugin's attribution, so callers
 * that replace rederived notices must exclude these two families explicitly.
 */
export function isAgentTeamContextSource(message: UserMessage): boolean {
  return isHandoffMessage(message) || isCheckpointContinuationMessage(message)
}

/** Envelope section names; stable, because they are read back from the log.
 * One shared vocabulary for writer and reader — no drift between the shape
 * published at rollover and the shape the projection folds back. */
export const HANDOFF_PREVIOUS_SESSION = 'Previous session'
export const HANDOFF_NEW_SESSION = 'New session'
export const HANDOFF_TRIGGER = 'Trigger'
export const HANDOFF_EVENT_SEQ = 'Handoff event seq'
export const HANDOFF_CHECKPOINT = 'Continued from checkpoint'
export const HANDOFF_RELATED_FILES = 'Related files'
