import type { AgentTeamActivity, AgentTeamClaim, AgentTeamClientMemberStatus, AgentTeamMemberDiagnosticClass, AgentTeamMemberId, AgentTeamTask, AgentTeamTaskRef, AgentTeamThreadRef } from '@contexera/dsh-agent-team/types'
import { resolveBodyMentions, scanBodyHandles } from '@contexera/dsh-agent-team/mentions'
import type { TeamKey } from './locales.ts'
import type { TeamConversationProps } from './slots.ts'
import type { TeamStateDotState } from './TeamStateDot.tsx'

export function formatTaskStatus(status: AgentTeamTask['status'], t: TeamConversationProps['t']): string {
  return t(({
    todo: 'taskStatusTodo',
    in_progress: 'taskStatusInProgress',
    in_review: 'taskStatusInReview',
    done: 'taskStatusDone',
    closed: 'taskStatusClosed',
  } as const)[status])
}

const RISK_CLASS_KEYS = {
  'session-refused': ['riskClassSessionRefused', 'riskSessionRefused'],
  'session-unreadable': ['riskClassSessionUnreadable', 'riskSessionUnreadable'],
  'preset-composition': ['riskClassPresetComposition', 'riskPresetComposition'],
  'rollover': ['riskClassRollover', 'riskRollover'],
  'runtime': ['riskClassRuntime', 'riskRuntime'],
  'activation': ['riskClassActivation', 'riskActivation'],
  'capability-apply': ['riskClassCapabilityApply', 'riskCapabilityApply'],
} as const satisfies Record<AgentTeamMemberDiagnosticClass, readonly [TeamKey, TeamKey]>

/**
 * The two localized halves of one runtime-risk statement: the class label names
 * what kind of problem this is, and the sentence key states it of the Member
 * (it keeps its `{member}` placeholder so the caller supplies the handle). The
 * Host's own diagnostic stays English and belongs in the row's title, so the
 * visible line reads in the interface language.
 */
export function formatRiskClass(
  status: Pick<AgentTeamClientMemberStatus, 'diagnostic'>,
  t: TeamConversationProps['t'],
): { readonly label: string, readonly sentenceKey: TeamKey } {
  const [labelKey, sentenceKey] = RISK_CLASS_KEYS[status.diagnostic?.class ?? 'runtime']
  return { label: t(labelKey), sentenceKey }
}

/**
 * The first sentence of a Host diagnostic: risk rows read one line, and the
 * Host writes the reason as its first sentence with recovery context after it.
 * A terminator the Host used mid-sentence becomes a full stop so the clamped
 * line reads as a sentence; the untouched text stays in the row's title.
 */
export function firstSentence(detail: string): string {
  const trimmed = detail.trim()
  const end = trimmed.search(/[.。;；]/)
  if (end === -1) return trimmed
  return trimmed[end] === '.' || trimmed[end] === '。' ? trimmed.slice(0, end + 1) : `${trimmed.slice(0, end)}.`}

/**
 * Status indicator for a Task status, the dot every Task surface renders.
 * Active states map to StateDot variants; every status renders a dot so they
 * share one shape language — todo is a hollow ring (not started), closed a
 * quiet gray dot (archived).
 */
export function taskStatusDot(status: AgentTeamTask['status']): TeamStateDotState {
  return ({ todo: 'todo', in_progress: 'ongoing', in_review: 'warning', done: 'done', closed: 'quiet' } as const)[status]
}

export function formatTaskTitle(body: string): string {
  const firstLine = body.split('\n', 1)[0]?.trim() ?? ''
  return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine
}

export function memberHue(memberId: string): number {
  let hash = 0
  for (let index = 0; index < memberId.length; index += 1) hash = (hash * 31 + memberId.charCodeAt(index)) % 360
  return hash
}

export interface RefSegment {
  readonly text: string
  readonly ref?: string
}

