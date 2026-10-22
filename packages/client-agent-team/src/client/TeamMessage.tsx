import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { MarkdownText, Modal, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentTeamChannelRef, AgentTeamMemberId, AgentTeamMessageAttachment, AgentTeamMessageRef, AgentTeamTaskRef, AgentTeamThreadRef } from '@contexera/dsh-agent-team/types'
import type { TeamConversationProps } from './slots.ts'
import type { ResolvedMemberRef } from './refs.ts'
import { cachedAttachmentDataUrl, formatByteSize, loadAttachmentDataUrl } from './attachment-preview.ts'
import { cachedResolvedTaskRef, resolveUnknownTaskRefs, useResolvedTaskRefVersion, type ResolvedTaskRef } from './refs.ts'
import { cachedResolvedThreadRef, resolveUnknownThreadRefs, useResolvedThreadRefVersion, type ResolvedThreadRef } from './refs.ts'
import { bodyMentionsHuman, formatAbsoluteTime, formatClockTime, formatMessageTime, isSingleBrandedRef, memberHue, planMessageBody, shouldClampMessage, splitBrandedRefs, splitMentionNames, unshownMentionNames, type MentionHandle, type PlannedMessageBody } from './team-formatters.ts'
import { useAvatarImage } from './avatar-image.ts'
import css from './conversation.module.css'

export interface TeamMessageProps {
  readonly senderName: string
  readonly memberId: AgentTeamMemberId
  /** Human input stays literal text; Agent output renders as Markdown. */
  readonly human: boolean
  readonly body: string
  readonly occurredAt?: string
  /** Structured mention handles of this Message; the only names that render as chips. */
  readonly mentionNames?: readonly MentionHandle[]
  readonly senderTitle?: string
  /** Continuation of one same-sender run: suppress repeated identity chrome. */
  readonly grouped?: boolean
  /** The reader's own name, so the trailing fallback row never repeats it; the body chips it in place. */
  readonly readerName?: string
  /** Resolved quote context from the Host, never the body, so a quote cannot drift from the Message it points at. */
  readonly replyTo?: { readonly senderName: string; readonly excerpt: string; readonly messageRef: AgentTeamMessageRef } | undefined
  /**
   * Opens the Message as the composer's quote target; the ref travels as the argument so one identity-stable
   * callback serves every row and the memo holds. Absent surfaces offer no quote action.
   */
  readonly onReply?: ((messageRef: AgentTeamMessageRef) => void) | undefined
  /** Jumps to the Message this one quotes, which travels as the argument; absent keeps the quote inert. */
  readonly onOpenReplyTo?: ((messageRef: AgentTeamMessageRef) => void) | undefined
  /** Stable identity of this Message: the anchor a quote line jumps to. */
  readonly messageRef?: AgentTeamMessageRef
  readonly replyTarget?: boolean
  readonly replyFlash?: boolean
  /** Continuation rows show their time in the empty avatar seat; only the Thread asks for it. */
  readonly showGroupedTime?: boolean
  /** Actions open on a surface without hover; the hosting page owns the flag so only one row holds it. */
  readonly cardOpen?: boolean
  /** Opens or closes this row's actions; absent surfaces offer none. */
  readonly onToggleCard?: ((messageRef: AgentTeamMessageRef) => void) | undefined
  /**
   * Whether the surface offers row actions (copy, the reader's mention notice). `inherit` offers them when a quote is
   * offered; `always` offers them without one; `never` withholds them.
   */
  readonly rowActions?: 'inherit' | 'always' | 'never'
  readonly attachments?: readonly AgentTeamMessageAttachment[] | undefined
  /** The Human's uploaded avatar; absent or undecodable bytes draw the initial on the tinted chip. */
  readonly avatarUrl?: string | undefined
  /** Cache readback for thumbnails; absent on surfaces without the remotes. */
  readonly loadAttachment?: TeamConversationProps['getAttachment'] | undefined
  readonly t?: TeamConversationProps['t'] | undefined
  /** Resolve a branded ref found in the body; absent surfaces render refs as plain text. */
  readonly onOpenRef?: ((ref: string) => void) | undefined
  /** Host lookup turning task refs into human-facing numbers; absent keeps raw refs. */
  readonly onResolveTaskRefs?: ((taskRefs: readonly AgentTeamTaskRef[]) => Promise<readonly ResolvedTaskRef[]>) | undefined
  /** Host lookup turning thread refs into titled chips; absent keeps raw refs. */
  readonly onResolveThreadRefs?: ((threadRefs: readonly AgentTeamThreadRef[]) => Promise<readonly ResolvedThreadRef[]>) | undefined
  /** Roster name for one authored channel ref; absent or unknown keeps plain text. */
  readonly channelNameOf?: ((ref: AgentTeamChannelRef) => string | undefined) | undefined
  /** Roster facts for one authored member ref; absent or unknown keeps plain text. */
  readonly memberOf?: ((ref: AgentTeamMemberId) => ResolvedMemberRef | undefined) | undefined
  /** Agent-card session jump for member chips; absent renders them as plain text. */
  readonly onOpenMemberSession?: ((sessionId: SessionId) => void) | undefined
  readonly children?: ReactNode
}

