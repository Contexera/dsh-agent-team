// Offline, read-only Session trace context provider for team-member iteration
// analysis (evaluation evidence navigator — evidence, never conclusions).
//
// Scope is deliberately narrow: the current team's own `agent-team-*` member
// sessions under the adjacent checkouts, addressed by member handle. It is not
// a general-purpose session finder.
//
// Commands:
//   list                 member sessions with lightweight activity facts
//   timeline <member>    bounded lightweight event index (no bodies)
//   read <member> <seq>  bounded raw-event window around one seq
//   event <member> <seq> exact canonical payload of one event
//
// All reads go through the Harness composition (SessionStore + JSONL
// persistence + session-query exact reads), so packed-chunk decoding, seq
// continuity, replay validation, and surface classification all come from the
// same authority as the live runtime. No FTS backend is mounted; no session is
// made live; nothing is written.
//
// Usage: node --import tsx scripts/session-trace.ts <command> [options]
import { DatabaseSync } from 'node:sqlite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { harnessDir } from './harness-dir.mjs'

const DEFAULT_TIMELINE_LIMIT = 200
const MAX_WINDOW = 50
const RECENT_ACTIVITY_MS = 7 * 24 * 60 * 60 * 1000
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** This repo and the adjacent harness checkout — where this team's member
 * sessions actually run. Everything else (older experiments on other cwds)
 * stays out of the default view; `--all` lifts the filter. */
const TEAM_CWDS = [PROJECT_ROOT, harnessDir] as const

function parseArgs(argv: readonly string[]): { command: string; positional: string[]; flags: Set<string>; values: Map<string, string> } {
  const [command = '', ...rest] = argv
  const positional: string[] = []
  const flags = new Set<string>()
  const values = new Map<string, string>()
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq > 0) {
        values.set(arg.slice(2, eq), arg.slice(eq + 1))
        continue
      }
      const name = arg.slice(2)
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        values.set(name, next)
        i++
      } else {
        flags.add(name)
      }
    } else {
      positional.push(arg)
    }
  }
  return { command, positional, flags, values }
}

function usage(): never {
  console.log(`usage: session-trace.ts <command>

commands:
  list [filters]                     member sessions with lightweight facts
  timeline <member> [filters]        bounded event index (no bodies)
  read <member> <seq> [--before N] [--after N]
                                      bounded raw window around one seq
  event <member> <seq>               exact canonical payload of one event

common options:
  --all                list: include members with no recent activity
  --limit N            timeline: max rows (default ${DEFAULT_TIMELINE_LIMIT})
  --from-seq N / --to-seq N   timeline seq range
  --type T[,T...]      timeline: event type filter (e.g. tool/call)
  --tool NAME          timeline: derived toolName filter (team_ prefix allowed)
  --before N/--after N read window sizes (default 3, max ${MAX_WINDOW})
  --json               emit structured JSON (default is a human-readable table;
                       read/event always emit JSON — they are raw payloads)
  --home PATH          DSH home (default ~/.dsh)`)
  process.exit(1)
}

interface MemberAddress { handle: string; sessionId: string }

/**
 * Resolve the current team's members from the ledger, keeping only the
 * workspace that holds this repo's members. The ledger is used strictly as an
 * address book (handle → sessionId); no projection semantics are interpreted.
 * Historical experiment members on other workspaces stay out of the output.
 */
function readMemberAddresses(dshHome: string): MemberAddress[] {
  const db = new DatabaseSync(`${dshHome}/storages/agent_team.sqlite`, { readOnly: true })
  try {
    const rows = db.prepare('SELECT value FROM u_agent_team_operations').all() as { value: string }[]
    const members = new Map<string, { memberId: string; workspaceId: string; handle: string; sessionId: string; state: string }>()
    for (const row of rows) {
      const op = JSON.parse(row.value) as {
        kind: string
        data?: { member?: { memberId: string; workspaceId: string; handle: string; sessionId: string; state: string } }
      }
      const member = op.data?.member
      if (member === undefined) continue
      switch (op.kind) {
        case 'team/member-added':
        case 'team/member-updated':
        case 'team/member-session-renewed':
        case 'team/member-resumed':
          members.set(member.memberId, member)
          break
        case 'team/member-removed':
          members.delete(member.memberId)
          break
      }
    }
    const enabled = [...members.values()].filter(m => m.state === 'enabled')
    const workspaceCounts = new Map<string, number>()
    for (const member of enabled) {
      workspaceCounts.set(member.workspaceId, (workspaceCounts.get(member.workspaceId) ?? 0) + 1)
    }
    let currentWorkspace: string | undefined
    let currentCount = 0
    for (const [workspaceId, count] of workspaceCounts) {
      if (count > currentCount) {
        currentWorkspace = workspaceId
        currentCount = count
      }
    }
    return enabled
      .filter(m => m.workspaceId === currentWorkspace)
      .map(m => ({ handle: m.handle, sessionId: m.sessionId }))
  } finally {
    db.close()
  }
}

