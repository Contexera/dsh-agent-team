/**
 * Team's writer for the two durable context envelopes it reads back: the
 * rollover handoff snapshot and the quiet checkpoint continuation.
 *
 * The section order, the JSON encoding of the related-file paths, and the two
 * prose lines are frozen: logs written by earlier generations (including the
 * retired external engine's own codec) are read back through them. Nothing here
 * writes a handoff any more — no current flow produces one — but the shape is
 * still what the projection and the codec's tests read old logs through.
 * Recognition belongs to `context-source.ts`; this module only produces what it
 * recognizes.
 * @module @contexera/dsh-agent-team/context-codec
 */
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import {
  AGENT_TEAM_PLUGIN_ID,
  CHECKPOINT_SECTION_NAME,
  HANDOFF_CHECKPOINT,
  HANDOFF_EVENT_SEQ,
  HANDOFF_NEW_SESSION,
  HANDOFF_PREVIOUS_SESSION,
  HANDOFF_RELATED_FILES,
  HANDOFF_SECTION_NAME,
  HANDOFF_TRIGGER,
  continuationCheckpointRefOf,
  handoffOf,
  isAgentTeamContextSource,
  isCheckpointContinuationMessage,
  isHandoffMessage,
  type AgentTeamContextHandoff,
} from './context-source.ts'

export const HANDOFF_INTRO = 'Context handoff: you are continuing as the same Team Member in a fresh private context.'

export const HANDOFF_VERIFY_NOTE = 'Your handoff from the previous context follows. Verify external state before relying on it; a context change never rolls back files, processes, Team facts, or remote side effects.'

export const CHECKPOINT_CONTINUATION_TEXT = 'A context checkpoint was recorded at the end of the previous turn. Continue the work you were doing.'

export interface TeamHandoffInput {
  readonly handoff: string
  readonly previousSessionId: string
  readonly newSessionId: string
  readonly trigger: 'model' | 'pressure'
  readonly handoffEventSeq: number
  readonly checkpointRef?: string
  readonly relatedFiles?: readonly { readonly path: string; readonly reason?: string }[]
}

function handoffBody(input: TeamHandoffInput): string {
  const lines = [
    HANDOFF_INTRO,
    `Previous session: ${input.previousSessionId}`,
    `New session: ${input.newSessionId}`,
    `Trigger: ${input.trigger}`,
    ...(input.checkpointRef === undefined ? [] : [`Continued from checkpoint: ${input.checkpointRef}`]),
    ...(input.relatedFiles === undefined || input.relatedFiles.length === 0 ? [] : [`Related files: ${input.relatedFiles.map(file => file.path).join(', ')}`]),
    '',
    HANDOFF_VERIFY_NOTE,
    '',
    input.handoff,
  ]
  return lines.join('\n')
}

export class TeamContextCodec {
  get pluginId(): string {
    return AGENT_TEAM_PLUGIN_ID
  }

  createHandoffMessage(input: TeamHandoffInput): UserMessage {
    return createUserMessage({
      content: [{ type: 'text', text: handoffBody(input) }],
      source: {
        kind: AGENT_TEAM_PLUGIN_ID,
        form: 'snapshot',
        sections: [
          { name: HANDOFF_SECTION_NAME, text: input.handoff },
          { name: HANDOFF_PREVIOUS_SESSION, text: input.previousSessionId },
          { name: HANDOFF_NEW_SESSION, text: input.newSessionId },
          { name: HANDOFF_TRIGGER, text: input.trigger },
          { name: HANDOFF_EVENT_SEQ, text: String(input.handoffEventSeq) },
          ...(input.checkpointRef === undefined ? [] : [{ name: HANDOFF_CHECKPOINT, text: input.checkpointRef }]),
          ...(input.relatedFiles === undefined || input.relatedFiles.length === 0
            ? []
            : [{ name: HANDOFF_RELATED_FILES, text: JSON.stringify(input.relatedFiles.map(file => file.path)) }]),
        ],
      },
    })
  }

  createCheckpointContinuationMessage(checkpointRef: string): UserMessage {
    return createUserMessage({
      content: [{ type: 'text', text: CHECKPOINT_CONTINUATION_TEXT }],
      source: {
        kind: AGENT_TEAM_PLUGIN_ID,
        form: 'snapshot',
        sections: [{ name: CHECKPOINT_SECTION_NAME, text: checkpointRef }],
      },
    })
  }

  handoffOf(message: UserMessage): AgentTeamContextHandoff | undefined {
    return handoffOf(message)
  }

  continuationCheckpointRefOf(message: UserMessage): string | undefined {
    return continuationCheckpointRefOf(message)
  }

  isHandoffMessage(message: UserMessage): boolean {
    return isHandoffMessage(message)
  }

  isCheckpointContinuationMessage(message: UserMessage, checkpointRef?: string): boolean {
    return isCheckpointContinuationMessage(message, checkpointRef)
  }

  isContextSource(message: UserMessage): boolean {
    return isAgentTeamContextSource(message)
  }
}

export const TEAM_CONTEXT_CODEC = new TeamContextCodec()