/**
 * One chat message row. Memoized: the Task-ref subscription lives inside this component, so a skipped render never
 * detaches it. Callers must keep per-render props (mention names, ref callbacks) identity-stable.
 */
export const TeamMessage = memo(function TeamMessage({ senderName, memberId, human, avatarUrl, body, occurredAt, mentionNames, senderTitle, grouped, readerName, replyTo, onReply, onOpenReplyTo, rowActions, messageRef, replyTarget, replyFlash, showGroupedTime, cardOpen, onToggleCard, attachments, loadAttachment, t, onOpenRef, onResolveTaskRefs, onResolveThreadRefs, channelNameOf, memberOf, onOpenMemberSession, children }: TeamMessageProps) {
  const avatarStyle = human ? undefined : { '--team-avatar-hue': memberHue(memberId) } as CSSProperties
  const identityImage = useAvatarImage(human ? avatarUrl : undefined)
  // The stored body carries machine-facing `[attachment] <path>` prompt lines; the attachment strip renders from message metadata instead.
  // Literal bodies chip mentions inline; rich Markdown keeps unmatched structured mentions in the trailing row.
  const plan = planMessageBody(body, { human, ...(mentionNames === undefined ? {} : { mentionNames }), canOpenRefs: onOpenRef !== undefined })
  // The chip names what the body names, not what the Host delivered to: a Thread reaches its Human in every row.
  const mentionedInBody = bodyMentionsHuman(body, readerName)
  // The fallback row omits the reader's own name and the author the quote line already names.
  const quoteAuthor = replyTo === undefined ? undefined : replyTo.senderName.replace(/^@/, '')
  const fallbackNames = unshownMentionNames(plan.fallbackNames, readerName, quoteAuthor)
  const displayBody = plan.displayBody
  const { markdownRef, markdownLabels, taskLabel, renderRefs } = useResolvedBodyRefs({
    plan,
    mentionNames,
    onOpenRef,
    onOpenMemberSession,
    onResolveTaskRefs,
    onResolveThreadRefs,
    channelNameOf,
    memberOf,
    t,
  })
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => { setCopied(false) }, 1200)
    return () => { clearTimeout(timer) }
  }, [copied])
  // Copy the stored Markdown, not the rendered text.
  const copyMessage = useCallback((): void => {
    void writeClipboard(body).then(accepted => { if (accepted) setCopied(true) })
  }, [body])
  // A touch surface has no hover, so a tap opens the card; a press on the card itself never toggles it.
  const toggleCard = useCallback((event: MouseEvent<HTMLElement>): void => {
    if (onToggleCard === undefined || messageRef === undefined) return
    const target = event.target
    if (target instanceof Element && target.closest('[data-message-card], button, a[href]') !== null) return
    onToggleCard(messageRef)
  }, [messageRef, onToggleCard])
  const clampable = shouldClampMessage(displayBody)
  const clamped = clampable && !expanded
  const bodyNode = plan.render === 'inline' && plan.inline !== undefined
    ? <div className={css.messageText}>
        {plan.inline.segments.map((segment, index) => segment.mention
          ? <span key={index} className={css.mention} data-mention-human={readerName !== undefined && segment.name === readerName ? '' : undefined}>{segment.text}</span>
          : <Fragment key={index}>{renderRefs(segment.text)}</Fragment>)}
      </div>
    : plan.render === 'literal'
      ? <div className={css.messageText}>{onOpenRef === undefined ? displayBody : renderRefs(displayBody)}</div>
      : <div ref={markdownRef} className={css.messageMarkdown}><MarkdownText key={`${displayBody}:${onOpenRef === undefined ? 'literal' : 'refs'}`} text={displayBody} labels={markdownLabels} /></div>
  return (
    <article className={css.messageRow} data-human={human || undefined} data-grouped={grouped || undefined} data-mentions-me={mentionedInBody || undefined} data-message-ref={messageRef} data-replying-to={replyTarget || undefined} data-reply-flash={replyFlash || undefined} data-card-open={cardOpen || undefined} onClick={onToggleCard === undefined ? undefined : toggleCard}>
      {identityImage.image.kind === 'initial'
        ? <div className={css.messageIdentity} data-avatar="initial" style={avatarStyle} aria-hidden="true">{senderName.replace('@', '').slice(0, 1).toUpperCase()}</div>
        : <img className={css.messageIdentityImage} data-avatar="image" src={identityImage.image.src} alt="" aria-hidden="true" onError={identityImage.failed} />}
      {/* A continuation row shows time of day only in the avatar seat (34px, no clip); the date lives on the run's identity line and the day separator. */}
      {grouped === true && showGroupedTime === true && occurredAt !== undefined && <span className={css.gutterTime} data-gutter-time="" aria-hidden="true" title={formatAbsoluteTime(occurredAt)}>{formatClockTime(occurredAt)}</span>}
      <div className={css.messageBody}>
        {!grouped && (
          <div className={css.nameRow}>
            <strong {...(senderTitle === undefined ? {} : { title: senderTitle })}>{senderName}</strong>
            {occurredAt !== undefined && <span className={css.messageTime}>{formatMessageTime(occurredAt)}</span>}
          </div>
        )}
        {/* The quote is one muted line that jumps to the original, so a long parent is never pasted twice. */}
        {replyTo !== undefined && (onOpenReplyTo === undefined
          ? <span className={css.quoteLine} data-quote-line="">
              <span className={css.quoteLineBar} aria-hidden="true" />
              <span className={css.quoteLineBody}>
                <span className={css.quoteLineAuthor}>{replyTo.senderName}</span>
                <span className={css.quoteLineText}>{replyTo.excerpt}</span>
              </span>
            </span>
          : <button type="button" className={css.quoteLine} data-quote-line="" onClick={() => { onOpenReplyTo(replyTo.messageRef) }}
              title={t?.('openRepliedMessage') ?? 'Go to the quoted message'}>
              <span className={css.quoteLineBar} aria-hidden="true" />
              <span className={css.quoteLineBody}>
                <span className={css.quoteLineAuthor}>{replyTo.senderName}</span>
                <span className={css.quoteLineText}>{replyTo.excerpt}</span>
              </span>
            </button>)}
        {/* The wrapper stays mounted for every clampable body and only swaps its class: remounting the Markdown subtree would wipe
            the post-render ref/mention chips. It also carries data-document, the same >600-character rule that folds the body. */}
        {clampable ? <div data-document="" className={clamped ? css.messageClamp : undefined}>{bodyNode}</div> : bodyNode}
        {clampable && (
          <button type="button" className={css.messageExpand} data-message-expand="true" aria-expanded={expanded} onClick={() => { setExpanded(value => !value) }}>
            {expanded ? (t?.('collapseMessage') ?? 'Show less') : (t?.('expandMessage') ?? 'Show more')}
          </button>
        )}
        {(fallbackNames.length > 0 || plan.fallbackRefs.length > 0) && (
          <div className={css.mentionsRow}>
            {fallbackNames.map(name => <span key={name} className={css.mention}>@{name}</span>)}
            {plan.fallbackRefs.map(ref => {
              const resolved = cachedResolvedTaskRef(ref as AgentTeamTaskRef)
              const label = resolved !== undefined && ref.startsWith('task:') ? taskLabel(resolved.taskNumber) : ref
              return <button key={ref} type="button" className={css.refLink} title={ref} onClick={() => { onOpenRef!(ref) }}>{label}</button>
            })}
          </div>
        )}
        {attachments !== undefined && attachments.length > 0 && <TeamAttachmentStrip
          attachments={attachments}
          {...(loadAttachment === undefined ? {} : { loadAttachment })}
          {...(t === undefined ? {} : { t })}
        />}
        {/* A feed's entry line is the row's own chrome, outside any per-message surface. */}
        {children}
      </div>
      {/* The actions float beside the Message, shown only under the pointer or caret; the card is the only raised surface in a row. */}
      {(rowActions !== 'never' && (rowActions === 'always' || onReply !== undefined)) && <div className={css.messageCard} data-message-card="">
        {mentionedInBody && <span className={css.cardMention} data-mentions-you="">{t?.('mentionsMe') ?? 'Mentioned you'}</span>}
        <button type="button" className={css.cardAction} data-copy-message="" onClick={copyMessage}
          aria-label={t?.('copyMessageLabel') ?? 'Copy this message'}>
          {copied ? (t?.('copiedMessage') ?? 'Copied') : (t?.('copyMessage') ?? 'Copy')}
        </button>
        {onReply !== undefined && <button type="button" className={css.cardAction} data-quote-message="" onClick={() => { if (messageRef !== undefined) onReply(messageRef) }}
          aria-label={t?.('replyToMessage') ?? 'Quote this message'}>
          {t?.('replyMessage') ?? 'Quote'}
        </button>}
        <span className={css.cardStatus} role="status" aria-live="polite">{copied ? (t?.('copiedMessage') ?? 'Copied') : ''}</span>
      </div>}
    </article>
  )
})