interface SessionHeaderView {
  id: string
  createdAt: number
  cwd?: string
  agentPreset?: string
  parentSession?: string
}

interface SessionRecordView {
  header: SessionHeaderView
  live: boolean
  persisted: boolean
}

interface SessionEventRecordView {
  sessionId: string
  seq: number
  type: string
  time: number
  surface: string
}

interface SessionEventView {
  seq: number
  type: string
  time: number
  data?: unknown
}

interface SessionEventWindowView {
  session: { id: string }
  target: SessionEventView
  events: SessionEventView[]
  startSeq: number
  endSeq: number
}

interface SessionQueryView {
  listSessions(signal?: AbortSignal): Promise<SessionRecordView[]>
  listEvents(sessionId: string): Promise<SessionEventRecordView[]>
  readEvent(request: { sessionId: string; seq: number; before?: number; after?: number }): Promise<SessionEventWindowView>
}

interface Composition {
  query: SessionQueryView
  dispose(): Promise<void>
}

async function mount(dshHome: string): Promise<Composition> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: `${dshHome}/sessions` })
  await ctx.plugin(class TraceQuery extends SessionQueryEngine {
    override async searchSessions(): Promise<never> {
      throw new Error('session-trace: full-text search is not mounted')
    }

    override async searchEvents(): Promise<never> {
      throw new Error('session-trace: full-text search is not mounted')
    }
  })
  return {
    query: ctx.sessionQuery,
    dispose: () => ctx.fiber.dispose(),
  }
}

interface DerivedFields {
  turn?: number
  step?: number
  callId?: string
  toolName?: string
}

interface TimelineRow {
  sessionId: string
  seq: number
  type: string
  time: number
  surface: string
  derived: DerivedFields
}

/** Turn/step/callId/toolName for a contiguous run of rows, read from one raw-event window. */
async function hydrateDerived(comp: Composition, sessionId: string, rows: readonly TimelineRow[]): Promise<TimelineRow[]> {
  if (rows.length === 0) return []
  const window = await rawWindow(comp, sessionId, rows[0]!.seq, rows.at(-1)!.seq)
  const bySeq = new Map(window.map(e => [e.seq, e]))
  return rows.map(r => ({ ...r, derived: deriveFields(bySeq.get(r.seq) ?? { seq: r.seq, type: r.type, time: r.time }) }))
}

function deriveFields(event: SessionEventView): DerivedFields {
  const data = event.data
  if (data === undefined || data === null || typeof data !== 'object') return {}
  const fields = data as Record<string, unknown>
  const derived: DerivedFields = {}
  if (typeof fields.turn === 'number') derived.turn = fields.turn
  if (typeof fields.step === 'number') derived.step = fields.step
  if (typeof fields.callId === 'string') derived.callId = fields.callId
  if (typeof fields.name === 'string' && event.type === 'tool/call') derived.toolName = fields.name
  return derived
}

/** Minute-precision UTC stamp for scannable columns; the exact ms stays in --json. */
function fmtTime(ms: number | null): string {
  if (ms === null) return '—'
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z'
}

interface ListRow {
  handle: string
  sessionId: string
  createdAt: number
  cwd: string | null
  lastEventTime: number | null
  eventCount: number
  agentPreset: string | null
  /** No session log exists for this Member's recorded Session id. */
  logMissing: boolean
  inTeamWorkspaces: boolean
  activeWithinDays: boolean
}

