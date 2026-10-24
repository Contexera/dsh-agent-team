import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, ClipboardEvent, KeyboardEvent, ReactNode } from 'react'
import type { AgentTeamClientMemberStatus, AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import { IconPaperclipOutlineMedium, IconSendOutlineRegular, Tooltip, useAnchoredMaxHeight, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import type { TeamDraftKey, TeamDraftStore } from './drafts.ts'
import { TeamPresenceDot } from './TeamPresenceDot.tsx'
import { mentionSurfaceOf, mentionTierIsParticipant } from './mention-presentation.ts'
import { containsMention, HUMAN_MEMBER_ID, mentionedMemberIds } from './team-formatters.ts'
import css from './composer.module.css'
import { formatByteSize } from './attachment-preview.ts'

interface MentionMatch {
  readonly start: number
  readonly end: number
  readonly query: string
}

/** How directly a mention reaches a Member: thread follower (delivers at once), Project peer, or the rest of the workspace. Ranking and row styling both read it. */
export type MentionTier = 'thread-follower' | 'project-peer' | 'workspace'

const MENTION_TIER_RANK = { 'thread-follower': 0, 'project-peer': 1, workspace: 2 } as const satisfies Record<MentionTier, number>

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

/** A hint for the picker only: every tier stays eligible, but a lower tier only ranks lower. */
function mentionTier(status: AgentTeamClientMemberStatus, followers: ReadonlySet<AgentTeamMemberId> | undefined,
  projectPeers: ReadonlySet<AgentTeamMemberId> | undefined): MentionTier {
  if (followers?.has(status.member.memberId) === true) return 'thread-follower'
  if (projectPeers?.has(status.member.memberId) === true) return 'project-peer'
  return 'workspace'
}

function rankMentionCandidates(candidates: readonly AgentTeamClientMemberStatus[], followers: ReadonlySet<AgentTeamMemberId> | undefined,
  projectPeers: ReadonlySet<AgentTeamMemberId> | undefined): readonly AgentTeamClientMemberStatus[] {
  if ((followers === undefined || followers.size === 0) && (projectPeers === undefined || projectPeers.size === 0)) return candidates
  return [...candidates].sort((left, right) => MENTION_TIER_RANK[mentionTier(left, followers, projectPeers)] - MENTION_TIER_RANK[mentionTier(right, followers, projectPeers)])
}

/** The Human is excluded from delivery, so a quote naming them joins no notify row. */
export interface ReplyTarget {
  /** Absent when the parent did not resolve and cannot name an author. */
  readonly memberId?: AgentTeamMemberId
  readonly senderName: string
  readonly excerpt: string
}

/** One object URL per draft file; revoked when the draft file is removed. */
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

function revokeDraftPreviewUrl(file: File): void {
  const url = draftPreviewUrls.get(file)
  if (url !== undefined) URL.revokeObjectURL(url)
}

/** The Human is never delivered to (they read the Thread directly), so quoting them, even oneself, joins no row. */
function deliverableRecipients(
  recipients: ReadonlySet<AgentTeamMemberId>,
  draft: string,
  members: readonly AgentTeamClientMemberStatus[],
  replyTo: ReplyTarget | undefined,
): readonly AgentTeamMemberId[] {
  return [...new Set<AgentTeamMemberId>([
    ...recipients,
    ...mentionedMemberIds(draft, members),
    ...(replyTo?.memberId === undefined || replyTo.memberId === HUMAN_MEMBER_ID ? [] : [replyTo.memberId]),
  ])].sort()
}

export function TeamComposer({ members, followerMemberIds, projectPeerMemberIds, drafts, draftKey, pending, notice, error, onEdit, onSubmit, placeholder, pendingFiles, onFilesChange, replyTo, onCancelReply, toolbarExtra, t }: {
  readonly members: readonly AgentTeamClientMemberStatus[]
  /** Current Thread followers; the Thread surface passes them so they rank above other candidates. */
  readonly followerMemberIds?: ReadonlySet<AgentTeamMemberId>
  /** Members taking part in the Project but not following this Thread; they rank above the rest of the Workspace. */
  readonly projectPeerMemberIds?: ReadonlySet<AgentTeamMemberId>
  /** Subscribing here, not in the hosting page, keeps a keystroke from re-rendering the timeline. */
  readonly drafts: TeamDraftStore
  readonly draftKey: TeamDraftKey
  readonly pending: boolean
  readonly notice?: string
  readonly error?: string
  /** The Human edited the draft: the hosting page drops its one-shot send state. */
  readonly onEdit?: () => void
  readonly onSubmit: () => void
  readonly placeholder?: string
  /** Upload-capable surfaces pass this to enable the "+" file picker; the reply path omits it. */
  readonly pendingFiles?: readonly File[]
  readonly onFilesChange?: (files: readonly File[]) => void
  readonly replyTo?: ReplyTarget | undefined
  readonly onCancelReply?: (() => void) | undefined
  /** Extra controls after the attach button, for surfaces whose send has modes. */
  readonly toolbarExtra?: ReactNode
  readonly t: TeamConversationProps['t']
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLFormElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const activeOptionRef = useRef<HTMLButtonElement>(null)
  const composingRef = useRef(false)
  // Subscribing here, not in the hosting page, keeps a keystroke off the timeline.
  const { draft, recipients } = useSyncExternalStore(drafts.subscribe, () => drafts.getSnapshot(draftKey))
  const [mention, setMention] = useState<MentionMatch>()
  const [highlight, setHighlight] = useState(0)
  const memberCandidates = mention === undefined ? [] : rankMentionCandidates(mentionCandidates(members, mention.query), followerMemberIds, projectPeerMemberIds)
  const options = memberCandidates.map(status => ({ status, tier: mentionTier(status, followerMemberIds, projectPeerMemberIds) }))
  const menuOpen = mention !== undefined && options.length > 0
  const activeOption = options[highlight]
  const mentionSurface = mentionSurfaceOf(draftKey)
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

  // Keeps the keyboard-highlighted row from hiding below the anchored height cap.
  useLayoutEffect(() => {
    if (!menuOpen) return
    // Optional call: jsdom renders the menu without a layout engine.
    activeOptionRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [menuOpen, highlight, activeOption?.status.member.memberId])

  // Team data can load after navigation, so another control may already own focus; do not steal it.
  useEffect(() => {
    const active = document.activeElement
    if (active !== document.body && active?.closest('[aria-current="page"]') === null) return
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  // A notice settles after a read-only submission span; restore focus so the Human can keep typing.
  useEffect(() => {
    if (notice === undefined || pending) return
    inputRef.current?.focus({ preventScroll: true })
  }, [notice, pending])

  const memberHandles = new Map(members.map(status => [status.member.memberId, status.member.handle]))

  const pruneRecipients = (nextDraft: string): void => {
    const next = new Set([...recipients].filter(memberId => {
      const handle = memberHandles.get(memberId)
      return handle !== undefined && containsMention(nextDraft, handle)
    }))
    if (next.size !== recipients.size) drafts.writeRecipients(draftKey, next)
  }

  // Restored drafts may carry recipients that no longer match the text; converge so the cache never stays stale.
  // An unloaded roster must never judge recipients unknown.
  useEffect(() => {
    if (members.length === 0) return
    pruneRecipients(draft)
  }, [draft, recipients, members])

  const notifiedIds = deliverableRecipients(recipients, draft, members, replyTo)

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

  const selectOption = (option: (typeof options)[number]): void => {
    if (mention === undefined) return
    const member = option.status
    const inserted = `@${member.member.handle} `
    const nextDraft = `${draft.slice(0, mention.start)}${inserted}${draft.slice(mention.end)}`
    const nextCaret = mention.start + inserted.length
    commitMention(nextDraft, nextCaret, new Set(recipients).add(member.member.memberId))
  }

  // Only a paste that carries files is intercepted, so plain text keeps native insertion.
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
      {notice !== undefined && <p className={css.notice} role="status">{notice}</p>}
      {replyTo !== undefined && <div className={css.replyBanner} data-reply-banner="">
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
            const selected = index === highlight
            return <button
              key={option.status.member.memberId}
              id={`${listId}-${option.status.member.memberId}`}
              type="button"
              role="option"
              aria-selected={selected}
              className={css.mentionOption}
              ref={selected ? activeOptionRef : undefined}
              onMouseDown={event => { event.preventDefault() }}
              onClick={() => { selectOption(option) }}
              data-mention-tier={MENTION_TIER_RANK[option.tier]}
              data-mention-inside={String(mentionTierIsParticipant(option.tier, mentionSurface))}
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
          aria-activedescendant={menuOpen && activeOption !== undefined ? `${listId}-${activeOption.status.member.memberId}` : undefined}
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
                  revokeDraftPreviewUrl(file)
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
        {toolbarExtra}
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
