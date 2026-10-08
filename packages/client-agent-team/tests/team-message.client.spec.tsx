// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { AgentTeamChannelRef, AgentTeamMemberId, AgentTeamThreadRef } from '@contexera/dsh-agent-team/types'
import { zh } from '../src/client/locales.ts'
import type { TeamConversationProps } from '../src/client/slots.ts'
import { rememberResolvedThreadRef, type ResolvedThreadRef } from '../src/client/refs.ts'
import { TeamMessage } from '../src/client/TeamMessage.tsx'

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as TeamConversationProps['t']

afterEach(cleanup)

function hasClassToken(element: Element, token: string): boolean {
  return [...element.classList].some(className => className.includes(token))
}

function spansWithText(container: HTMLElement, text: string): HTMLElement[] {
  return [...container.querySelectorAll('span')].filter(span => span.textContent === text)
}

describe('TeamMessage structured mention rendering', () => {
  it('renders chips inline for plain-prose agent bodies', () => {
    const { container } = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="@lead please look" mentionNames={['lead']} />,
    )
    const chips = spansWithText(container, '@lead')
    expect(chips).toHaveLength(1)
    expect(hasClassToken(chips[0]!, 'mention')).toBe(true)
    const bodyDiv = chips[0]!.closest('div')
    expect(bodyDiv).not.toBeNull()
    expect(hasClassToken(bodyDiv!, 'messageText')).toBe(true)
    expect(container.textContent).toContain('please look')
    expect([...container.querySelectorAll('div')].some(div => hasClassToken(div, 'mentionsRow'))).toBe(false)
  })

  it('falls back to the trailing chip row for rich markdown agent bodies without ref navigation', () => {
    const { container } = render(
      <TeamMessage
        senderName="Builder"
        memberId={'member:builder' as AgentTeamMemberId}
        human={false}
        body={'```js\nconst lead = 1\n```\nping @lead'}
        mentionNames={['lead']}
      />,
    )
    expect(container.textContent).toContain('const lead = 1')
    expect([...container.querySelectorAll('div')].filter(div => hasClassToken(div, 'mentionsRow'))).toHaveLength(1)
    const row = [...container.querySelectorAll('div')].find(div => hasClassToken(div, 'mentionsRow'))
    expect(row?.textContent).toContain('@lead')
    expect([...container.querySelectorAll('div')].some(div => hasClassToken(div, 'messageText'))).toBe(false)
  })

  it('renders mention chips inline in rich markdown once ref navigation exists', () => {
    const { container } = render(
      <TeamMessage
        senderName="Builder"
        memberId={'member:builder' as AgentTeamMemberId}
        human={false}
        body={'**计划**\n\n1. ping @lead about `task:00000000-0000-0000-0000-000000000001`\n2. 回报'}
        mentionNames={['lead', 'builder']}
        onOpenRef={() => {}}
      />,
    )
    // The spelled handle chipifies at its prose position instead of the
    // trailing row; only the name absent from the body keeps a fallback chip.
    const chips = spansWithText(container, '@lead')
    expect(chips).toHaveLength(1)
    expect(hasClassToken(chips[0]!, 'mention')).toBe(true)
    const row = [...container.querySelectorAll('div')].find(div => hasClassToken(div, 'mentionsRow'))
    expect(row?.textContent).toContain('@builder')
    expect(row?.textContent).not.toContain('@lead')
  })

  it('keeps human literal bodies on the inline flow', () => {
    const { container } = render(
      <TeamMessage senderName="human" memberId={'member:human' as AgentTeamMemberId} human body="ping @lead" mentionNames={['lead']} />,
    )
    const chips = spansWithText(container, '@lead')
    expect(chips).toHaveLength(1)
    expect(hasClassToken(chips[0]!.closest('div')!, 'messageText')).toBe(true)
  })

  it('renders resolved thread refs as titled chips in rich Markdown bodies', () => {
    const threadRef = 'thread:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e32' as AgentTeamThreadRef
    const { container, findAllByRole } = render(
      <TeamMessage
        senderName="Builder"
        memberId={'member:builder' as AgentTeamMemberId}
        human={false}
        body={`**来源**：${threadRef} 和 \`${threadRef}\``}
        onOpenRef={() => {}}
        onResolveThreadRefs={async threadRefs => {
          const entries = threadRefs.map((ref): ResolvedThreadRef => ({
            threadRef: ref,
            channelRef: 'channel:11111111-2222-4333-8333-111111111111' as AgentTeamChannelRef,
            title: 'alpha discussion opens here',
          }))
          for (const entry of entries) rememberResolvedThreadRef(entry)
          return entries
        }}
        t={t}
      />,
    )
    return findAllByRole('button', { name: '讨论 · alpha discussion opens here' }).then(() => {
      const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')]
      expect(buttons).toHaveLength(2)
      expect(buttons.map(button => button.getAttribute('title'))).toEqual([threadRef, threadRef])
      expect(buttons.every(button => button.closest('[class*="messageMarkdown"]') !== null)).toBe(true)
      expect(buttons.every(button => button.closest('[class*="mentionsRow"]') === null)).toBe(true)
      expect(container.textContent).toContain('来源')
    })
  })

  it('distinguishes two taskless thread chips by title and navigates on click', async () => {
    const alphaRef = 'thread:aa0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e32' as AgentTeamThreadRef
    const betaRef = 'thread:bb0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e32' as AgentTeamThreadRef
    const opened: string[] = []
    const { findByRole } = render(
      <TeamMessage
        senderName="Builder"
        memberId={'member:builder' as AgentTeamMemberId}
        human={false}
        body={`见 ${alphaRef} 和 ${betaRef}`}
        onOpenRef={ref => { opened.push(ref) }}
        onResolveThreadRefs={async threadRefs => {
          const entries = threadRefs.map((ref, index): ResolvedThreadRef => ({
            threadRef: ref,
            channelRef: 'channel:11111111-2222-4333-8333-111111111111' as AgentTeamChannelRef,
            title: index === 0 ? 'alpha root marker' : 'beta root marker',
          }))
          for (const entry of entries) rememberResolvedThreadRef(entry)
          return entries
        }}
        t={t}
      />,
    )
    // One chip per cited Thread, each named by its own opening line — never
    // two identical labels the reader cannot tell apart.
    const alphaChip = await findByRole('button', { name: '讨论 · alpha root marker' })
    const betaChip = await findByRole('button', { name: '讨论 · beta root marker' })
    expect(alphaChip.getAttribute('title')).toBe(alphaRef)
    expect(betaChip.getAttribute('title')).toBe(betaRef)
    fireEvent.click(alphaChip)
    expect(opened).toEqual([alphaRef])
  })

  it('leaves unresolvable thread refs as plain text', async () => {
    const unknownRef = 'thread:cc0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e32' as AgentTeamThreadRef
    const { container, findByText } = render(
      <TeamMessage
        senderName="Builder"
        memberId={'member:builder' as AgentTeamMemberId}
        human={false}
        body={`见 ${unknownRef} 请定夺`}
        onOpenRef={() => {}}
        onResolveThreadRefs={async () => []}
        t={t}
      />,
    )
    await findByText(/请定夺/)
    // Let the failed lookup settle: unknowns park for the session instead of
    // becoming links, so no button may appear.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(container.querySelector('button')).toBeNull()
    expect(container.textContent).toContain(unknownRef)
  })

  it('names known channel refs and leaves unknown ones as plain text', async () => {
    const knownRef = 'channel:11111111-2222-4333-8333-111111111111' as AgentTeamChannelRef
    const unknownRef = 'channel:99999999-2222-4333-8333-999999999999' as AgentTeamChannelRef
    const opened: string[] = []
    const { container, findByRole } = render(
      <TeamMessage
        senderName="Builder"
        memberId={'member:builder' as AgentTeamMemberId}
        human={false}
        body={`见 ${knownRef} 和 ${unknownRef} 定夺`}
        onOpenRef={ref => { opened.push(ref) }}
        channelNameOf={ref => ref === knownRef ? '工程' : undefined}
        t={t}
      />,
    )
    const chip = await findByRole('button', { name: '频道 · 工程' })
    expect(chip.getAttribute('title')).toBe(knownRef)
    fireEvent.click(chip)
    expect(opened).toEqual([knownRef])
    // The unknown ref never becomes a link: exactly one button exists and the
    // raw spelling stays in the prose.
    expect(container.querySelectorAll('button')).toHaveLength(1)
    expect(container.textContent).toContain(unknownRef)
  })

  it('opens openable member chips in their session and labels the rest without linking', async () => {
    const activeRef = 'member:6e8a5b10-df16-4ec0-943a-63738010953f' as AgentTeamMemberId
    const suspendedRef = 'member:129366fb-d55a-40a0-b931-9f5b563feeba' as AgentTeamMemberId
    const unknownRef = 'member:00000000-0000-4000-8000-000000000000' as AgentTeamMemberId
    const sessions: string[] = []
    const { container, findByRole } = render(
      <TeamMessage
        senderName="Builder"
        memberId={'member:builder' as AgentTeamMemberId}
        human={false}
        body={`问 ${activeRef} 和 ${suspendedRef} 以及 ${unknownRef} 定夺`}
        onOpenRef={() => {}}
        memberOf={ref => {
          if (ref === activeRef) return { memberId: ref, handle: 'tars', sessionId: 'session-active' as never, openable: true }
          if (ref === suspendedRef) return { memberId: ref, handle: 'ferry', openable: false }
          return undefined
        }}
        onOpenMemberSession={sessionId => { sessions.push(String(sessionId)) }}
        t={t}
      />,
    )
    const chip = await findByRole('button', { name: '成员 · @tars' })
    expect(chip.getAttribute('title')).toBe(activeRef)
    fireEvent.click(chip)
    expect(sessions).toEqual(['session-active'])
    // Suspended members keep a labelled span — informative, never a link —
    // and unknown refs stay raw prose.
    expect(container.querySelectorAll('button')).toHaveLength(1)
    expect(container.textContent).toContain('成员 · @ferry')
    expect(container.textContent).toContain(unknownRef)
  })
})