/** Kept inside the component so the Task-ref subscription of a memoized row never detaches. */
function useResolvedBodyRefs({ plan, mentionNames, onOpenRef, onOpenMemberSession, onResolveTaskRefs, onResolveThreadRefs, channelNameOf, memberOf, t }: {
  readonly plan: PlannedMessageBody
  readonly mentionNames?: readonly MentionHandle[] | undefined
  readonly onOpenRef: ((ref: string) => void) | undefined
  readonly onOpenMemberSession: ((sessionId: SessionId) => void) | undefined
  readonly onResolveTaskRefs: ((taskRefs: readonly AgentTeamTaskRef[]) => Promise<readonly ResolvedTaskRef[]>) | undefined
  readonly onResolveThreadRefs: ((threadRefs: readonly AgentTeamThreadRef[]) => Promise<readonly ResolvedThreadRef[]>) | undefined
  readonly channelNameOf: ((ref: AgentTeamChannelRef) => string | undefined) | undefined
  readonly memberOf: ((ref: AgentTeamMemberId) => ResolvedMemberRef | undefined) | undefined
  readonly t: TeamConversationProps['t'] | undefined
}): {
  readonly markdownRef: RefObject<HTMLDivElement>
  readonly markdownLabels: MarkdownLabels
  readonly taskLabel: (taskNumber: number) => string
  readonly renderRefs: (text: string) => ReactNode
} {
  const { richAgentBody } = plan
  const taskRefVersion = useResolvedTaskRefVersion()
  const threadRefVersion = useResolvedThreadRefVersion()
  const bodyTaskRefs = plan.taskRefs
  const bodyTaskRefKey = bodyTaskRefs.join(',')
  const bodyThreadRefs = plan.threadRefs
  const bodyThreadRefKey = bodyThreadRefs.join(',')
  useEffect(() => {
    if (onResolveTaskRefs !== undefined && bodyTaskRefKey !== '') void resolveUnknownTaskRefs(bodyTaskRefs, onResolveTaskRefs)
    if (onResolveThreadRefs !== undefined && bodyThreadRefKey !== '') void resolveUnknownThreadRefs(bodyThreadRefs, onResolveThreadRefs)
  }, [onResolveTaskRefs, onResolveThreadRefs, bodyTaskRefKey, bodyThreadRefKey, taskRefVersion, threadRefVersion])
  const taskLabel = useCallback((taskNumber: number): string => t?.('taskLabel', { number: taskNumber }) ?? `Task #${taskNumber}`, [t])
  // Unresolvable refs never reach this label; they stay plain text (see renderRefs).
  const threadChipLabel = useCallback((title: string): string => {
    const base = t?.('threadLabel') ?? 'Thread'
    return title === '' ? base : `${base} · ${title}`
  }, [t])
  // Member chips use a handle, deliberately distinct from `@mention` chips, which notify.
  const channelChipLabel = useCallback((name: string): string => t?.('channelLabel', { name }) ?? `Channel · ${name}`, [t])
  const memberChipLabel = useCallback((name: string): string => t?.('memberLabel', { name }) ?? `Member · @${name}`, [t])
  // Stable per locale revision: a fresh object per render would rebuild the component table every chunk.
  const markdownLabels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t?.('copyCode') ?? 'Copy', copiedLabel: t?.('copiedCode') ?? 'Copied' },
    footnotes: t?.('markdownFootnotes') ?? 'Footnotes',
  }), [t])
  const markdownRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const root = markdownRef.current
    if (!richAgentBody || root === null || onOpenRef === undefined) return
    const textNodes = markdownProseTextNodes(root)
    const styledRefCodes = markdownStyledRefCodeElements(root)
    const taskRefs = [...new Set([...textNodes.map(node => node.data), ...styledRefCodes.map(code => code.textContent ?? '')]
      .flatMap(text => splitBrandedRefs(text)
        .filter(segment => segment.ref?.startsWith('task:') === true)
        .map(segment => segment.ref as AgentTeamTaskRef)))]
    const threadRefs = [...new Set([...textNodes.map(node => node.data), ...styledRefCodes.map(code => code.textContent ?? '')]
      .flatMap(text => splitBrandedRefs(text)
        .filter(segment => segment.ref?.startsWith('thread:') === true)
        .map(segment => segment.ref as AgentTeamThreadRef)))]
    if (onResolveTaskRefs !== undefined && taskRefs.length > 0) void resolveUnknownTaskRefs(taskRefs, onResolveTaskRefs)
    if (onResolveThreadRefs !== undefined && threadRefs.length > 0) void resolveUnknownThreadRefs(threadRefs, onResolveThreadRefs)
    for (const code of styledRefCodes) renderResolvedMarkdownCodeRef(code, taskLabel, threadChipLabel, channelChipLabel, memberChipLabel, channelNameOf, memberOf)
    for (const node of textNodes) renderResolvedMarkdownText(node, mentionNames ?? [], taskLabel, threadChipLabel, channelChipLabel, memberChipLabel, channelNameOf, memberOf)
    for (const button of root.querySelectorAll<HTMLButtonElement>('button[data-task-ref]')) {
      const taskRef = button.dataset.taskRef as AgentTeamTaskRef | undefined
      const hit = taskRef === undefined ? undefined : cachedResolvedTaskRef(taskRef)
      if (taskRef !== undefined && hit !== undefined) button.textContent = taskLabel(hit.taskNumber)
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('button[data-thread-ref]')) {
      const threadRef = button.dataset.threadRef as AgentTeamThreadRef | undefined
      const hit = threadRef === undefined ? undefined : cachedResolvedThreadRef(threadRef)
      if (threadRef !== undefined && hit !== undefined) button.textContent = threadChipLabel(hit.title)
    }
  }, [richAgentBody, onOpenRef, onResolveTaskRefs, onResolveThreadRefs, taskRefVersion, threadRefVersion, taskLabel, threadChipLabel, channelChipLabel, memberChipLabel, channelNameOf, memberOf, mentionNames])
  useEffect(() => {
    const root = markdownRef.current
    if (!richAgentBody || root === null || onOpenRef === undefined) return
    const openTask = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest('button[data-ref], button[data-task-ref], button[data-thread-ref], button[data-member-session]')
      if (button === null || !root.contains(button)) return
      if (button instanceof HTMLElement) {
        const sessionId = button.dataset.memberSession as SessionId | undefined
        if (sessionId !== undefined) {
          onOpenMemberSession?.(sessionId)
          return
        }
        const ref = button.dataset.ref ?? button.dataset.taskRef ?? button.dataset.threadRef
        if (ref !== undefined) onOpenRef(ref)
      }
    }
    root.addEventListener('click', openTask)
    return () => { root.removeEventListener('click', openTask) }
  }, [richAgentBody, onOpenRef, onOpenMemberSession])
  const renderRefs = useCallback((text: string): ReactNode =>
    renderRefsFromText(text, onOpenRef, onOpenMemberSession, taskLabel, threadChipLabel, channelChipLabel, memberChipLabel, channelNameOf, memberOf),
  [onOpenRef, onOpenMemberSession, taskLabel, threadChipLabel, channelChipLabel, memberChipLabel, channelNameOf, memberOf])
  return { markdownRef, markdownLabels, taskLabel, renderRefs }
}

function markdownProseTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement
    if (parent === null) continue
    if (parent.closest('code, pre, a, button') !== null) continue
    // Skip text already chipped by an earlier pass, or each rerun wraps another chip around the last.
    if (css.mention !== undefined && parent.closest(`[class~="${css.mention}"]`) !== null) continue
    nodes.push(node as Text)
  }
  return nodes
}

/** Code spans whose entire content is one branded ref: model styling around a ref, not code. */
function markdownStyledRefCodeElements(root: HTMLElement): HTMLElement[] {
  const elements: HTMLElement[] = []
  for (const code of root.querySelectorAll<HTMLElement>('code')) {
    if (code.closest('pre, a, button') !== null) continue
    if (!isSingleBrandedRef(code.textContent ?? '')) continue
    elements.push(code)
  }
  return elements
}

function resolvedTaskRefButton(taskRef: AgentTeamTaskRef, label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  if (css.refLink !== undefined) button.className = css.refLink
  button.dataset.taskRef = taskRef
  button.title = taskRef
  button.textContent = label
  return button
}

function resolvedThreadRefButton(threadRef: AgentTeamThreadRef, label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  if (css.refLink !== undefined) button.className = css.refLink
  button.dataset.threadRef = threadRef
  button.title = threadRef
  button.textContent = label
  return button
}

