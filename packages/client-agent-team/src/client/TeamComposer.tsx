import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, ClipboardEvent, KeyboardEvent } from 'react'
import type { AgentTeamClientMemberStatus, AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import { IconChecklistOutlineMedium, IconPaperclipOutlineMedium, IconSendOutlineRegular, Tooltip, useAnchoredMaxHeight, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import type { TeamDraftKey, TeamDraftStore } from './drafts.ts'
import { TeamPresenceDot } from './TeamPresenceDot.tsx'
import { allMentionMembers, containsAllMention, containsMention, mentionedMemberIds } from './team-formatters.ts'
import css from './composer.module.css'
import { formatByteSize } from './attachment-preview.ts'

interface MentionMatch {
  readonly start: number
  readonly end: number
  readonly query: string
}

/** One pickable row: the fixed @all expansion or one concrete member. */
type MentionOption = { readonly kind: 'all' } | { readonly kind: 'member'; readonly status: AgentTeamClientMemberStatus }

function findMention(draft: string, caret: number): MentionMatch | undefined {
  const beforeCaret = draft.slice(0, caret)
  if (beforeCaret.length === 0 || /\s/u.test(beforeCaret.at(-1) ?? '')) return undefined
  let tokenStart = beforeCaret.length
  while (tokenStart > 0 && !/\s/u.test(beforeCaret[tokenStart - 1]!)) tokenStart -= 1
  const at = beforeCaret.lastIndexOf('@')
  if (at < tokenStart) return undefined
  if (at > 0 && /[\p{L}\p{N}_]/u.test(beforeCaret[at - 1]!)) return undefined
  return { start: at, end: caret, query: beforeCaret.slice(at + 1) }
}

function mentionCandidates(members: readonly AgentTeamClientMemberStatus[], query: string): readonly AgentTeamClientMemberStatus[] {
  const normalized = query.toLocaleLowerCase()
  return members.filter(status => status.presence !== 'unavailable'
    && status.member.state !== 'inactive'
    && status.member.state !== 'archived'
    && status.member.handle.toLocaleLowerCase().startsWith(normalized))
}

/** Thread followers rank first: mentioning them delivers directly, while a non-follower enters the two-send invite flow. */
function rankMentionCandidates(candidates: readonly AgentTeamClientMemberStatus[], followers: ReadonlySet<AgentTeamMemberId> | undefined): readonly AgentTeamClientMemberStatus[] {
  if (followers === undefined || followers.size === 0) return candidates
  return [...candidates].sort((left, right) => Number(followers.has(right.member.memberId)) - Number(followers.has(left.member.memberId)))
}

/** One object URL per draft file; revoked when the draft is removed. */
const draftPreviewUrls = new WeakMap<File, string>()

function draftPreviewUrl(file: File): string | undefined {
  if (!file.type.startsWith('image/')) return undefined
  let url = draftPreviewUrls.get(file)
  if (url === undefined) {
    url = URL.createObjectURL(file)
    draftPreviewUrls.set(file, url)
  }
  return url
}

export function TeamComposer({ members, followerMemberIds, drafts, draftKey, pending, confirmation, error, onEdit, onSubmit, placeholder, pendingFiles, onFilesChange, replyTo, onCancelReply, asTask, onAsTaskChange, t }: {
  readonly members: readonly AgentTeamClientMemberStatus[]
  /** Current Thread followers; the Thread surface passes them so they rank above other candidates. */
  readonly followerMemberIds?: ReadonlySet<AgentTeamMemberId>
  /**
   * The draft cache this composer subscribes to: owning the subscription here
   * instead of in the hosting page keeps a keystroke from re-rendering the
   * timeline around it.
   */
  readonly drafts: TeamDraftStore
  readonly draftKey: TeamDraftKey
  readonly pending: boolean
  readonly confirmation?: string
  readonly error?: string
  /** The Human edited the draft: the hosting page drops its one-shot send state. */
  readonly onEdit?: () => void
  readonly onSubmit: () => void
  /** Conversation-specific prompt; the shared default fits Channel surfaces. */
  readonly placeholder?: string
  /** Upload-capable surfaces pass this to enable the "+" file picker; the reply path omits it. */
  readonly pendingFiles?: readonly File[]
  readonly onFilesChange?: (files: readonly File[]) => void
  /**
   * The Message this send answers. Present, the composer states what is being
   * answered and offers a way out, because a reply the reader cannot cancel is
   * a trap: the next Enter would quote something they had moved past.
   */
  readonly replyTo?: { readonly senderName: string; readonly excerpt: string } | undefined
  readonly onCancelReply?: (() => void) | undefined
  /** Channel-only: create a real Task with the top-level Message. Default off. */
  readonly asTask?: boolean
  readonly onAsTaskChange?: (asTask: boolean) => void
  readonly t: TeamConversationProps['t']
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLFormElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const activeOptionRef = useRef<HTMLButtonElement>(null)
  const composingRef = useRef(false)
  // The draft lives in the injected cache so a view switch or refresh does not
  // cost the half-written message. Subscribing here — not in the page that
  // hosts this composer — is what keeps a keystroke off the timeline.
  const { draft, recipients } = useSyncExternalStore(drafts.subscribe, () => drafts.getSnapshot(draftKey))
  const [mention, setMention] = useState<MentionMatch>()
  const [highlight, setHighlight] = useState(0)
  // @all is a composer-layer expansion of the same eligibility filter a
  // handle pick uses; the fixed row stays on top of the matching members.
  const memberCandidates = mention === undefined ? [] : rankMentionCandidates(mentionCandidates(members, mention.query), followerMemberIds)
  const options: readonly MentionOption[] = mention !== undefined && 'all'.startsWith(mention.query.toLocaleLowerCase())
    ? [{ kind: 'all' }, ...memberCandidates.map(status => ({ kind: 'member' as const, status }))]
    : memberCandidates.map(status => ({ kind: 'member' as const, status }))
  const menuOpen = mention !== undefined && options.length > 0
  const activeOption = options[highlight]
  const activeOptionKey = activeOption === undefined ? undefined : activeOption.kind === 'all' ? 'all' : activeOption.status.member.memberId
  const allCount = allMentionMembers(members).length
  const listId = 'team-mention-suggestions'
  const menuMaxHeight = useAnchoredMaxHeight(menuRef, 320, menuOpen ? draft : null)

  useDismissOnOutsidePointer(rootRef, menuOpen, open => { if (!open) setMention(undefined) })

  useLayoutEffect(() => {
    const input = inputRef.current
    if (input === null) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`
  }, [draft])

  useEffect(() => {
    if (mention === undefined || options.length === 0) {
      setHighlight(0)
      return
    }
    setHighlight(current => Math.min(current, options.length - 1))
  }, [mention, options.length])

  // The anchored height cap keeps long rosters scrollable; without this the
  // keyboard-highlighted row can stay hidden below the fold.
  useLayoutEffect(() => {
    if (!menuOpen) return
    // Optional call: jsdom renders the menu without a layout engine.
    activeOptionRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [menuOpen, highlight, activeOptionKey])

  // Match the resident DSH composer without stealing a later user choice: Team
  // data can load after navigation, so a dialog or another control may already
  // own focus by the time this composer appears.
  useEffect(() => {
    const active = document.activeElement
    if (active !== document.body && active?.closest('[aria-current="page"]') === null) return
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  // Confirmation settles after a read-only submission span. Restore focus in
  // case the browser moved it so the second Enter can confirm immediately.
  useEffect(() => {
    if (confirmation === undefined || pending) return
    inputRef.current?.focus({ preventScroll: true })
  }, [confirmation, pending])

  // Handle lookup for both directions of the same judgement: whether a picked
  // recipient is still spelled in the text, and which Members the text names.
  const memberHandles = new Map(members.map(status => [status.member.memberId, status.member.handle]))

  const pruneRecipients = (nextDraft: string): void => {
    // An @all marker stands for its expansion snapshot: the member handles it
    // stands for are not in the text, so text-based pruning must stand down.
    if (containsAllMention(nextDraft)) return
    const next = new Set([...recipients].filter(memberId => {
      const handle = memberHandles.get(memberId)
      return handle !== undefined && containsMention(nextDraft, handle)
    }))
    if (next.size !== recipients.size) drafts.writeRecipients(draftKey, next)
  }

  // Restored drafts may carry recipients that no longer match the text (or
  // unknown Members); converge on mount and on every state change so the
  // cached entry never stays stale — the same rule user edits already apply.
  // An unloaded roster must never judge recipients unknown.
  useEffect(() => {
    if (members.length === 0) return
    pruneRecipients(draft)
  }, [draft, recipients, members])

  // The notify row reports what the Host will resolve from this draft, not just
  // what the mention menu picked: an authored `@Handle` delivers exactly like a
  // pick, and `@all` stands for the menu's expansion.
  const notifiedIds = [...new Set([...recipients, ...mentionedMemberIds(draft, members)])].sort()

  const updateMention = (nextDraft: string, caret: number): void => {
    const match = findMention(nextDraft, caret)
    setMention(match)
    if (match === undefined) setHighlight(0)
  }

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const nextDraft = event.target.value
    drafts.writeDraft(draftKey, nextDraft)
    onEdit?.()
    pruneRecipients(nextDraft)
    updateMention(nextDraft, event.target.selectionStart ?? nextDraft.length)
  }

  // Both pick kinds share the same commit path: swap the text in, add the
  // recipients, close the menu, and restore the caret after focus.
  const commitMention = (nextDraft: string, nextCaret: number, nextRecipients: ReadonlySet<AgentTeamMemberId>): void => {
    drafts.writeDraft(draftKey, nextDraft)
    drafts.writeRecipients(draftKey, nextRecipients)
    onEdit?.()
    setMention(undefined)
    setHighlight(0)
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (input === null) return
      input.focus({ preventScroll: true })
      input.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const selectOption = (option: MentionOption): void => {
    if (mention === undefined) return
    if (option.kind === 'all') {
      // Expand at pick time: the recipients snapshot is every eligible member
      // a handle pick could reach at this moment.
      const nextDraft = `${draft.slice(0, mention.start)}@all ${draft.slice(mention.end)}`
      const nextCaret = mention.start + '@all '.length
      const nextRecipients = new Set(recipients)
      for (const status of allMentionMembers(members)) nextRecipients.add(status.member.memberId)
      commitMention(nextDraft, nextCaret, nextRecipients)
      return
    }
    const member = option.status
    const inserted = `@${member.member.handle} `
    const nextDraft = `${draft.slice(0, mention.start)}${inserted}${draft.slice(mention.end)}`
    const nextCaret = mention.start + inserted.length
    commitMention(nextDraft, nextCaret, new Set(recipients).add(member.member.memberId))
  }

  // Pasted files (screenshots, copies) join the same chips the "+" picker
  // fills; only a paste that carries files is intercepted, so plain text
  // keeps the browser's native insertion.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (pending || onFilesChange === undefined || pendingFiles === undefined) return
    const files = Array.from(event.clipboardData.items)
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length === 0) return
    event.preventDefault()
    onFilesChange([...pendingFiles, ...files])
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const composing = composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
    if (menuOpen && event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight(current => (current + 1) % options.length)
      return
    }
    if (menuOpen && event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight(current => (current - 1 + options.length) % options.length)
      return
    }
    if (event.key === 'Escape' && menuOpen) {
      event.preventDefault()
      setMention(undefined)
      return
    }
    // Tab accepts the highlighted candidate; Shift+Tab keeps default focus reversal.
    if (menuOpen && event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault()
      if (activeOption !== undefined) selectOption(activeOption)
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || composing || event.repeat) return
    if (menuOpen && activeOption !== undefined) {
      event.preventDefault()
      selectOption(activeOption)
      return
    }
    event.preventDefault()
    if (!pending && draft.trim() !== '') onSubmit()
  }

  return <form ref={rootRef} className={css.root} onSubmit={event => {
    event.preventDefault()
    if (!pending && draft.trim() !== '') onSubmit()
  }}>
    <div className={css.card} data-team-composer>
      {confirmation !== undefined && <p className={css.confirmation} role="status">{confirmation}</p>}
      {replyTo !== undefined && <div className={css.replyBanner} data-reply-banner="">
        <span className={css.replyBannerBar} aria-hidden="true" />
        <span className={css.replyBannerBody}>
          <span className={css.replyBannerAuthor}>{t('replyingTo', { name: replyTo.senderName })}</span>
          <span className={css.replyBannerText}>{replyTo.excerpt}</span>
        </span>
        {onCancelReply !== undefined && <button type="button" className={css.replyBannerCancel} onClick={onCancelReply}
          aria-label={t('cancelReply')} title={t('cancelReply')}>×</button>}
      </div>}
      <div className={css.inputArea}>
        {menuOpen && <div id={listId} ref={menuRef} className={css.mentionMenu} role="listbox" aria-label={t('mentionSuggestions')} style={{ maxHeight: menuMaxHeight }}>
          {options.map((option, index) => {
            const optionId = option.kind === 'all' ? `${listId}-all` : `${listId}-${option.status.member.memberId}`
            const selected = index === highlight
            return option.kind === 'all'
              ? <button
                  key="all"
                  id={optionId}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={css.mentionOption}
                  ref={selected ? activeOptionRef : undefined}
                  onMouseDown={event => { event.preventDefault() }}
                  onClick={() => { selectOption(option) }}
                >
                  <span className={css.mentionAllDot} aria-hidden="true" />
                  <span className={css.mentionName}>@all</span>
                  <span className={css.mentionDescription}>{t('mentionAll', { count: allCount })}</span>
                </button>
              : <button
                  key={option.status.member.memberId}
                  id={optionId}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={css.mentionOption}
                  ref={selected ? activeOptionRef : undefined}
                  onMouseDown={event => { event.preventDefault() }}
                  onClick={() => { selectOption(option) }}
                >
                  <TeamPresenceDot status={option.status} t={t} />
                  <span className={css.mentionName}>@{option.status.member.handle}</span>
                  <span className={css.mentionDescription}>{option.status.member.description}</span>
                </button>
          })}
        </div>}
        <textarea
          ref={inputRef}
          aria-label={t('messageDraft')}
          aria-autocomplete="list"
          aria-controls={menuOpen ? listId : undefined}
          aria-activedescendant={menuOpen && activeOption !== undefined ? activeOption.kind === 'all' ? `${listId}-all` : `${listId}-${activeOption.status.member.memberId}` : undefined}
          aria-expanded={menuOpen}
          value={draft}
          readOnly={pending}
          placeholder={placeholder ?? t('messagePlaceholder')}
          rows={1}
          onChange={onChange}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          onSelect={event => { updateMention(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length) }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { setTimeout(() => { composingRef.current = false }, 10) }}
        />
      </div>
      {notifiedIds.length > 0 && <p className={css.notifyRow} data-team-notify>{t('composerNotify', { ids: notifiedIds.map(memberId => `@${memberHandles.get(memberId) ?? memberId}`).join(', ') })}</p>}
      {onFilesChange !== undefined && pendingFiles !== undefined && pendingFiles.length > 0 && (
        <ul className={css.fileChips} aria-label={t('attachFiles')}>
          {pendingFiles.map((file, index) => {
            const previewUrl = draftPreviewUrl(file)
            return <li key={`${file.name}-${index}`} className={`${css.fileChip} ${previewUrl !== undefined ? css.imageChip! : ''}`}>
              {previewUrl !== undefined && <img src={previewUrl} alt="" className={css.imageChipPreview} />}
              <span className={css.fileChipName} title={file.name}>{file.name}<span className={css.fileChipSize}>{formatByteSize(file.size)}</span></span>
              <button type="button" className={css.fileChipRemove} aria-label={t('removeFile', { name: file.name })} disabled={pending}
                onClick={() => {
                  const url = draftPreviewUrls.get(file)
                  if (url !== undefined) URL.revokeObjectURL(url)
                  onFilesChange(pendingFiles.filter((_, candidate) => candidate !== index))
                }}>×</button>
            </li>
          })}
        </ul>
      )}
      <div className={css.toolbar}>
        {onFilesChange !== undefined && (
          <>
            <input ref={fileInputRef} type="file" multiple className={css.fileInput} aria-hidden="true" tabIndex={-1}
              onChange={event => {
                const chosen = [...event.target.files ?? []]
                if (chosen.length > 0 && pendingFiles !== undefined) onFilesChange([...pendingFiles, ...chosen])
                event.target.value = ''
              }} />
            <Tooltip label={t('attachFiles')} side="top" delayMs={500}>
              <button type="button" className={css.attachButton} aria-label={t('attachFiles')}
                disabled={pending} onClick={() => { fileInputRef.current?.click() }}>
                <IconPaperclipOutlineMedium size={14} />
              </button>
            </Tooltip>
          </>
        )}
        {onAsTaskChange !== undefined && (
          <button
            type="button"
            className={asTask === true ? `${css.asTaskPill} ${css.asTaskPillOn}` : css.asTaskPill}
            aria-label={t('asTask')}
            aria-pressed={asTask === true}
            title={t('asTask')}
            disabled={pending}
            onClick={() => { onAsTaskChange(asTask !== true) }}
          >
            <IconChecklistOutlineMedium size={14} />
            <span className={css.asTaskLabel}>{t('asTask')}</span>
          </button>
        )}
        <button
          type="submit"
          className={css.sendButton}
          aria-label={pending ? t('sendingMessage') : t('sendMessage')}
          disabled={pending || draft.trim() === ''}
          onMouseDown={event => {
            // Keep the composer focused when the send control is clicked.
            event.preventDefault()
            inputRef.current?.focus({ preventScroll: true })
          }}
        >
          <IconSendOutlineRegular size={16} />
        </button>
      </div>
    </div>
    {error !== undefined && <p className={css.error} role="alert">{error}</p>}
  </form>
}