describe('TeamMessage long-body clamp', () => {
  const longBody = '长消息正文，用于超过折叠阈值。'.repeat(80)

  function clampDivs(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll('div')].filter(div => hasClassToken(div, 'messageClamp'))
  }

  it('starts over-threshold bodies clamped behind the expand control', () => {
    const { container, getByRole } = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body={longBody} t={t} />,
    )
    expect(clampDivs(container)).toHaveLength(1)
    const toggle = getByRole('button', { name: '展开全文' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // The preview still renders the full text into the clamped container, so
    // in-body refs and mentions stay reachable without expanding.
    expect(container.textContent).toContain('用于超过折叠阈值')
  })

  it('expands to the full body and collapses back through the toggle', () => {
    const { container, getByRole } = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body={longBody} t={t} />,
    )
    fireEvent.click(getByRole('button', { name: '展开全文' }))
    expect(clampDivs(container)).toHaveLength(0)
    const collapse = getByRole('button', { name: '收起' })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(collapse)
    expect(clampDivs(container)).toHaveLength(1)
    expect(getByRole('button', { name: '展开全文' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('marks a long body as a document through expand and collapse', () => {
    const { container, getByRole } = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body={`## 结论\n\n${longBody}`} t={t} />,
    )
    // The wrapper itself carries the mark, so the document rhythm applies to
    // the clamped preview and the expanded body alike; the class swap that
    // expands the clamp never drops it.
    const documents = (): HTMLElement[] =>
      [...container.querySelectorAll('div')].filter(div => div.hasAttribute('data-document'))
    expect(documents()).toHaveLength(1)
    expect(documents()[0]!.querySelector('[class*="messageMarkdown"]')).not.toBeNull()
    fireEvent.click(getByRole('button', { name: '展开全文' }))
    expect(documents()).toHaveLength(1)
    fireEvent.click(getByRole('button', { name: '收起' }))
    expect(documents()).toHaveLength(1)
  })

  it('leaves short bodies unclamped without any toggle', () => {
    const { container } = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="短消息" />,
    )
    expect(clampDivs(container)).toHaveLength(0)
    expect(container.querySelector('[data-document]')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
  })

  it('keeps the post-render mention chips across expand and collapse', () => {
    // Rich Markdown bodies get mention chips painted into the DOM after
    // render. Toggling the clamp must not remount that subtree, or the
    // imperatively inserted chips vanish.
    const longRichBody = `**计划**\n\n${'折叠回归验证段落，足够长以触发限高预览。'.repeat(40)}\n\n请 @lead 关注 \`task:0123abcd-0000-0000-0000-000000000000\`。`
    const { container, getByRole } = render(
      <TeamMessage
        senderName="Builder"
        memberId={'member:builder' as AgentTeamMemberId}
        human={false}
        body={longRichBody}
        mentionNames={['lead']}
        onOpenRef={() => {}}
        t={t}
      />,
    )
    const chipCount = (): number => spansWithText(container, '@lead').length
    expect(chipCount()).toBe(1)
    fireEvent.click(getByRole('button', { name: '展开全文' }))
    expect(chipCount()).toBe(1)
    fireEvent.click(getByRole('button', { name: '收起' }))
    expect(chipCount()).toBe(1)
  })
})

describe('TeamMessage bubble and mention mark', () => {
  it('wraps every Message in one bubble and sides it by the sender', () => {
    const own = render(
      <TeamMessage senderName="human" memberId={'member:human' as AgentTeamMemberId} human body="ping" />,
    )
    expect(own.container.querySelector('[data-side="end"]')).not.toBeNull()
    expect(own.container.querySelector('[data-side="start"]')).toBeNull()
    expect(own.container.querySelectorAll('[data-bubble]')).toHaveLength(1)
    expect(own.container.querySelector('[data-bubble]')!.textContent).toContain('ping')
    cleanup()

    const other = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="pong" />,
    )
    expect(other.container.querySelector('[data-side="start"]')).not.toBeNull()
    expect(other.container.querySelector('[data-side="end"]')).toBeNull()
    expect(other.container.querySelectorAll('[data-bubble]')).toHaveLength(1)
  })

  it('marks a bubble only when the Message mentions the reader', () => {
    const plain = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="no call here" t={t} />,
    )
    expect(plain.container.querySelector('[data-mentions-me]')).toBeNull()
    expect(plain.container.textContent).not.toContain('有人@我')
    // A Message nobody was called into still draws its bubble: the mark is an
    // addition, never the reason a bubble exists.
    expect(plain.container.querySelectorAll('[data-bubble]')).toHaveLength(1)
    cleanup()

    const marked = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="@human look" mentionsHuman t={t} />,
    )
    const row = marked.container.querySelector('[data-mentions-me]')
    expect(row).not.toBeNull()
    // The mark is decoration on the author's own bubble: it must never move the
    // bubble to the reader's column, or a reader would think they wrote it.
    expect(row!.getAttribute('data-side')).toBe('start')
    const badge = marked.container.querySelector('[data-mentions-me-badge]')
    expect(badge).not.toBeNull()
    // The label is the whole badge: no glyph is drawn beside it, or the reader
    // sees a doubled `@`.
    expect(badge!.textContent).toBe('有人@我')
    // The badge is a child of the bubble, not of the identity line.
    expect(row!.querySelector('[data-bubble]')!.contains(badge!)).toBe(true)
  })

  it('keeps the body, the clamp toggle, and the mention row inside the bubble', () => {
    const longBody = '长正文段落。'.repeat(120)
    const { container, getByRole } = render(
      <TeamMessage
        senderName="Builder"
        memberId={'member:builder' as AgentTeamMemberId}
        human={false}
        body={`${longBody} @lead`}
        mentionNames={['lead']}
        mentionsHuman
        t={t}
      />,
    )
    const bubble = container.querySelector('[data-bubble]')!
    expect(bubble.querySelector('[data-document]')).not.toBeNull()
    expect(bubble.contains(getByRole('button', { name: '展开全文' }))).toBe(true)
    const badge = bubble.querySelector('[data-mentions-me-badge]')
    expect(badge).not.toBeNull()
    // The mark leads the bubble: the reader learns the Message names them
    // before reading the body they were called into.
    expect(bubble.firstElementChild).toBe(badge)
  })

  it('never repeats the reader back to themselves in the trailing row', () => {
    // A mention the body text does not carry — here only inside a code span,
    // which the chip pass deliberately leaves literal — used to print a bare
    // `@me` chip under the bubble, duplicating the name already chipped above.
    const { container } = render(
      <TeamMessage
        senderName="Builder"
        memberId={'member:builder' as AgentTeamMemberId}
        human={false}
        body={'看这段：`@human` 是历史 handle。\n\n1. 列表项\n2. 另一项'}
        mentionNames={['human']}
        readerName="human"
        onOpenRef={() => {}}
        t={t}
      />,
    )
    expect([...container.querySelectorAll('div')].some(div => hasClassToken(div, 'mentionsRow'))).toBe(false)
  })

  it('still lists a mention of somebody else that the body text does not carry', () => {
    const { container } = render(
      <TeamMessage
        senderName="Builder"
        memberId={'member:builder' as AgentTeamMemberId}
        human={false}
        body="只在正文里说了一句话，没有写出任何名字"
        mentionNames={['lead']}
        readerName="human"
        onOpenRef={() => {}}
        t={t}
      />,
    )
    const row = [...container.querySelectorAll('div')].find(div => hasClassToken(div, 'mentionsRow'))
    expect(row).toBeTruthy()
    expect(row!.textContent).toBe('@lead')
  })
})

