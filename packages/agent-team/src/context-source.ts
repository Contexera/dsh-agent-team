/**
 * Producer-attributed message sources for Agent Team context management.
 *
 * Messages are ordinary `UserMessage`s under this plugin's producer kind with the `snapshot` context form, the shape Session format V4 admits. The handoff envelope and checkpoint correlation travel as named {@link ContextSnapshotSection}s. The validators here are the only place that recognizes these messages; callers never match on body text.
 * @module @contexera/dsh-agent-team/context-source
 */

import type { ContextFormed, ContextSnapshotSection, MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import type { TeamMessageSurface } from './surface-visibility.ts'

/** The producer kind attributing every Agent Team message source. */
export const AGENT_TEAM_PLUGIN_ID = '@wowyuarm/dsh-agent-team'

/** Kind the Harness's V4 read-time conversion gives this plugin's released V3 `plugin` sources: `plugin:` + producer id, payload fields preserved. */
export const AGENT_TEAM_V3_RENAMED_KIND = `plugin:${AGENT_TEAM_PLUGIN_ID}`

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The kind this plugin writes now; V4 admission requires a producer-owned kind. */
    [AGENT_TEAM_PLUGIN_ID]: { kind: typeof AGENT_TEAM_PLUGIN_ID; readonly teamFacts?: TeamMessageSurface } & ContextFormed
    /** The converted shape of this plugin's released V3 history; read-side only. */
    [AGENT_TEAM_V3_RENAMED_KIND]: { kind: typeof AGENT_TEAM_V3_RENAMED_KIND; readonly teamFacts?: TeamMessageSurface } & ContextFormed
  }
}

/** The source shapes carrying this plugin's attribution: its current kind and the read-time conversion of its V3 history. */
export type AgentTeamMessageSource = Extract<MessageSource, { kind: typeof AGENT_TEAM_PLUGIN_ID | typeof AGENT_TEAM_V3_RENAMED_KIND }>

/** The kind the read-time conversion renames one producer's released V3 sources into. */
export const v3RenamedSourceKind = <const P extends string>(producer: P): `plugin:${P}` => `plugin:${producer}`

/** Whether a source kind is a producer's own, by exact equality on its current or V3-converted kind; a `plugin:` prefix test would claim third-party rows. */
export function matchesProducerKind(kind: string | undefined, producer: string): boolean {
  return kind === producer || kind === v3RenamedSourceKind(producer)
}

/** Whether one message source carries this plugin's own attribution. */
export function isAgentTeamSource(source: MessageSource): source is AgentTeamMessageSource {
  return matchesProducerKind(source.kind, AGENT_TEAM_PLUGIN_ID)
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
  /** Seq of the retired rollover tool result in the previous Session log. */
  readonly handoffEventSeq: number
  /** The checkpoint a return was seeded from; absent on a fresh rollover. */
  readonly checkpointRef?: string
  /** Workspace paths the handoff called out as relevant. */
  readonly relatedFiles?: readonly string[]
  /** Named contributions, starting with the model-authored handoff prose. */
  readonly sections: readonly ContextSnapshotSection[]
}

/** This message's snapshot sections when it is this plugin's own snapshot, else `undefined`. */
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

/** Decodes the `Related files` section: a JSON path array (safe for paths containing commas), falling back to the legacy `', '`-joined split for older generations. */
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

/** The rollover handoff a message carries, or `undefined`. */
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

export function isAgentTeamContextSource(message: UserMessage): boolean {
  return isHandoffMessage(message) || isCheckpointContinuationMessage(message)
}

/** Envelope section names; stable because they are read back from the log. */
export const HANDOFF_PREVIOUS_SESSION = 'Previous session'
export const HANDOFF_NEW_SESSION = 'New session'
export const HANDOFF_TRIGGER = 'Trigger'
export const HANDOFF_EVENT_SEQ = 'Handoff event seq'
export const HANDOFF_CHECKPOINT = 'Continued from checkpoint'
export const HANDOFF_RELATED_FILES = 'Related files'