async function cmdList(comp: Composition, dshHome: string, includeAll: boolean, asJson: boolean): Promise<void> {
  const addresses = readMemberAddresses(dshHome)
  const sessions = await comp.query.listSessions()
  const byId = new Map(sessions.map(s => [s.header.id, s]))
  const rows: ListRow[] = []
  for (const address of addresses) {
    const session = byId.get(address.sessionId)
    if (session === undefined) {
      rows.push({
        handle: address.handle,
        sessionId: address.sessionId,
        createdAt: 0,
        cwd: null,
        lastEventTime: null,
        eventCount: 0,
        agentPreset: null,
        logMissing: true,
        inTeamWorkspaces: false,
        activeWithinDays: false,
      })
      continue
    }
    const events = await comp.query.listEvents(address.sessionId)
    const last = events.at(-1)
    rows.push({
      handle: address.handle,
      sessionId: address.sessionId,
      createdAt: session.header.createdAt,
      cwd: session.header.cwd ?? null,
      lastEventTime: last?.time ?? null,
      eventCount: events.length,
      agentPreset: session.header.agentPreset ?? null,
      logMissing: false,
      inTeamWorkspaces: TEAM_CWDS.includes(session.header.cwd ?? ''),
      activeWithinDays: last !== undefined && Date.now() - last.time < RECENT_ACTIVITY_MS,
    })
  }
  rows.sort((a, b) => (b.lastEventTime ?? 0) - (a.lastEventTime ?? 0))
  const visible = includeAll
    ? rows
    : rows.filter(r => r.logMissing || (r.inTeamWorkspaces && r.activeWithinDays))
  const filters = includeAll
    ? 'none (--all)'
    : `cwd in team workspaces AND last activity within ${RECENT_ACTIVITY_MS / (24 * 60 * 60 * 1000)} days`
  if (asJson) {
    console.log(JSON.stringify({
      command: 'list',
      scope: 'team members',
      dshHome,
      count: visible.length,
      filters,
      members: visible,
    }, null, 2))
    return
  }
  const handleW = Math.max(6, ...visible.map(r => r.handle.length))
  const line = (h: string, ev: string, last: string, preset: string, note: string) =>
    `  ${h.padEnd(handleW)}  ${ev.padStart(6)}  ${last.padEnd(16)}  ${preset.padEnd(12)}  ${note}`
  console.log(`team member sessions — ${visible.length} shown (${filters})`)
  console.log(line('MEMBER', 'EVENTS', 'LAST ACTIVITY', 'PRESET', ''))
  for (const r of visible) {
    const note = r.logMissing ? 'session log missing' : r.inTeamWorkspaces ? '' : 'other cwd'
    console.log(line(r.handle, String(r.eventCount), fmtTime(r.lastEventTime), r.agentPreset ?? '—', note))
  }
  console.log('\nnext: session-trace.ts timeline <MEMBER>   (add --json for full fields incl. sessionId/cwd)')
}

async function cmdTimeline(comp: Composition, dshHome: string, member: string, opts: {
  limit: number
  fromSeq?: number
  toSeq?: number
  types?: string[]
  toolPrefix?: string
  json: boolean
}): Promise<void> {
  const address = resolveMember(dshHome, member)
  const records = await comp.query.listEvents(address.sessionId)
  const filtered = records.filter(r => {
    if (opts.fromSeq !== undefined && r.seq < opts.fromSeq) return false
    if (opts.toSeq !== undefined && r.seq > opts.toSeq) return false
    if (opts.types !== undefined && !opts.types.includes(r.type)) return false
    return true
  })

  const toolPrefix = opts.toolPrefix
  const asRows = (events: readonly SessionEventRecordView[]): TimelineRow[] =>
    events.map(r => ({ ...r, sessionId: address.sessionId, derived: {} }))
  let matched: TimelineRow[]
  if (toolPrefix === undefined) {
    matched = asRows(filtered)
  } else {
    const hydrated = await hydrateDerived(comp, address.sessionId, asRows(filtered.filter(r => r.type === 'tool/call')))
    matched = hydrated.filter(r => r.derived.toolName?.startsWith(toolPrefix) === true)
  }

  const start = Math.max(0, matched.length - opts.limit)
  let rows = matched.slice(start)
  if (toolPrefix === undefined) rows = await hydrateDerived(comp, address.sessionId, rows)

  const truncated = start > 0
  if (opts.json) {
    console.log(JSON.stringify({
      command: 'timeline',
      member: address.handle,
      sessionId: address.sessionId,
      totalEvents: records.length,
      matchedEvents: matched.length,
      returned: rows.length,
      truncated,
      truncatedNote: truncated ? `${matched.length - rows.length} older matching event(s) exist; raise --limit or use --from-seq/--to-seq` : null,
      seqRange: { from: rows[0]?.seq ?? null, to: rows.at(-1)?.seq ?? null },
      derivedFieldsNote: 'turn/step/callId/toolName are derived from canonical event data',
      events: rows,
    }, null, 2))
    return
  }
  const filterDesc = [
    opts.types ? `type in {${opts.types.join(',')}}` : null,
    toolPrefix ? `tool starts with "${toolPrefix}"` : null,
    opts.fromSeq !== undefined ? `seq>=${opts.fromSeq}` : null,
    opts.toSeq !== undefined ? `seq<=${opts.toSeq}` : null,
  ].filter(Boolean).join(', ') || 'none'
  console.log(`${address.handle} timeline — ${matched.length} matched, showing ${rows.length}${truncated ? ` (newest; ${matched.length - rows.length} older hidden)` : ''}  [filter: ${filterDesc}]`)
  const seqW = Math.max(4, ...rows.map(r => String(r.seq).length))
  for (const r of rows) {
    const ts = r.derived.turn !== undefined ? `t${r.derived.turn}${r.derived.step !== undefined ? `/s${r.derived.step}` : ''}` : ''
    const tool = r.derived.toolName ? ` ${r.derived.toolName}` : ''
    console.log(`  ${String(r.seq).padStart(seqW)}  ${fmtTime(r.time)}  ${r.type.padEnd(18)} ${ts.padEnd(8)}${tool}`)
  }
  console.log(`\nnext: session-trace.ts read ${address.handle} <SEQ>   (add --json for structured rows)`)
}