describe('TeamMessage reply quote and action', () => {
  it('renders the resolved quote above the body and jumps through it', () => {
    let opened = 0
    const { container } = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="我认这个方向"
        messageRef={'message:self' as never}
        replyTo={{ senderName: '@架构师', excerpt: '这段逻辑现在有点乱' }} onOpenReplyTo={() => { opened += 1 }} t={t} />,
    )
    const quote = container.querySelector('[data-reply-quote]')
    expect(quote).not.toBeNull()
    expect(quote!.textContent).toContain('@架构师')
    expect(quote!.textContent).toContain('这段逻辑现在有点乱')
    // The quote answers "what is this replying to" before the body is read.
    const bubble = container.querySelector('[data-bubble]')!
    expect(bubble.firstElementChild).toBe(quote)
    fireEvent.click(quote!)
    expect(opened).toBe(1)
  })

  it('renders an inert quote when the surface offers no jump', () => {
    const { container } = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="收到"
        replyTo={{ senderName: '@架构师', excerpt: '一段原文' }} t={t} />,
    )
    const quote = container.querySelector('[data-reply-quote]')!
    expect(quote.tagName).toBe('SPAN')
  })

  it('offers a reachable reply action and marks the current target', () => {
    let replied = 0
    const { container, getByRole, rerender } = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="可以"
        messageRef={'message:abc' as never} onReply={() => { replied += 1 }} t={t} />,
    )
    fireEvent.click(getByRole('button', { name: '回复这条消息' }))
    expect(replied).toBe(1)

    rerender(<TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="可以"
      messageRef={'message:abc' as never} replyTarget t={t} />)
    const row = container.querySelector('[data-replying-to]')
    expect(row).not.toBeNull()
    // A row without the action offers none: the Channel feed passes no onReply.
    rerender(<TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="可以" t={t} />)
    expect(container.querySelector('[data-message-actions]')).toBeNull()
    expect(container.querySelector('[data-replying-to]')).toBeNull()
  })
})
