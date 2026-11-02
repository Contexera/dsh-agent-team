/**
 * The nasty-body fixture both sides of the mention contract read: the Host
 * delivery scan (`resolveBodyMentions`) and the Client rendering/preview
 * (`splitMentionNames`, `containsAllMention`) must agree on every case —
 * same delivered handle set, same `@all` answer. `handles` are canonical
 * roster spellings, sorted for stable comparison.
 */
export interface MentionBodyCase {
  readonly body: string
  readonly handles: readonly string[]
  readonly all: boolean
}

export interface MentionBodyFixture {
  readonly roster: readonly string[]
  readonly cases: readonly MentionBodyCase[]
}

function body(value: string, handles: readonly string[], all = false): MentionBodyCase {
  return Object.freeze({ body: value, handles: Object.freeze(handles), all })
}

export const MENTION_BODY_FIXTURE: MentionBodyFixture = Object.freeze({
  roster: Object.freeze(['Reeve', 'reeves', 'tars']),
  cases: Object.freeze([
    body('@tars, please take this', ['tars']),
    // A bare name is prose, never a call.
    body('tars, please take this', []),
    // Case-insensitive, and one Member comes back once however often called.
    body('@REEVE and @reeve', ['Reeve']),
    // Fenced code is quoted, prose beside it still calls.
    body('Talk about it:\n```\n@tars @Reeve\n```\n@reeves takes it', ['reeves']),
    body('Quote `@tars` and then call @reeves', ['reeves']),
    // A doubled @ is not an authored mention.
    body('@@tars is not a call, @tars is', ['tars']),
    // The marker is case-insensitive like every handle.
    body('@ALL, standup in ten', [], true),
    body('`@all` stays quoted', []),
    // Word boundaries hold against addresses and longer words.
    body('mail@tars.example is not a call', []),
    body('see @tarsish and @tars2', []),
    // Punctuation opens and ends a handle.
    body('(@reeves)', ['reeves']),
    // CJK prose separates no words with spaces, so the neighbouring text is the
    // boundary itself: a call may start and end right against it.
    body('请@tars 看一下这个', ['tars']),
    body('请@tars看一下', ['tars']),
    // Longest handle first in both directions at different positions.
    body('@reeves first, @reeve second', ['reeves', 'Reeve']),
    body('@tars-like work', ['tars']),
    body('@all-hands, please read', [], true),
    // A named Member and the marker travel together.
    body('@tars @all', ['tars'], true),
    body('no names here', []),
  ]),
})