function resolvedChannelRefButton(channelRef: AgentTeamChannelRef, label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  if (css.refLink !== undefined) button.className = css.refLink
  button.dataset.ref = channelRef
  button.title = channelRef
  button.textContent = label
  return button
}

/** Openable Members jump to their session through the delegated click listener; others get an inert span. */
function resolvedMemberRefChip(memberRef: AgentTeamMemberId, label: string, sessionId?: SessionId): HTMLElement {
  if (sessionId === undefined) {
    const span = document.createElement('span')
    span.title = memberRef
    span.textContent = label
    return span
  }
  const button = document.createElement('button')
  button.type = 'button'
  if (css.refLink !== undefined) button.className = css.refLink
  button.dataset.memberSession = sessionId
  button.title = memberRef
  button.textContent = label
  return button
}

function renderResolvedMarkdownCodeRef(code: HTMLElement, taskLabel: (taskNumber: number) => string, threadChipLabel: (title: string) => string, channelChipLabel: (name: string) => string, memberChipLabel: (name: string) => string, channelNameOf: ((ref: AgentTeamChannelRef) => string | undefined) | undefined, memberOf: ((ref: AgentTeamMemberId) => ResolvedMemberRef | undefined) | undefined): void {
  const segments = splitBrandedRefs((code.textContent ?? '').trim())
  const segment = segments.length === 1 ? segments[0]! : undefined
  const ref = segment?.ref
  if (ref === undefined) return
  // Task and Thread refs need Host resolution; Channel and Member refs resolve against loaded rosters; unknown refs stay plain text.
  if (ref.startsWith('task:')) {
    const resolved = cachedResolvedTaskRef(ref as AgentTeamTaskRef)
    if (resolved === undefined) return
    code.replaceWith(resolvedTaskRefButton(ref as AgentTeamTaskRef, taskLabel(resolved.taskNumber)))
    return
  }
  if (ref.startsWith('thread:')) {
    const resolved = cachedResolvedThreadRef(ref as AgentTeamThreadRef)
    if (resolved === undefined) return
    code.replaceWith(resolvedThreadRefButton(ref as AgentTeamThreadRef, threadChipLabel(resolved.title)))
    return
  }
  if (ref.startsWith('channel:')) {
    const name = channelNameOf?.(ref as AgentTeamChannelRef)
    if (name === undefined) return
    code.replaceWith(resolvedChannelRefButton(ref as AgentTeamChannelRef, channelChipLabel(name)))
    return
  }
  if (ref.startsWith('member:')) {
    const resolved = memberOf?.(ref as AgentTeamMemberId)
    if (resolved === undefined) return
    code.replaceWith(resolvedMemberRefChip(ref as AgentTeamMemberId, memberChipLabel(resolved.handle), resolved.openable ? resolved.sessionId : undefined))
  }
}