// Full UUIDs and abbreviated forms (prefix plus the first 6+ hex chars, with
// or without the original hyphens) both match; resolution decides whether an
// abbreviation is real, so unresolvable matches stay plain text. Member refs
// match the same shape; the roster map decides whether one names a member.
const BRANDED_REF_PATTERN = /\b(task|project|channel|thread|member):{1,2}[0-9a-f]{6,}(?:-[0-9a-f]{1,})*\b/gi

/**
 * Canonical form of one matched ref: models occasionally double the colon or
 * uppercase the UUID when citing a ref in prose, while Host lookups and
 * navigation only accept the lowercase single-colon ref the ledger mints.
 * Bodies written before Projects were renamed cite them as `channel:`.
 */
function canonicalBrandedRef(match: string): string {
  return match.replace('::', ':').toLowerCase().replace(/^channel:/, 'project:')
}

/** Splits a literal run into plain and canonical branded-ref segments; prose colons never linkify. */
export function splitBrandedRefs(text: string): readonly RefSegment[] {
  const segments: RefSegment[] = []
  let cursor = 0
  for (const match of text.matchAll(BRANDED_REF_PATTERN)) {
    const start = match.index ?? 0
    if (start > cursor) segments.push({ text: text.slice(cursor, start) })
    segments.push({ text: match[0], ref: canonicalBrandedRef(match[0]) })
    cursor = start + match[0].length
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return segments
}

/**
 * Whether one string's whole content is exactly one branded ref. A code span
 * like this is the model styling a ref as an identifier, not publishing code,
 * so the Markdown pass may linkify it; anything larger stays literal.
 */
export function isSingleBrandedRef(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  const matches = [...trimmed.matchAll(BRANDED_REF_PATTERN)]
  return matches.length === 1 && matches[0]![0] === trimmed
}

export interface MentionSegment {
  readonly text: string
  readonly mention: boolean
  readonly name?: string
}

/**
 * The Human's durable Member id. It is the ledger's own identity for the
 * reader (`AGENT_TEAM_HUMAN_MEMBER_ID` on the Host), spelled here because a
 * client package must not import a Host package. The same literal is already
 * the reference for the historic handle below and for draft mention
 * resolution, so there is one spelling in this package, not three.
 */
export const HUMAN_MEMBER_ID = 'member:human' as AgentTeamMemberId

export const HUMAN_HISTORIC_HANDLE = 'human'

/** Every handle that addresses the Human reader, so the mention scan and chips agree on who the reader is. */
export function humanMentionHandle(humanName: string): MentionHandle {
  return humanName.toLowerCase() === HUMAN_HISTORIC_HANDLE ? humanName : { name: humanName, also: [HUMAN_HISTORIC_HANDLE] }
}

/**
 * Whether one Message's body itself spells a handle of the reader: the same
 * shared scan the mention chips render by, so the card's "mentioned you" says
 * what the words say. This is deliberately not the delivery set — a Thread
 * delivers to its Human without ever naming them, and a delivery is not a
 * mention, so a delivery-based answer would light the card on Messages that
 * never addressed the reader.
 *
 * The question is about the reader and nobody else, so the scan runs over the
 * reader's own handles rather than over the Message's mentioned Members: naming
 * someone else is the one thing that must never raise this. An unknown reader
 * is named by nothing.
 */
export function bodyMentionsHuman(body: string, humanName: string | undefined): boolean {
  if (humanName === undefined) return false
  return scanBodyHandles(body, mentionHandlesOf(humanMentionHandle(humanName)).handles).length > 0
}

/**
 * One mentioned Member as a Message renders them: the display name the seat
 * prints, plus every older handle that still addresses the same person. A
 * rename must not orphan the mentions written before it — the bodies say
 * `@human`, the roster says the new name, and both are the Human.
 */
export type MentionHandle = string | { readonly name: string; readonly also: readonly string[] }

function mentionHandlesOf(mention: MentionHandle): { name: string; handles: readonly string[] } {
  return typeof mention === 'string' ? { name: mention, handles: [mention] } : { name: mention.name, handles: [mention.name, ...mention.also] }
}

export function mentionNameOf(mention: MentionHandle): string {
  return typeof mention === 'string' ? mention : mention.name
}

/**
 * Locate one Message's delivered mention names inside its literal body. Matching
 * is the shared Host delivery scan — an authored `@`, case-insensitive on Unicode
 * word boundaries, longest handle first, code quoted rather than called — so a chip
 * never lands where delivery would not reach. A chip names the person by their
 * current name, the way member refs do: a body that wrote an older handle of a
 * renamed Human chips as the name they answer to today. A person whose entry
 * matched through any of their handles counts as matched, so the fallback row
 * never repeats someone already chipped inline; names absent from the body come
 * back unmatched so the consumer can append them as a fallback chip row.
 */
export function splitMentionNames(text: string, mentions: readonly MentionHandle[]): { segments: MentionSegment[]; unmatched: readonly string[] } {
  if (mentions.length === 0) return { segments: [{ text, mention: false }], unmatched: [] }
  const entries = mentions.map(mentionHandlesOf)
  const segments: MentionSegment[] = []
  const matched = new Set<string>()
  let cursor = 0
  for (const match of scanBodyHandles(text, entries.flatMap(entry => entry.handles))) {
    if (match.start > cursor) segments.push({ text: text.slice(cursor, match.start), mention: false })
    const handle = match.handle.toLowerCase()
    const owner = entries.find(entry => entry.handles.some(candidate => candidate.toLowerCase() === handle))
    // The scan hands back the entry's own spelling; only an entry matched
    // through another handle prints the name it answers to today.
    const printed = owner === undefined || owner.name.toLowerCase() === handle ? match.handle : owner.name
    segments.push({ text: `@${printed}`, mention: true, name: printed })
    if (owner !== undefined) matched.add(owner.name.toLowerCase())
    cursor = match.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), mention: false })
  return { segments, unmatched: entries.map(entry => entry.name).filter(name => !matched.has(name.toLowerCase())) }
}

