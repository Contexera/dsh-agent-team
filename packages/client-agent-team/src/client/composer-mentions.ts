import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { startsMentionAt } from '@contexera/dsh-agent-team/mentions'
import type { AgentTeamClientMemberStatus } from '@contexera/dsh-agent-team/types'
import { useAnchoredMaxHeight, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import { buildMentionGroups, type MentionRoster, type MentionSurface } from './mention-presentation.ts'

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
  // A pick must land where the Host reads a call, not where it keeps prose.
  if (!startsMentionAt(draft, at)) return undefined
  return { start: at, end: caret, query: beforeCaret.slice(at + 1) }
}

interface ComposerMentionInput {
  readonly draft: string
  readonly surface: MentionSurface
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly roster: MentionRoster
  readonly rootRef: RefObject<HTMLFormElement | null>
  readonly inputRef: RefObject<HTMLTextAreaElement | null>
  readonly writeDraft: (nextDraft: string) => void
}

export function useComposerMentions({ draft, surface, members, roster, rootRef, inputRef, writeDraft }: ComposerMentionInput) {
  const menuRef = useRef<HTMLDivElement>(null)
  const activeOptionRef = useRef<HTMLButtonElement>(null)
  const [mention, setMention] = useState<MentionMatch>()
  const [highlight, setHighlight] = useState(0)
  const groups = mention === undefined ? [] : buildMentionGroups(members, mention.query, surface, roster)
  const options = groups.flatMap(group => group.options)
  const optionIndexById = new Map(options.map((status, index) => [status.member.memberId, index]))
  const menuOpen = mention !== undefined
  const activeOption = options[highlight]
  const menuMaxHeight = useAnchoredMaxHeight(menuRef, 320, menuOpen ? draft : null)

  useDismissOnOutsidePointer(rootRef, menuOpen, open => { if (!open) setMention(undefined) })

  useEffect(() => {
    if (mention === undefined || options.length === 0) {
      setHighlight(0)
      return
    }
    setHighlight(current => Math.min(current, options.length - 1))
  }, [mention, options.length])

  useLayoutEffect(() => {
    if (!menuOpen) return
    // Keyboard highlight can move past the anchored height cap.
    activeOptionRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [menuOpen, highlight, activeOption?.member.memberId])

  const updateMention = (nextDraft: string, caret: number): void => {
    const match = findMention(nextDraft, caret)
    setMention(match)
    if (match === undefined) setHighlight(0)
  }

  const selectOption = (status: AgentTeamClientMemberStatus): void => {
    if (mention === undefined) return
    const inserted = `@${status.member.handle} `
    const nextDraft = `${draft.slice(0, mention.start)}${inserted}${draft.slice(mention.end)}`
    const nextCaret = mention.start + inserted.length
    writeDraft(nextDraft)
    setMention(undefined)
    setHighlight(0)
    // Restore the caret after React commits the replacement text.
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (input === null) return
      input.focus({ preventScroll: true })
      input.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, sendKey: boolean): boolean => {
    if (!menuOpen) return false
    if (options.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const step = event.key === 'ArrowDown' ? 1 : -1
      event.preventDefault()
      setHighlight(current => (current + step + options.length) % options.length)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setMention(undefined)
      return true
    }
    if (activeOption !== undefined && (sendKey || (event.key === 'Tab' && !event.shiftKey))) {
      event.preventDefault()
      selectOption(activeOption)
      return true
    }
    return false
  }

  return { menuRef, menuMaxHeight, menuOpen, groups, options, activeOption, activeOptionRef, optionIndexById, highlight, updateMention, selectOption, handleKeyDown }
}