/** Replace resolved Task/Thread/Channel/Member refs and structured mention handles in one prose text node without changing Markdown structure. */
function renderResolvedMarkdownText(node: Text, mentionNames: readonly MentionHandle[], taskLabel: (taskNumber: number) => string, threadChipLabel: (title: string) => string, channelChipLabel: (name: string) => string, memberChipLabel: (name: string) => string, channelNameOf: ((ref: AgentTeamChannelRef) => string | undefined) | undefined, memberOf: ((ref: AgentTeamMemberId) => ResolvedMemberRef | undefined) | undefined): void {
  let changed = false
  const fragment = document.createDocumentFragment()
  for (const refSegment of splitBrandedRefs(node.data)) {
    if (refSegment.ref === undefined) {
      for (const mentionSegment of splitMentionNames(refSegment.text, mentionNames).segments) {
        if (!mentionSegment.mention) {
          fragment.append(mentionSegment.text)
          continue
        }
        changed = true
        const chip = document.createElement('span')
        if (css.mention !== undefined) chip.className = css.mention
        chip.textContent = mentionSegment.text
        fragment.append(chip)
      }
      continue
    }
    if (refSegment.ref.startsWith('task:')) {
      const resolved = cachedResolvedTaskRef(refSegment.ref as AgentTeamTaskRef)
      if (resolved === undefined) {
        fragment.append(refSegment.text)
        continue
      }
      changed = true
      fragment.append(resolvedTaskRefButton(refSegment.ref as AgentTeamTaskRef, taskLabel(resolved.taskNumber)))
    } else if (refSegment.ref.startsWith('thread:')) {
      const resolved = cachedResolvedThreadRef(refSegment.ref as AgentTeamThreadRef)
      if (resolved === undefined) {
        fragment.append(refSegment.text)
        continue
      }
      changed = true
      fragment.append(resolvedThreadRefButton(refSegment.ref as AgentTeamThreadRef, threadChipLabel(resolved.title)))
    } else if (refSegment.ref.startsWith('channel:')) {
      const name = channelNameOf?.(refSegment.ref as AgentTeamChannelRef)
      if (name === undefined) {
        fragment.append(refSegment.text)
        continue
      }
      changed = true
      fragment.append(resolvedChannelRefButton(refSegment.ref as AgentTeamChannelRef, channelChipLabel(name)))
    } else if (refSegment.ref.startsWith('member:')) {
      const resolved = memberOf?.(refSegment.ref as AgentTeamMemberId)
      if (resolved === undefined) {
        fragment.append(refSegment.text)
        continue
      }
      changed = true
      fragment.append(resolvedMemberRefChip(refSegment.ref as AgentTeamMemberId, memberChipLabel(resolved.handle), resolved.openable ? resolved.sessionId : undefined))
    } else {
      fragment.append(refSegment.text)
    }
  }
  if (changed) node.replaceWith(fragment)
}