/** Uses the shared delivery scan so the composer agrees with the Host on what a draft mentions. */
export function containsMention(body: string, handle: string): boolean {
  return scanBodyHandles(body, [handle]).length > 0
}

/**
* Member ids a draft notifies by text alone, previewing the Host's body mention resolution.
* A written handle counts whenever its Member can still take a Message (offline included).
* Preview-only: only picked recipients travel as explicit recipients.
*/
export function mentionedMemberIds(body: string, members: readonly AgentTeamClientMemberStatus[]): readonly AgentTeamMemberId[] {
  const candidates = members
    .filter(status => status.member.state !== 'inactive' && status.member.state !== 'archived')
    .map(status => ({ memberId: status.member.memberId, handle: status.member.handle }))
  // The draft's author is the Human reader, and a Message never mentions its
  // own author: resolving with that sender drops a self-call exactly where
  // delivery would.
  return resolveBodyMentions(body, candidates, HUMAN_MEMBER_ID).memberIds
}

/**
* Canonical chip handles for one Message's structured mention refs. The Human is not in
* `members()`, so the caller passes their profile name; the historic `human` alias keeps
* pre-rename bodies chipping inline.
*/
export function mentionNamesOf(
  mentions: readonly AgentTeamMemberId[],
  handles: ReadonlyMap<AgentTeamMemberId, string>,
  humanName: string,
): MentionHandle[] {
  return mentions
    .map((memberId): MentionHandle | undefined => memberId === HUMAN_MEMBER_ID
      ? humanMentionHandle(humanName)
      : handles.get(memberId))
    .filter((name): name is MentionHandle => name !== undefined)
}

export function claimersLabel(owners: ReadonlyArray<{ readonly name: string }>, t: TeamConversationProps['t']): string {
  return t('claimers', { names: owners.map(owner => `@${owner.name}`).join(', ') })
}

