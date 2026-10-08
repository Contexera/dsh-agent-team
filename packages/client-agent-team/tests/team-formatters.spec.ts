import { describe, expect, it } from 'vitest'
import type { AgentTeamActivity, AgentTeamClaim, AgentTeamClientMemberStatus, AgentTeamMemberDiagnostic, AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import { AGENT_TEAM_HUMAN_HANDLE } from '@contexera/dsh-agent-team/host'
import { MENTION_BODY_FIXTURE } from '../../agent-team/tests/fixtures/mention-bodies.ts'
import { zh } from '../src/client/locales.ts'
import type { TeamConversationProps } from '../src/client/slots.ts'
import { allMentionMembers, containsAllMention, containsMention, firstSentence, formatAbsoluteTime, formatActivity, formatClaimState, formatInboxTime, formatMessageTime, formatTaskStatus, HUMAN_HISTORIC_HANDLE, isPlainTextBody, isSingleBrandedRef, mentionNamesOf, formatRiskClass, mentionedMemberIds, planMessageBody, shouldClampMessage, splitBrandedRefs, splitMentionNames, taskStatusDot } from '../src/client/team-formatters.ts'

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as TeamConversationProps['t']

const base = { activityRef: 'activity:1', taskRef: 'task:1', threadRef: 'thread:1', actor: 'member:builder', sequence: 3 }
const claim = { claimRef: 'claim:1', taskRef: 'task:1', threadRef: 'thread:1', owner: 'member:builder', direction: '实现 API', normalizedDirection: '实现 api', state: 'active' } as AgentTeamClaim

function activity(value: Record<string, unknown>): AgentTeamActivity {
  return { ...base, ...value } as AgentTeamActivity
}

/** One Client roster row: the fields the mention preview reads — handle, state, presence. */
function memberStatus(memberId: string, handle: string, extra: { readonly presence?: 'available' | 'working' | 'error' | 'unavailable'; readonly state?: 'enabled' | 'suspended' | 'inactive' | 'archived' } = {}): AgentTeamClientMemberStatus {
  return {
    member: { memberId, handle, state: extra.state ?? 'enabled' },
    availability: 'active',
    presence: extra.presence ?? 'available',
  } as unknown as AgentTeamClientMemberStatus
}

describe('Team presentation formatters', () => {
  it('localizes Task and Claim states', () => {
    expect(formatTaskStatus('in_review', t)).toBe('待验收')
    expect(formatTaskStatus('closed', t)).toBe('已关闭')
    expect(formatClaimState('active', t)).toBe('进行中')
    expect(formatClaimState('released', t)).toBe('已释放')
  })

  it('names every diagnostic class instead of showing the Host reason alone', () => {
    const status = (diagnosticClass?: AgentTeamMemberDiagnostic['class']): Pick<AgentTeamClientMemberStatus, 'diagnostic'> =>
      diagnosticClass === undefined ? {} : { diagnostic: { class: diagnosticClass, detail: 'host reason' } }
    expect(formatRiskClass(status('session-refused'), t)).toEqual({ label: '会话被拒绝', sentenceKey: 'riskSessionRefused' })
    expect(formatRiskClass(status('session-unreadable'), t).label).toBe('会话不可读')
    expect(formatRiskClass(status('preset-composition'), t).label).toBe('预设装配失败')
    expect(formatRiskClass(status('rollover'), t).label).toBe('上下文交接中')
    expect(formatRiskClass(status('runtime'), t).label).toBe('运行时故障')
    expect(formatRiskClass(status('activation'), t).label).toBe('激活失败')
    // A Member carrying no diagnostic still gets a class word, never a hole.
    expect(formatRiskClass(status(), t)).toEqual({ label: '运行时故障', sentenceKey: 'riskRuntime' })
    // The sentence key keeps its placeholder so the row can supply the handle.
    expect(zh[formatRiskClass(status('rollover'), t).sentenceKey]).toContain('{member}')
  })

  it('keeps a risk row to the Host diagnostic first sentence', () => {
    expect(firstSentence('context pressure policy: the routed model capacity is unknown; refusing to forward'))
      .toBe('context pressure policy: the routed model capacity is unknown.')
    expect(firstSentence('reason one. more detail here')).toBe('reason one.')
    expect(firstSentence('中文原因。后面还有')).toBe('中文原因。')
    // No terminator: the text is the sentence and stays intact.
    expect(firstSentence('a reason with no terminator')).toBe('a reason with no terminator')
    expect(firstSentence('  padded  ')).toBe('padded')
    expect(firstSentence('')).toBe('')
  })

  it('formats every Activity kind without exposing refs or enums', () => {
    const expected = [
      ['claim', 'builder 认领了「实现 API」'],
      ['done', 'builder 完成了「实现 API」'],
      ['release', 'builder 释放了「实现 API」'],
      ['claims_released', 'builder 因成员权限变化释放了 1 个 Claim'],
      ['accept', 'builder 验收了此 Task'],
      ['close', 'builder 关闭了此 Task'],
      ['reopen', 'builder 重新打开了此 Task'],
    ] as const
    for (const [kind, text] of expected) {
      const claimFields = kind === 'claim' || kind === 'done' || kind === 'release' ? { claimRef: claim.claimRef }
        : kind === 'claims_released' ? { claimRefs: [claim.claimRef] } : {}
      const rendered = formatActivity(activity({ kind, ...claimFields }), { t, actorName: () => 'builder', claims: [claim] })
      expect(rendered).toBe(text)
      expect(rendered).not.toContain('member:')
      expect(rendered).not.toContain('claim:')
    }
  })

  it('renders message time as clock time today, date+time within the year, full date otherwise', () => {
    const now = new Date('2026-08-21T12:00:00')
    const at = new Date('2026-08-21T03:05:00.000Z')
    const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    expect(formatMessageTime('2026-08-21T03:05:00.000Z', now)).toBe(clock)
    expect(formatMessageTime('2026-02-01T08:30:00', now)).toBe('02-01 08:30')
    expect(formatMessageTime('2025-12-31T23:59:00', now)).toBe('2025-12-31 23:59')
    expect(formatMessageTime('not-a-date', now)).toBe('')
  })

  it('shows today as a bare clock time, names yesterday, and dates everything older', () => {
    const now = new Date('2026-08-21T12:00:00')
    expect(formatInboxTime('2026-08-21T03:05:00', t, now)).toBe('03:05')
    expect(formatInboxTime('2026-08-20T23:40:00', t, now)).toBe('昨天 23:40')
    // Two days back is a date again, and the label agrees with the Message form.
    expect(formatInboxTime('2026-08-19T08:30:00', t, now)).toBe('08-19 08:30')
    expect(formatInboxTime('2025-12-31T23:59:00', t, now)).toBe('2025-12-31 23:59')
    expect(formatInboxTime('not-a-date', t, now)).toBe('')
    // Calendar days, not 24-hour spans: 00:10 today is still today, and today
    // carries no day word at all.
    expect(formatInboxTime(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 10).toISOString(), t, now)).toBe('00:10')
    // The precise instant stays available behind every relative label.
    expect(formatAbsoluteTime('2026-08-21T03:05:00')).toBe('2026-08-21 03:05')
    expect(formatAbsoluteTime('not-a-date')).toBe('')
  })

  it('splits only authored @mentions, never bare names', () => {
    const bare = splitMentionNames('@builder please review human', ['builder', 'Human'])
    expect(bare.segments).toEqual([
      { text: '@builder', mention: true, name: 'builder' },
      { text: ' please review human', mention: false },
    ])
    // A name without its '@' is prose even when the roster carries it: the Host
    // would not deliver there, so no chip lands there either. The undelivered
    // name stays available for the trailing fallback row.
    expect(bare.unmatched).toEqual(['Human'])
    // Unmentioned names stay plain even when the body spells them out.
    expect(splitMentionNames('builder and @stranger', ['lead']).segments).toEqual([
      { text: 'builder and @stranger', mention: false },
    ])
    // Email addresses never match; word boundaries hold.
    expect(splitMentionNames('mail me at a@builder.com', ['builder']).segments).toEqual([
      { text: 'mail me at a@builder.com', mention: false },
    ])
    // A mentioned name absent from the body comes back unmatched.
    const absent = splitMentionNames('no names here', ['builder'])
    expect(absent.segments).toEqual([{ text: 'no names here', mention: false }])
    expect(absent.unmatched).toEqual(['builder'])
    // Longer names win over their prefixes at the same position.
    const nested = splitMentionNames('ping @builder2', ['build', 'builder2'])
    expect(nested.segments).toEqual([
      { text: 'ping ', mention: false },
      { text: '@builder2', mention: true, name: 'builder2' },
    ])
    // Code is quoted, never called — not even with the '@' written.
    expect(splitMentionNames('quote `@builder` then call @lead', ['builder', 'lead']).segments).toEqual([
      { text: 'quote `@builder` then call ', mention: false },
      { text: '@lead', mention: true, name: 'lead' },
    ])
  })

  it('chips and previews exactly what the shared Host scan delivers', () => {
    // The Host spec reads the same fixture through delivery resolution: every
    // nasty body must come back with the same handle set and marker on both sides.
    for (const { body, handles, all } of MENTION_BODY_FIXTURE.cases) {
      const chipped = splitMentionNames(body, MENTION_BODY_FIXTURE.roster).segments
        .filter(segment => segment.mention)
        .map(segment => segment.name ?? '')
    // Chips render per occurrence while delivery resolves a set: dedupe the
    // chip side before comparing with the Host's delivered handle set.
      expect([...new Set(chipped)].sort()).toEqual([...handles].sort())
      expect(containsAllMention(body)).toBe(all)
    }
  })

  it('splits branded refs, tolerating doubled colons and canonicalizing them', () => {
    const refText = 'task:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e01'
    expect(splitBrandedRefs(`源头 ${refText} 结束`)).toEqual([
      { text: '源头 ' },
      { text: refText, ref: refText },
      { text: ' 结束' },
    ])
    // A doubled colon or uppercase UUID from model output still resolves,
    // canonicalized to the lowercase single-colon ref the Host mints.
    expect(splitBrandedRefs('见 TASK::0F0AD7CE-11D3-4C05-8A9E-6F2B1C9D7E01 即可')).toEqual([
      { text: '见 ' },
      { text: 'TASK::0F0AD7CE-11D3-4C05-8A9E-6F2B1C9D7E01', ref: refText },
      { text: ' 即可' },
    ])
    // A tripled colon is not a ref, and prose colons never linkify.
    expect(splitBrandedRefs('task:::0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e01')).toEqual([
      { text: 'task:::0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e01' },
    ])
    // Abbreviated UUIDs — plain hex runs or truncations with hyphens — are
    // ref candidates; resolution later decides whether they exist.
    expect(splitBrandedRefs('尾缀 task:0f0ad7 与截断 task:0f0ad7ce-11d3')).toEqual([
      { text: '尾缀 ' },
      { text: 'task:0f0ad7', ref: 'task:0f0ad7' },
      { text: ' 与截断 ' },
      { text: 'task:0f0ad7ce-11d3', ref: 'task:0f0ad7ce-11d3' },
    ])
    // Below 6 hex chars a branded-looking run stays prose.
    expect(splitBrandedRefs('task:cafe 是咖啡')).toEqual([
      { text: 'task:cafe 是咖啡' },
    ])
    // Member refs match the same shape; the roster map decides existence.
    expect(splitBrandedRefs('问 member:6e8a5b10-df16-4ec0-943a-63738010953f').slice(1)).toEqual([
      { text: 'member:6e8a5b10-df16-4ec0-943a-63738010953f', ref: 'member:6e8a5b10-df16-4ec0-943a-63738010953f' },
    ])
    // The Human id is not hex-shaped, so it never becomes a ref candidate.
    expect(splitBrandedRefs('问 member:human')).toEqual([
      { text: '问 member:human' },
    ])
  })

  it('detects strings whose whole content is one branded ref', () => {
    expect(isSingleBrandedRef(' task::0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e01 ')).toBe(true)
    expect(isSingleBrandedRef('thread:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e01')).toBe(true)
    expect(isSingleBrandedRef('编号 task:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e01')).toBe(false)
    expect(isSingleBrandedRef('task:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e01 task:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e02')).toBe(false)
    expect(isSingleBrandedRef('')).toBe(false)
    // Abbreviated UUID prefixes count as ref candidates once they carry the
    // branded prefix plus at least 6 hex chars; length decides below that.
    expect(isSingleBrandedRef('task:0f0ad7ce')).toBe(true)
    expect(isSingleBrandedRef('task:cafe')).toBe(false)
  })

  it('maps mention refs to canonical handles through the member table', () => {
    const handles = new Map([['member:1' as AgentTeamMemberId, 'builder'], ['member:2' as AgentTeamMemberId, 'lead']])
    expect(mentionNamesOf(['member:2' as AgentTeamMemberId, 'member:1' as AgentTeamMemberId, 'member:gone' as AgentTeamMemberId], handles, 'Human')).toEqual(['lead', 'builder'])
  })

  it('names the Human mention from the profile when the Agent roster omits it', () => {
    const handles = new Map([['member:builder' as AgentTeamMemberId, 'builder']])
    expect(mentionNamesOf(['member:human' as AgentTeamMemberId, 'member:builder' as AgentTeamMemberId], handles, 'human')).toEqual(['human', 'builder'])
  })

  it('keeps the historic handle on a renamed Human mention', () => {
    const handles = new Map([['member:builder' as AgentTeamMemberId, 'builder']])
    expect(mentionNamesOf(['member:human' as AgentTeamMemberId, 'member:builder' as AgentTeamMemberId], handles, 'Ada'))
      .toEqual([{ name: 'Ada', also: ['human'] }, 'builder'])
    // The Host owns that string; the two halves must agree on it.
    expect(HUMAN_HISTORIC_HANDLE).toBe(AGENT_TEAM_HUMAN_HANDLE)
  })

  it('chips a mention written with the historic handle under the renamed Human', () => {
    const human = { name: 'Ada', also: [HUMAN_HISTORIC_HANDLE] }
    // Whatever handle the body authored, the chip names the person as they are
    // called today — the same rule member refs follow. The body itself is not
    // rewritten anywhere the match did not land.
    const chipText = (body: string): readonly string[] =>
      splitMentionNames(body, [human, 'builder']).segments.filter(segment => segment.mention).map(segment => segment.text)
    expect(chipText('请看 @human 这条')).toEqual(['@Ada'])
    expect(chipText('请看 @Human 这条')).toEqual(['@Ada'])
    expect(chipText('请看 @Ada 这条')).toEqual(['@Ada'])
    for (const body of ['请看 @human 这条', '请看 @Human 这条', '请看 @Ada 这条']) {
      expect(splitMentionNames(body, [human]).unmatched).toEqual([])
    }
    // An Agent's chip keeps the canonical spelling the roster carries, which is
    // what it always did; only the Human's older handle resolves onto the name.
    expect(chipText('@Builder 请看')).toEqual(['@builder'])
    // One person, one chip: a body hitting the alias never also lands in the
    // trailing fallback row under the current name.
    expect(splitMentionNames('@human 和 @builder', [human, 'builder']).unmatched).toEqual([])
    expect(splitMentionNames('@builder 只看这个', [human, 'builder']).unmatched).toEqual(['Ada'])
  })

  it('reads one handle only when the draft writes it as an authored mention', () => {
    expect(containsMention('请 @builder 看一下', 'builder')).toBe(true)
    // Boundaries and the literal '@' hold in both directions: a longer handle
    // is a different name, and an email is not a mention.
    expect(containsMention('@builder2 请看看', 'builder')).toBe(false)
    expect(containsMention('mail a@builder.com', 'builder')).toBe(false)
    expect(containsMention('builder please review', 'builder')).toBe(false)
    expect(containsMention('请 @Builder 看一下', 'builder')).toBe(true)
    expect(containsAllMention('请评审 @all，今天截止')).toBe(true)
    expect(containsAllMention('通知 all 成员')).toBe(false)
    // A doubled marker is not the marker the Host expands.
    expect(containsAllMention('ping @@all')).toBe(false)
    // The marker is case-insensitive, and code never carries it — both match
    // the Host expansion exactly.
    expect(containsAllMention('@ALL 大家看一下')).toBe(true)
    expect(containsAllMention('quote `@all` here')).toBe(false)
    expect(containsMention('`@builder` is quoted', 'builder')).toBe(false)
    expect(containsMention('@@builder is not a call', 'builder')).toBe(false)
  })

  it('derives the notified members from a draft body, not from bare names', () => {
    const members = [memberStatus('member:builder', 'builder'), memberStatus('member:worker', 'worker')]
    expect(mentionedMemberIds('请 @builder 看一下', members)).toEqual(['member:builder'])
    // One Member is notified once however often the body repeats the handle,
    // and a longer handle is never read as its prefix.
    expect(mentionedMemberIds('@Builder 与 @builder2 与 @builder', members)).toEqual(['member:builder'])
    expect(mentionedMemberIds('builder please review', members)).toEqual([])
    expect(mentionedMemberIds('mail a@builder.com', members)).toEqual([])
    expect(mentionedMemberIds('', members)).toEqual([])
  })

  it('stands a typed @all for the eligible roster and a written handle for its Member', () => {
    const members = [
      memberStatus('member:builder', 'builder'),
      memberStatus('member:offline', 'offline', { presence: 'unavailable' }),
      memberStatus('member:gone', 'gone', { state: 'archived' }),
    ]
    // The marker stands for the menu's own expansion, so an offline Member is
    // left out exactly as the picker leaves it out.
    expect(mentionedMemberIds('通知 @all 一下', members)).toEqual(['member:builder'])
    expect(allMentionMembers(members).map(status => status.member.memberId)).toEqual(['member:builder'])
    // A written handle is a direct call: presence does not gate it, because an
    // offline Member is notified and reads the Message later. State still does.
    expect(mentionedMemberIds('@offline 在吗', members)).toEqual(['member:offline'])
    expect(mentionedMemberIds('@gone 在吗', members)).toEqual([])
  })

  it('accepts plain-prose bodies for literal mention rendering', () => {
    expect(isPlainTextBody('@lead please review the diff')).toBe(true)
    expect(isPlainTextBody('two lines\nwith a normal break')).toBe(true)
  })

  it('rejects Markdown-bearing bodies from literal mention rendering', () => {
    expect(isPlainTextBody('run this:\n```js\nconst lead = 1\n```')).toBe(false)
    expect(isPlainTextBody('use `npm test` here')).toBe(false)
    expect(isPlainTextBody('## heading body')).toBe(false)
    expect(isPlainTextBody('- list item')).toBe(false)
    expect(isPlainTextBody('> quoted line')).toBe(false)
    expect(isPlainTextBody('1. ordered item')).toBe(false)
    expect(isPlainTextBody('| a | b |')).toBe(false)
    expect(isPlainTextBody('see [docs](https://example.com) now')).toBe(false)
    expect(isPlainTextBody('bold **word** inside')).toBe(false)
    expect(isPlainTextBody('snake_case_word')).toBe(false)
  })

  it('plans Human bodies as inline mentions with the unmatched fallback row', () => {
    const plan = planMessageBody('你好 @builder 请看', { human: true, mentionNames: ['builder', 'tester'], canOpenRefs: true })
    expect(plan.render).toBe('inline')
    expect(plan.inline?.segments).toEqual([
      { text: '你好 ', mention: false },
      { text: '@builder', mention: true, name: 'builder' },
      { text: ' 请看', mention: false },
    ])
    expect(plan.fallbackNames).toEqual(['tester'])
    expect(plan.fallbackRefs).toEqual([])
    expect(plan.taskRefs).toEqual([])
  })

  it('keeps a plain Agent body literal only when it carries navigable refs', () => {
    const plain = planMessageBody('纯文本回复', { human: false, canOpenRefs: true })
    expect(plain.render).toBe('markdown')
    const task = planMessageBody('请看 task:0123abcd-0000-0000-0000-000000000000', { human: false, canOpenRefs: true })
    expect(task.render).toBe('literal')
    expect(task.taskRefs).toEqual(['task:0123abcd-0000-0000-0000-000000000000'])
    expect(task.threadRefs).toEqual([])
    const abbreviated = planMessageBody('请看 task:0123abcd', { human: false, canOpenRefs: true })
    expect(abbreviated.render).toBe('literal')
    expect(abbreviated.taskRefs).toEqual(['task:0123abcd'])
    // Thread refs take the same literal path so their chips resolve in place.
    const thread = planMessageBody('见 thread:0f0ad7ce', { human: false, canOpenRefs: true })
    expect(thread.render).toBe('literal')
    expect(thread.threadRefs).toEqual(['thread:0f0ad7ce'])
    expect(thread.taskRefs).toEqual([])
  })

  it('keeps rich Agent bodies on Markdown and paints their refs inline when navigation is available', () => {
    const body = '# 标题\n\n见 channel:0123abcd-0000-0000-0000-000000000000'
    const plan = planMessageBody(body, { human: false, mentionNames: ['tester'], canOpenRefs: true })
    expect(plan.render).toBe('markdown')
    expect(plan.richAgentBody).toBe(true)
    // Rich Markdown refs render at their authored position through the
    // post-render pass, so the trailing chip row keeps only unmatched names.
    expect(plan.fallbackRefs).toEqual([])
    expect(plan.fallbackNames).toEqual(['tester'])
    expect(plan.taskRefs).toEqual([])
    expect(plan.threadRefs).toEqual([])
  })

  it('keeps the full mention row and no ref links on surfaces without navigation', () => {
    const plan = planMessageBody('你好 @builder', { human: true, mentionNames: ['builder'], canOpenRefs: false })
    expect(plan.render).toBe('inline')
    expect(plan.fallbackNames).toEqual([])
    const rich = planMessageBody('**粗体** @builder', { human: false, mentionNames: ['builder'], canOpenRefs: false })
    expect(rich.render).toBe('markdown')
    expect(rich.fallbackNames).toEqual(['builder'])
    expect(rich.fallbackRefs).toEqual([])
    expect(rich.taskRefs).toEqual([])
    // Without navigation the post-render pass cannot paint refs inline, so
    // rich Markdown bodies keep their branded refs in the trailing row.
    const refBody = planMessageBody('**粗体** 见 channel:0123abcd-0000-0000-0000-000000000000', { human: false, mentionNames: ['builder'], canOpenRefs: false })
    expect(refBody.render).toBe('markdown')
    expect(refBody.fallbackRefs).toEqual(['channel:0123abcd-0000-0000-0000-000000000000'])
  })

  it('strips attachment prompt lines and keeps the raw body when stripping empties it', () => {
    const plan = planMessageBody('[attachment] /tmp/a.png\n看图', { human: true, canOpenRefs: false })
    expect(plan.displayBody).toBe('看图')
    const raw = planMessageBody('[attachment] /tmp/a.png', { human: true, canOpenRefs: false })
    expect(raw.displayBody).toBe('[attachment] /tmp/a.png')
  })

  it('maps every task status to a status dot variant', () => {
    expect(taskStatusDot('todo')).toBe('todo')
    expect(taskStatusDot('in_progress')).toBe('ongoing')
    expect(taskStatusDot('in_review')).toBe('warning')
    expect(taskStatusDot('done')).toBe('done')
    expect(taskStatusDot('closed')).toBe('quiet')
  })

  it('clamps bodies purely by their displayed character count', () => {
    expect(shouldClampMessage('短消息')).toBe(false)
    expect(shouldClampMessage('字'.repeat(600))).toBe(false)
    expect(shouldClampMessage('字'.repeat(601))).toBe(true)
  })
})