function renderRefsFromText(text: string, onOpenRef: ((ref: string) => void) | undefined, onOpenMemberSession: ((sessionId: SessionId) => void) | undefined, taskLabel: (taskNumber: number) => string, threadChipLabel: (title: string) => string, channelChipLabel: (name: string) => string, memberChipLabel: (name: string) => string, channelNameOf: ((ref: AgentTeamChannelRef) => string | undefined) | undefined, memberOf: ((ref: AgentTeamMemberId) => ResolvedMemberRef | undefined) | undefined): ReactNode {
  if (onOpenRef === undefined) return text
  return splitBrandedRefs(text).map((segment, index) => {
    if (segment.ref === undefined) return <Fragment key={index}>{segment.text}</Fragment>
    if (segment.ref.startsWith('task:')) {
      const resolved = cachedResolvedTaskRef(segment.ref as AgentTeamTaskRef)
      if (resolved === undefined) return <Fragment key={index}>{segment.text}</Fragment>
      return <button key={index} type="button" className={css.refLink} title={segment.ref} onClick={() => { onOpenRef(segment.ref!) }}>{taskLabel(resolved.taskNumber)}</button>
    }
    if (segment.ref.startsWith('thread:')) {
      const resolved = cachedResolvedThreadRef(segment.ref as AgentTeamThreadRef)
      if (resolved === undefined) return <Fragment key={index}>{segment.text}</Fragment>
      return <button key={index} type="button" className={css.refLink} title={segment.ref} onClick={() => { onOpenRef(segment.ref!) }}>{threadChipLabel(resolved.title)}</button>
    }
    if (segment.ref.startsWith('channel:')) {
      const name = channelNameOf?.(segment.ref as AgentTeamChannelRef)
      if (name === undefined) return <Fragment key={index}>{segment.text}</Fragment>
      return <button key={index} type="button" className={css.refLink} title={segment.ref} onClick={() => { onOpenRef(segment.ref!) }}>{channelChipLabel(name)}</button>
    }
    if (segment.ref.startsWith('member:')) {
      const resolved = memberOf?.(segment.ref as AgentTeamMemberId)
      if (resolved === undefined) return <Fragment key={index}>{segment.text}</Fragment>
      // Known but not openable (suspended Members, the Human): a labelled span that promises no jump.
      if (!resolved.openable || resolved.sessionId === undefined || onOpenMemberSession === undefined) {
        return <span key={index} title={segment.ref}>{memberChipLabel(resolved.handle)}</span>
      }
      const sessionId = resolved.sessionId
      return <button key={index} type="button" className={css.refLink} title={segment.ref} onClick={() => { onOpenMemberSession(sessionId) }}>{memberChipLabel(resolved.handle)}</button>
    }
    return <Fragment key={index}>{segment.text}</Fragment>
  })
}