async function rawWindow(comp: Composition, sessionId: string, fromSeq: number, toSeq: number): Promise<SessionEventView[]> {
  if (toSeq < fromSeq) return []
  const events: SessionEventView[] = []
  let cursor = fromSeq
  while (cursor <= toSeq) {
    const win = await comp.query.readEvent({ sessionId, seq: cursor, before: 0, after: Math.min(MAX_WINDOW, toSeq - cursor) })
    events.push(...win.events)
    cursor = win.endSeq + 1
  }
  return events
}

async function cmdRead(comp: Composition, dshHome: string, member: string, seq: number, before: number, after: number): Promise<void> {
  const address = resolveMember(dshHome, member)
  const win = await comp.query.readEvent({ sessionId: address.sessionId, seq, before, after })
  console.log(JSON.stringify({
    command: 'read',
    member: address.handle,
    sessionId: address.sessionId,
    requested: { seq, before, after },
    startSeq: win.startSeq,
    endSeq: win.endSeq,
    count: win.events.length,
    events: win.events,
  }, null, 2))
}

async function cmdEvent(comp: Composition, dshHome: string, member: string, seq: number): Promise<void> {
  const address = resolveMember(dshHome, member)
  let target: SessionEventView
  try {
    target = (await comp.query.readEvent({ sessionId: address.sessionId, seq, before: 0, after: 0 })).target
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === 'SESSION_QUERY_EVENT_NOT_FOUND') {
      fail(String(error.message))
    }
    throw error
  }
  console.log(JSON.stringify({
    command: 'event',
    member: address.handle,
    sessionId: address.sessionId,
    event: target,
  }, null, 2))
}

function resolveMember(dshHome: string, member: string): MemberAddress {
  const addresses = readMemberAddresses(dshHome)
  const hit = addresses.find(a => a.handle.toLowerCase() === member.toLowerCase())
  if (hit === undefined) {
    const known = addresses.map(a => a.handle).join(', ')
    fail(`unknown member "${member}". known handles: ${known}`)
  }
  return hit
}

function fail(message: string): never {
  console.error(`session-trace: ${message}`)
  process.exit(1)
}

const args = parseArgs(process.argv.slice(2))
const dshHome = args.values.get('home') ?? `${process.env.HOME ?? fail('HOME is unset')}/.dsh`
const wantJson = args.flags.has('json')

switch (args.command) {
  case 'list': {
    const comp = await mount(dshHome)
    try {
      await cmdList(comp, dshHome, args.flags.has('all'), wantJson)
    } finally {
      await comp.dispose()
    }
    break
  }
  case 'timeline': {
    const member = args.positional[0] ?? usage()
    const comp = await mount(dshHome)
    try {
      const types = args.values.get('type')?.split(',').map(t => t.trim()).filter(t => t.length > 0)
      const fromSeq = args.values.get('from-seq')
      const toSeq = args.values.get('to-seq')
      const tool = args.values.get('tool')
      await cmdTimeline(comp, dshHome, member, {
        limit: Number(args.values.get('limit') ?? DEFAULT_TIMELINE_LIMIT),
        json: wantJson,
        ...(fromSeq === undefined ? {} : { fromSeq: Number(fromSeq) }),
        ...(toSeq === undefined ? {} : { toSeq: Number(toSeq) }),
        ...(types === undefined ? {} : { types }),
        ...(tool === undefined ? {} : { toolPrefix: tool }),
      })
    } finally {
      await comp.dispose()
    }
    break
  }
  case 'read': {
    const member = args.positional[0] ?? usage()
    const seq = Number(args.positional[1] ?? usage())
    const before = Math.min(Number(args.values.get('before') ?? 3), MAX_WINDOW)
    const after = Math.min(Number(args.values.get('after') ?? 3), MAX_WINDOW)
    const comp = await mount(dshHome)
    try {
      await cmdRead(comp, dshHome, member, seq, before, after)
    } finally {
      await comp.dispose()
    }
    break
  }
  case 'event': {
    const member = args.positional[0] ?? usage()
    const seq = Number(args.positional[1] ?? usage())
    const comp = await mount(dshHome)
    try {
      await cmdEvent(comp, dshHome, member, seq)
    } finally {
      await comp.dispose()
    }
    break
  }
  default:
    usage()
}
