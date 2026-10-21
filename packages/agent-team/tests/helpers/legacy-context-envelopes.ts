/**
 * The retired rollover handoff envelope, byte-for-byte as the earlier builds
 * wrote it.
 *
 * Nothing in this build produces a handoff — a swap leaves no mark on what the
 * successor is told — so this writer lives in the test tree rather than in the
 * shipped codec. The fold, the source recognizer, and the format-admission
 * fence still read old logs through it, and the golden bytes are what those
 * logs contain.
 */
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import {
  AGENT_TEAM_PLUGIN_ID,
  HANDOFF_CHECKPOINT,
  HANDOFF_EVENT_SEQ,
  HANDOFF_NEW_SESSION,
  HANDOFF_PREVIOUS_SESSION,
  HANDOFF_RELATED_FILES,
  HANDOFF_SECTION_NAME,
  HANDOFF_TRIGGER,
} from '../../src/context-source.ts'

export const HANDOFF_INTRO = 'Context handoff: you are continuing as the same Team Member in a fresh private context.'

export const HANDOFF_VERIFY_NOTE = 'Your handoff from the previous context follows. Verify external state before relying on it; a context change never rolls back files, processes, Team facts, or remote side effects.'

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

export function createHandoffMessage(input: TeamHandoffInput): UserMessage {
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
