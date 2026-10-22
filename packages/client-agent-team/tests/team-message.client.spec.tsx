// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { AgentTeamChannelRef, AgentTeamMemberId, AgentTeamThreadRef } from '@contexera/dsh-agent-team/types'
import { zh } from '../src/client/locales.ts'
import type { TeamConversationProps } from '../src/client/slots.ts'
import { rememberResolvedThreadRef, type ResolvedThreadRef } from '../src/client/refs.ts'
import { TeamMessage } from '../src/client/TeamMessage.tsx'
import { formatAbsoluteTime, formatClockTime, formatMessageTime } from '../src/client/team-formatters.ts'

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

  it('marks the reader\'s own chip, including a handle written before a rename', () => {
    const { container } = render(
      <TeamMessage
        senderName="Builder"
        memberId={'member:builder' as AgentTeamMemberId}
        human={false}
        body="@Iris and @lead please look"
        mentionNames={[{ name: 'Iris', also: ['human'] }, 'lead']}
        readerName="Iris"
      />,
    )
    // Every member's chip is business-tinted, so the reader's own carries the
    // marker their eye can follow back to "this one is me".
    expect(spansWithText(container, '@Iris')[0]!.getAttribute('data-mention-human')).toBe('')
    expect(spansWithText(container, '@lead')[0]!.getAttribute('data-mention-human')).toBeNull()
    // A body written before the reader renamed themselves still marks the chip:
    // the mark follows the identity, not the spelling.
    const renamed = render(
      <TeamMessage
        senderName="Builder"
        memberId={'member:builder' as AgentTeamMemberId}
        human={false}
        body="@human look"
        mentionNames={[{ name: 'Iris', also: ['human'] }]}
        readerName="Iris"
      />,
    )
    const historic = renamed.container.querySelector('[data-mention-human]')
    expect(historic?.textContent).toBe('@Iris')
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

describe('TeamMessage reading row and mention line', () => {
  it('keeps every Message in one column on the reading path', () => {
    const own = render(
      <TeamMessage senderName="human" memberId={'member:human' as AgentTeamMemberId} human body="ping" />,
    )
    // No side, no per-message surface: the reader's own turn reads in the same
    // column as everyone else's, on the reading path itself.
    expect(own.container.querySelector('[data-side]')).toBeNull()
    expect(own.container.querySelector('[data-bubble]')).toBeNull()
    cleanup()

    const other = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="pong" />,
    )
    expect(other.container.querySelector('[data-side]')).toBeNull()
    expect(other.container.querySelector('article')!.textContent).toContain('pong')
  })

  it('states a mention of the reader on the card, never on the reading path', () => {
    const plain = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="no call here" t={t} onReply={() => {}} />,
    )
    expect(plain.container.querySelector('[data-mentions-me]')).toBeNull()
    expect(plain.container.querySelector('[data-message-card]')).not.toBeNull()
    expect(plain.container.querySelector('[data-mentions-you]')).toBeNull()
    expect(plain.container.textContent).not.toContain('提到了你')
    cleanup()

    const marked = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="@human look" mentionNames={['human']} readerName="human" t={t} onReply={() => {}} />,
    )
    const row = marked.container.querySelector('[data-mentions-me]')
    expect(row).not.toBeNull()
    // The statement is about the Message and never moves the row: every Message
    // keeps the one column.
    expect(row!.hasAttribute('data-side')).toBe(false)
    const line = marked.container.querySelector('[data-mentions-you]')
    expect(line).not.toBeNull()
    expect(line!.textContent).toBe('提到了你')
    // It rides the card, so the body the reader was called into stays the body.
    expect(row!.querySelector('[data-message-card]')!.contains(line!)).toBe(true)
    cleanup()

    // A Thread reaches its Human in every row, so delivery alone is not a
    // mention: a body that never spells `@human` renders no chip even when the
    // Host delivered the Message to them.
    const delivered = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="这条交付给你，但没有点名" mentionNames={['human']} readerName="human" t={t} onReply={() => {}} />,
    )
    expect(delivered.container.querySelector('[data-mentions-you]')).toBeNull()
    cleanup()

    // An alias of the reader counts (a rename must not orphan old bodies), while
    // a handle inside code quotes is not a call.
    const aliased = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="@human 旧写法也认；`@human` 在代码里不算" mentionNames={['human']} readerName="Iris" t={t} onReply={() => {}} />,
    )
    expect(aliased.container.querySelector('[data-mentions-you]')).not.toBeNull()
    cleanup()

    // Calling somebody else is not calling the reader: the chip states what the
    // words say to *this* reader, so a Message that names another Member says
    // nothing about them. The same answer decides where opening the Thread lands
    // (`firstUnreadMention`), so both surfaces have to agree that naming another
    // Member is not a mention of the reader.
    const elsewhere = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="@Iris 这条点名的是别人" mentionNames={[{ name: 'Iris', also: ['human'] }]} readerName="Iris" t={t} onReply={() => {}} />,
    )
    expect(elsewhere.container.querySelector('[data-mentions-me]')).not.toBeNull()
    // Naming Iris while the reader is somebody else draws no chip at all.
    const otherReader = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="@Iris 这条点名的是别人" mentionNames={[{ name: 'Iris', also: ['human'] }]} readerName="wowyuarm" t={t} onReply={() => {}} />,
    )
    expect(otherReader.container.querySelector('[data-mentions-me]')).toBeNull()
    expect(otherReader.container.querySelector('[data-mentions-you]')).toBeNull()
  })

  it('keeps the body, the clamp toggle, and the mention row on the reading path', () => {
    const longBody = '长正文段落。'.repeat(120)
    const { container, getByRole } = render(
      <TeamMessage
        senderName="Builder"
        memberId={'member:builder' as AgentTeamMemberId}
        human={false}
        body={`${longBody} @lead`}
        mentionNames={['lead']}
        t={t}
        onReply={() => {}}
      />,
    )
    const article = container.querySelector('article')!
    const document_ = article.querySelector('[data-document]')
    expect(document_).not.toBeNull()
    expect(article.contains(getByRole('button', { name: '展开全文' }))).toBe(true)
    // The mention line and the actions stay outside the body: the reader reads
    // the Message, not the chrome around it.
    expect(document_!.contains(article.querySelector('[data-mentions-you]'))).toBe(false)
    expect(document_!.contains(article.querySelector('[data-message-card]'))).toBe(false)
  })

  it('shows a continuation row\u2019s time in the avatar seat, out of the text column', () => {
    const { container } = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="续一条" grouped showGroupedTime occurredAt="2026-10-09T12:34:00.000Z" t={t} onReply={() => {}} />,
    )
    // A grouped row carries no identity line, so its time sits in the empty
    // avatar seat — never on the card, and never in the reading column.
    expect(container.querySelector('strong')).toBeNull()
    const seatTime = container.querySelector('[data-gutter-time]')
    expect(seatTime).not.toBeNull()
    // The seat is 28px and does not clip, so it states the time of day alone: a
    // dated label runs to 59px within the year and 87px across it, which would
    // paint over the words beside it. The date is the identity line's and the
    // day separator's business; the exact instant stays on the element's title.
    expect(seatTime!.textContent).toBe(formatClockTime('2026-10-09T12:34:00.000Z'))
    expect(seatTime!.textContent).toBe('20:34')
    expect(seatTime!.textContent).not.toBe(formatMessageTime('2026-10-09T12:34:00.000Z'))
    expect(seatTime!.getAttribute('title')).toBe(formatAbsoluteTime('2026-10-09T12:34:00.000Z'))
    expect(container.querySelector('[data-avatar]')).not.toBeNull()
    cleanup()

    // The identity line that opens the run still carries the whole wall-clock
    // form: the date is not lost, it moved to the row that has room for it.
    const head = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="起一条" occurredAt="2026-10-09T12:34:00.000Z" t={t} onReply={() => {}} />,
    )
    expect(head.container.querySelector('[data-gutter-time]')).toBeNull()
    expect(head.container.querySelector('strong')!.parentElement!.textContent).toContain(formatMessageTime('2026-10-09T12:34:00.000Z'))
    cleanup()

    // A surface that never asked for the reading language — the Channel feed —
    // renders no time at all: the Thread owns all of it.
    const feed = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="续一条" grouped occurredAt="2026-10-09T12:34:00.000Z" t={t} />,
    )
    expect(feed.container.querySelector('[data-gutter-time]')).toBeNull()
  })

  it('never repeats the reader back to themselves in the trailing row', () => {
    // A mention the body text does not carry — here only inside a code span,
    // which the chip pass deliberately leaves literal — used to print a bare
    // `@me` chip under the body, duplicating the name already chipped above.
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

describe('TeamMessage quote line and card actions', () => {
  it('leads the Message with the quoted line and jumps to what it quotes', () => {
    let opened: string | undefined
    const { container } = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="我认这个方向"
        messageRef={'message:self' as never}
        replyTo={{ senderName: '@架构师', excerpt: '这段逻辑现在有点乱', messageRef: 'message:parent' as never }}
        onOpenReplyTo={messageRef => { opened = messageRef }} t={t} />,
    )
    const quote = container.querySelector('[data-quote-line]')
    expect(quote).not.toBeNull()
    expect(quote!.textContent).toContain('@架构师')
    expect(quote!.textContent).toContain('这段逻辑现在有点乱')
    // It is the Message's first line under the identity line: the reader learns
    // what this points at before reading what it says.
    const body = [...container.querySelectorAll('div')].find(div => hasClassToken(div, 'messageBody'))!
    const nameRow = [...body.children].find(child => hasClassToken(child, 'nameRow'))!
    expect(nameRow.nextElementSibling).toBe(quote)
    fireEvent.click(quote!)
    // The pointer lands on the Message this one quotes, never on this one.
    expect(opened).toBe('message:parent')
  })

  it('renders an inert quote when the surface offers no jump', () => {
    const { container } = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="收到"
        replyTo={{ senderName: '@架构师', excerpt: '一段原文', messageRef: 'message:parent' as never }} t={t} />,
    )
    const quote = container.querySelector('[data-quote-line]')!
    expect(quote.tagName).toBe('SPAN')
  })

  it('states the quoted delivery once, in the quote line that carries it', () => {
    // The reply delivers to the parent's author, so the Host lists them among
    // this Message's recipients. The quote line already names them, and a bare
    // chip under it would read as a mention the body never wrote.
    const mentions = [{ name: 'reviewer', also: [] }]
    const { container, rerender } = render(
      <TeamMessage senderName="Iris" memberId={'member:iris' as AgentTeamMemberId} human body="引用这条"
        mentionNames={mentions} replyTo={{ senderName: '@reviewer', excerpt: '离线期间的批量更新 一', messageRef: 'message:parent' as never }} t={t} />,
    )
    expect(container.querySelector('[data-quote-line]')!.textContent).toContain('@reviewer')
    const row = [...container.querySelectorAll('div')].find(div => hasClassToken(div, 'mentionsRow'))
    expect(row?.textContent ?? '').not.toContain('@reviewer')

    // A quote that no longer resolves names nobody, so there the chip is the
    // only place the delivery still shows.
    rerender(
      <TeamMessage senderName="Iris" memberId={'member:iris' as AgentTeamMemberId} human body="引用这条" mentionNames={mentions} t={t} />,
    )
    const alone = [...container.querySelectorAll('div')].find(div => hasClassToken(div, 'mentionsRow'))
    expect(alone?.textContent).toContain('@reviewer')
  })

  it('offers copy and quote on the card, and marks the current target', () => {
    let replied = 0
    const { container, getByRole, rerender } = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="可以"
        messageRef={'message:abc' as never} onReply={() => { replied += 1 }} t={t} />,
    )
    fireEvent.click(getByRole('button', { name: '引用这条消息' }))
    expect(replied).toBe(1)
    const card = container.querySelector('[data-message-card]')!
    expect(card.querySelector('[data-copy-message]')).not.toBeNull()
    // The card floats beside the Message instead of living on the reading path.
    expect(container.querySelector('article')!.contains(card)).toBe(true)
    expect(card.closest('[data-document]')).toBeNull()

    rerender(<TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="可以"
      messageRef={'message:abc' as never} replyTarget t={t} />)
    expect(container.querySelector('[data-replying-to]')).not.toBeNull()
    // A row without the action offers none: the Channel feed passes no onReply.
    rerender(<TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="可以" t={t} />)
    expect(container.querySelector('[data-message-card]')).toBeNull()
    expect(container.querySelector('[data-replying-to]')).toBeNull()
  })

  it('keeps the row actions and the reader notice when quoting is withheld', () => {
    // The switch decides one action, not the card: a Thread with quotes turned
    // off still copies, and still tells the reader the Message names them.
    const { container } = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false} body="@Iris 可以"
        mentionNames={[{ name: 'Iris', also: ['human'] }]} readerName="Iris" rowActions="always" t={t} />,
    )
    const card = container.querySelector('[data-message-card]')
    expect(card).not.toBeNull()
    expect(card!.querySelector('[data-copy-message]')).not.toBeNull()
    expect(card!.querySelector('[data-mentions-you]')).not.toBeNull()
    expect(card!.querySelector('[data-quote-message]')).toBeNull()
  })

  it('copies the stored Markdown of the body, not the text it rendered as', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { getByRole } = render(
      <TeamMessage senderName="Builder" memberId={'member:builder' as AgentTeamMemberId} human={false}
        body={'**重点**：见 `src/a.ts`\n\n- 一条\n- 两条'} messageRef={'message:abc' as never} onReply={() => {}} t={t} />,
    )
    fireEvent.click(getByRole('button', { name: '复制这条消息' }))
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledTimes(1) })
    // The source travels, markers and all: a reader pasting it elsewhere wants
    // what the author wrote, not the styling this page gave it.
    expect(writeText.mock.calls[0]![0]).toBe('**重点**：见 `src/a.ts`\n\n- 一条\n- 两条')
    await vi.waitFor(() => { expect(getByRole('button', { name: '复制这条消息' }).textContent).toBe('已复制') })
    delete (navigator as { clipboard?: unknown }).clipboard
  })
})
