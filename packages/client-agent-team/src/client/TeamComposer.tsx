import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, ClipboardEvent, KeyboardEvent, ReactNode } from 'react'
import type { AgentTeamClientMemberStatus, AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import { IconPaperclipOutlineMedium, IconSendOutlineRegular, Tooltip, useAnchoredMaxHeight, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import type { TeamDraftKey, TeamDraftStore } from './drafts.ts'
import { TeamPresenceDot } from './TeamPresenceDot.tsx'
import { buildMentionGroups, enrollmentIds, mentionSurfaceOf, type MentionGroupKey } from './mention-presentation.ts'
import { HUMAN_MEMBER_ID, mentionedMemberIds } from './team-formatters.ts'
import css from './composer.module.css'
import { formatByteSize } from './attachment-preview.ts'

interface MentionMatch {
  readonly start: number
  readonly end: number
  readonly query: string
}

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
  draft: string,
  members: readonly AgentTeamClientMemberStatus[],
  replyTo: ReplyTarget | undefined,
): readonly AgentTeamMemberId[] {
  return [...new Set<AgentTeamMemberId>([
    ...mentionedMemberIds(draft, members),
    ...(replyTo?.memberId === undefined || replyTo.memberId === HUMAN_MEMBER_ID ? [] : [replyTo.memberId]),
  ])].sort()
}

export function TeamComposer({ members, followerMemberIds, projectMemberIds, ownerMemberIds, drafts, draftKey, pending, notice, error, onEdit, onSubmit, placeholder, pendingFiles, onFilesChange, replyTo, onCancelReply, toolbarExtra, t }: {
  readonly members: readonly AgentTeamClientMemberStatus[]
  /** Current Thread followers; the Thread surface passes them so they form this Thread's group. */
  readonly followerMemberIds?: ReadonlySet<AgentTeamMemberId>
  /** Every Member taking part in the Project; the rest of the roster is a Workspace peer a pick would enroll. */
  readonly projectMemberIds?: ReadonlySet<AgentTeamMemberId>
  /** The Project's Agent owners; they lead the list. */
  readonly ownerMemberIds?: ReadonlySet<AgentTeamMemberId>
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
  const { draft } = useSyncExternalStore(drafts.subscribe, () => drafts.getSnapshot(draftKey))
  const [mention, setMention] = useState<MentionMatch>()
  const [highlight, setHighlight] = useState(0)
  const mentionSurface = mentionSurfaceOf(draftKey)
  const groups = mention === undefined
    ? []
    : buildMentionGroups(members, mention.query, mentionSurface, { followers: followerMemberIds, projectMembers: projectMemberIds, owners: ownerMemberIds })
  const options = groups.flatMap(group => group.options)
  const optionIndexById = new Map(options.map((status, index) => [status.member.memberId, index]))
  const menuOpen = mention !== undefined
  const activeOption = options[highlight]
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
  }, [menuOpen, highlight, activeOption?.member.memberId])

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

  const notifiedIds = deliverableRecipients(draft, members, replyTo)
  // A name typed outside the Project's roster makes that Member a Project member on send; say so before the send.
  const enrollment = enrollmentIds(notifiedIds, projectMemberIds)

  const groupLabel = (key: MentionGroupKey): string =>
    key === 'owner' ? t('mentionGroupOwner')
      : key === 'thread' ? t('mentionGroupThread')
        : key === 'project' ? t('mentionGroupProject')
          : t('mentionGroupOther')

  const updateMention = (nextDraft: string, caret: number): void => {
    const match = findMention(nextDraft, caret)
    setMention(match)
    if (match === undefined) setHighlight(0)
  }

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const nextDraft = event.target.value
    drafts.writeDraft(draftKey, nextDraft)
    onEdit?.()
    updateMention(nextDraft, event.target.selectionStart ?? nextDraft.length)
  }

  const commitMention = (nextDraft: string, nextCaret: number): void => {
    drafts.writeDraft(draftKey, nextDraft)
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

  const selectOption = (status: AgentTeamClientMemberStatus): void => {
    if (mention === undefined) return
    const inserted = `@${status.member.handle} `
    const nextDraft = `${draft.slice(0, mention.start)}${inserted}${draft.slice(mention.end)}`
    const nextCaret = mention.start + inserted.length
    commitMention(nextDraft, nextCaret)
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
    if (menuOpen && options.length > 0 && event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight(current => (current + 1) % options.length)
      return
    }
    if (menuOpen && options.length > 0 && event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight(current => (current - 1 + options.length) % options.length)
      return
    }
    if (event.key === 'Escape' && menuOpen) {
      event.preventDefault()
      setMention(undefined)
      return
    }
    if (menuOpen && activeOption !== undefined && event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault()
      selectOption(activeOption)
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
          {options.length === 0
            ? <p className={css.mentionEmpty} role="presentation">{t('mentionNoMatch')}</p>
            : groups.map(group => (
              <div key={group.key} className={css.mentionGroup} role="group" aria-label={groupLabel(group.key)}>
                <p className={css.mentionGroupLabel} aria-hidden="true">{groupLabel(group.key)}</p>
                {group.options.map(status => {
                  const index = optionIndexById.get(status.member.memberId) ?? 0
                  const selected = index === highlight
                  return <button
                    key={status.member.memberId}
                    id={`${listId}-${status.member.memberId}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={css.mentionOption}
                    ref={selected ? activeOptionRef : undefined}
                    onMouseDown={event => { event.preventDefault() }}
                    onClick={() => { selectOption(status) }}
                    data-mention-group={group.key}
                    data-mention-inside={String(group.key !== 'other')}
                  >
                    <TeamPresenceDot status={status} t={t} />
                    <span className={css.mentionName}>@{status.member.handle}</span>
                    <span className={css.mentionDescription}>{status.member.description}</span>
                  </button>
                })}
              </div>
            ))}
        </div>}
        <textarea
          ref={inputRef}
          aria-label={t('messageDraft')}
          aria-autocomplete="list"
          aria-controls={menuOpen ? listId : undefined}
          aria-activedescendant={menuOpen && activeOption !== undefined ? `${listId}-${activeOption.member.memberId}` : undefined}
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
      {notifiedIds.length > 0 && <p className={css.notifyRow} data-team-notify>{t('composerNotify', { ids: notifiedIds.map(memberId => `@${memberHandles.get(memberId) ?? memberId}`).join(', ') })}{enrollment.length > 0 && <span className={css.notifyJoin}>{' '}{t('composerNotifyJoin', { ids: enrollment.map(memberId => `@${memberHandles.get(memberId) ?? memberId}`).join(', ') })}</span>}</p>}
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