function TeamAttachmentStrip({ attachments, loadAttachment, t }: {
  readonly attachments: readonly AgentTeamMessageAttachment[]
  readonly loadAttachment?: TeamConversationProps['getAttachment'] | undefined
  readonly t?: TeamConversationProps['t'] | undefined
}) {
  const [zoomed, setZoomed] = useState<AgentTeamMessageAttachment>()
  return <div className={css.attachmentStrip}>
    {attachments.map(attachment => <TeamAttachment
      key={attachment.attachmentId}
      attachment={attachment}
      {...(loadAttachment === undefined ? {} : { loadAttachment })}
      {...(t === undefined ? {} : { t })}
      onZoom={setZoomed}
    />)}
    {zoomed !== undefined && <Modal open {...(css.attachmentModal === undefined ? {} : { className: css.attachmentModal })} title={zoomed.name} closeLabel={t?.('close') ?? 'Close'} onClose={() => { setZoomed(undefined) }}>
      <img className={css.attachmentZoom} src={cachedAttachmentDataUrl(zoomed.attachmentId) ?? undefined} alt={zoomed.name} />
    </Modal>}
  </div>
}

function TeamAttachment({ attachment, loadAttachment, t, onZoom }: {
  readonly attachment: AgentTeamMessageAttachment
  readonly loadAttachment?: TeamConversationProps['getAttachment'] | undefined
  readonly t?: TeamConversationProps['t'] | undefined
  readonly onZoom: (attachment: AgentTeamMessageAttachment) => void
}) {
  const wantsPreview = loadAttachment !== undefined && attachment.mediaType.startsWith('image/')
  const [dataUrl, setDataUrl] = useState<string | null | undefined>(wantsPreview ? cachedAttachmentDataUrl(attachment.attachmentId) : null)
  useEffect(() => {
    if (!wantsPreview || dataUrl !== undefined) return
    let mounted = true
    void loadAttachmentDataUrl(loadAttachment, attachment).then(url => { if (mounted) setDataUrl(url) })
    return () => { mounted = false }
  }, [wantsPreview, dataUrl, loadAttachment, attachment])
  const expired = t?.('attachmentExpired') ?? 'File no longer cached'
  if (wantsPreview && dataUrl !== null) {
    return <button type="button" className={css.attachmentThumb} aria-label={t?.('viewImage', { name: attachment.name }) ?? attachment.name} title={attachment.name} onClick={() => { onZoom(attachment) }}>
      <img src={dataUrl} alt={attachment.name} />
    </button>
  }
  return <span className={css.attachmentChip} title={wantsPreview ? expired : `${attachment.name} · ${formatByteSize(attachment.byteSize)}`}>
    <span className={css.attachmentChipName}>{attachment.name}</span>
    <span className={css.attachmentChipSize}>{wantsPreview ? expired : formatByteSize(attachment.byteSize)}</span>
  </span>
}