/**
* Mention names still worth a trailing chip: not the reader (chipped in place or unnamed),
* and not an author the quote line already names. An unresolved quote names nobody.
*/
export function unshownMentionNames(
  names: readonly string[],
  readerName: string | undefined,
  quoteAuthor: string | undefined,
): readonly string[] {
  return names.filter(name => name !== readerName && name !== quoteAuthor)
}

const MARKDOWN_BLOCK_CONSTRUCT = /(^|\n)[ \t]{0,3}(?:#{1,6}[ \t]|>[ \t]|[-*+][ \t]|\d+[.)][ \t])|^[ \t]*\|.+\|/m
const MARKDOWN_INLINE_CONSTRUCT = /[`*_[\]!]|~~~|```/

/**
* Whether an Agent body survives literal rendering unchanged. Only such bodies may use inline
* mention chips; richer Markdown cannot interleave them and keeps the trailing chip row.
*/
export function isPlainTextBody(text: string): boolean {
  return !(MARKDOWN_BLOCK_CONSTRUCT.test(text) || MARKDOWN_INLINE_CONSTRUCT.test(text))
}

const pad = (value: number): string => String(value).padStart(2, '0')

export function formatAbsoluteTime(occurredAt: string): string {
  const at = new Date(occurredAt)
  if (Number.isNaN(at.getTime())) return ''
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export function formatMessageTime(occurredAt: string, now = new Date()): string {
  const at = new Date(occurredAt)
  if (Number.isNaN(at.getTime())) return ''
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  if (sameDay) return `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const absolute = formatAbsoluteTime(occurredAt)
  return at.getFullYear() === now.getFullYear() ? absolute.slice(5) : absolute
}

/**
* Clock-only label with no date: the continuation row's 28px time seat cannot fit the date
* forms of `formatMessageTime`. The date is shown by the run's identity line and day separator.
*/
export function formatClockTime(occurredAt: string): string {
  const at = new Date(occurredAt)
  if (Number.isNaN(at.getTime())) return ''
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** Calendar days between two instants in the viewer's zone, so "yesterday" means locally. */
function calendarDayDelta(at: Date, now: Date): number {
  const midnight = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  return Math.round((midnight(now) - midnight(at)) / 86_400_000)
}

/**
* Recency label for an Inbox row, shared with the Project feed entry line. Today is a bare
* clock time; yesterday keeps its word; older entries use the Message date form.
*/
export function formatInboxTime(occurredAt: string, t: TeamConversationProps['t'], now = new Date()): string {
  const at = new Date(occurredAt)
  if (Number.isNaN(at.getTime())) return ''
  const days = calendarDayDelta(at, now)
  if (days === 0) return `${pad(at.getHours())}:${pad(at.getMinutes())}`
  if (days === 1) return `${t('inboxTimeYesterday')} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  return formatMessageTime(occurredAt, now)
}

export function formatActivity(activity: AgentTeamActivity, options: {
  readonly t: TeamConversationProps['t']
  readonly actorName: (memberId: AgentTeamMemberId) => string
  readonly claims: readonly AgentTeamClaim[]
}): string {
  const actor = options.actorName(activity.actor)
  if (activity.kind === 'accept') {
    return activity.completedClaimRefs !== undefined && activity.completedClaimRefs.length > 0
      ? options.t('activityAcceptedWithClaims', { actor, count: activity.completedClaimRefs.length })
      : options.t('activityAccepted', { actor })
  }
  if (activity.kind === 'promote') return options.t('activityPromoted', { actor })
  if (activity.kind === 'close') return options.t('activityClosed', { actor })
  if (activity.kind === 'reopen') return options.t('activityReopened', { actor })
  const direction = 'claimRef' in activity
    ? options.claims.find(claim => claim.claimRef === activity.claimRef)?.direction ?? options.t('claims')
    : options.t('claims')
  if (activity.kind === 'claim') return options.t('activityClaimed', { actor, direction })
  if (activity.kind === 'done') return options.t('activityClaimDone', { actor, direction })
  if (activity.kind === 'release') return options.t('activityClaimReleased', { actor, direction })
  if (activity.kind === 'claims_released') return options.t('activityClaimsReleased', { actor, count: activity.claimRefs.length })
  throw new Error(`unknown Team Activity kind: ${(activity as { kind: string }).kind}`)
}

export function stripAttachmentLines(body: string): string {
  return body.replaceAll(/^\[attachment\] .*$(\n)?/gm, '').replace(/\n+$/, '')
}

/** Bodies past this length render clamped; derived from the body alone so every surface agrees. */
export const MESSAGE_COLLAPSE_CHARS = 600

export function shouldClampMessage(displayBody: string): boolean {
  return displayBody.length > MESSAGE_COLLAPSE_CHARS
}

export type MessageBodyRender = 'inline' | 'literal' | 'markdown'

export interface PlannedMessageBody {
  readonly displayBody: string
  /** Rich Agent Markdown: only such bodies get the post-render chipify pass. */
  readonly richAgentBody: boolean
  readonly render: MessageBodyRender
  readonly inline?: ReturnType<typeof splitMentionNames>
  readonly fallbackNames: readonly string[]
  /** Non-Task branded refs for the trailing fallback row; rich Agent bodies keep the legacy row. */
  readonly fallbackRefs: readonly string[]
  readonly taskRefs: readonly AgentTeamTaskRef[]
  readonly threadRefs: readonly AgentTeamThreadRef[]
}

/**
* Decide how one Message body renders. Rich Agent Markdown keeps unmatched mentions and
* non-Task refs in the trailing fallback row; surfaces without ref navigation render literally.
*/
export function planMessageBody(body: string, options: {
  readonly human: boolean
  readonly mentionNames?: readonly MentionHandle[]
  readonly canOpenRefs: boolean
}): PlannedMessageBody {
  const stripped = stripAttachmentLines(body)
  const displayBody = stripped === '' ? body : stripped
  const richAgentBody = !options.human && !isPlainTextBody(displayBody)
  const inline = (options.human || isPlainTextBody(displayBody)) && options.mentionNames !== undefined && options.mentionNames.length > 0
    ? splitMentionNames(displayBody, options.mentionNames)
    : undefined
  const fallbackNames = inline !== undefined ? inline.unmatched
    : richAgentBody && options.canOpenRefs && options.mentionNames !== undefined
      // Rich Markdown with ref navigation chips mentions in place from the
      // rendered DOM (renderResolvedMarkdownText), so the names it painted must
      // not also be listed below: the reader would see the same @name twice.
      ? splitMentionNames(displayBody, options.mentionNames).unmatched
      : (options.mentionNames ?? []).map(mentionNameOf)
  const refs = splitBrandedRefs(displayBody).flatMap(segment => segment.ref === undefined ? [] : [segment.ref])
  const render: MessageBodyRender = inline !== undefined ? 'inline'
    : options.human || (options.canOpenRefs && !richAgentBody && refs.length > 0) ? 'literal'
    : 'markdown'
  return {
    displayBody,
    richAgentBody,
    render,
    ...(inline === undefined ? {} : { inline }),
    fallbackNames,
    // Rich Markdown refs are painted at their authored position after the
    // Markdown primitive has built its DOM; do not duplicate them in the
    // trailing chip row when navigation is available.
    fallbackRefs: richAgentBody && !options.canOpenRefs ? refs : [],
    taskRefs: options.canOpenRefs && !richAgentBody
      ? refs.filter(ref => ref.startsWith('task:')).map(ref => ref as AgentTeamTaskRef)
      : [],
    threadRefs: options.canOpenRefs && !richAgentBody
      ? refs.filter(ref => ref.startsWith('thread:')).map(ref => ref as AgentTeamThreadRef)
      : [],
  }
}
