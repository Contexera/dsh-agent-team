import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Session, SessionId, deriveEventMessage, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { Message, RequestMessage } from '@deepseek-ai/dsh-llm'

interface Snapshot {
  stage: string
  sessionId: string
  header: SessionHeader
  events: SessionEvent[]
  requests: { messages: RequestMessage[]; tools?: unknown }[]
}

function textUnits(message: Message | RequestMessage): number {
  return message.content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 0), 0)
}

function category(message: Message): string {
  if (message.role !== 'user') return message.role
  const source = message.source as Record<string, unknown>
  const tag = source['memberContext'] as { category?: string; variant?: string } | undefined
  if (tag?.category !== undefined) return `member-context:${tag.category}${tag.variant === undefined ? '' : `:${tag.variant}`}`
  return `${source['kind']}:${source['form'] ?? 'message'}`
}

function measure(snapshot: Snapshot) {
  const session = Session.create(SessionId(snapshot.sessionId), snapshot.events, snapshot.header)
  const outputs: { category: string; textCodeUnits: number }[] = []
  const calls = new Map<string, string>()
  let partBindings = 0
  let wholeMessageBindings = 0
  for (const event of snapshot.events) {
    if (event.type === 'tool/call') {
      const args = JSON.parse(event.data.arguments) as { action?: string }
      calls.set(event.data.callId, `${event.data.name}:${args.action ?? '-'}`)
    }
    const message = deriveEventMessage(event)
    if (message === null) continue
    const label = message.role === 'tool' ? calls.get(message.toolCallId) ?? 'tool' : category(message)
    outputs.push({ category: label, textCodeUnits: textUnits(message) })
    const binding = event.type === 'tool/result'
      ? (event.data.meta as { teamFacts?: { messages?: { start?: number }[] } } | undefined)?.teamFacts
      : message.role === 'user' ? (message.source as { teamFacts?: { messages?: { start?: number }[] } }).teamFacts : undefined
    for (const item of binding?.messages ?? []) {
      if (item.start === undefined) wholeMessageBindings += 1
      else partBindings += 1
    }
  }
  const categories: Record<string, { messages: number; textCodeUnits: number }> = {}
  for (const output of outputs) {
    const count = categories[output.category] ??= { messages: 0, textCodeUnits: 0 }
    count.messages += 1
    count.textCodeUnits += output.textCodeUnits
  }
  const surface = session.deriveMessages()
  return {
    stage: snapshot.stage,
    sessionId: snapshot.sessionId,
    cumulativeLog: {
      eventCount: snapshot.events.length,
      textCodeUnits: outputs.reduce((sum, item) => sum + item.textCodeUnits, 0),
      categories,
      wholeMessageBindings,
      partBindings,
    },
    currentSurface: {
      messageCount: surface.length,
      textCodeUnits: surface.reduce((sum, message) => sum + textUnits(message), 0),
    },
    requests: snapshot.requests.map((request, index) => ({
      index,
      textCodeUnits: request.messages.reduce((sum, message) => sum + textUnits(message), 0),
      messageJsonCodeUnits: JSON.stringify(request.messages).length,
      toolSchemaJsonCodeUnits: JSON.stringify(request.tools ?? []).length,
    })),
  }
}

const paths = process.argv.slice(2)
if (paths.length === 0) throw new Error('Pass explicit synthetic snapshot JSON paths; no personal Session directory is scanned.')
const snapshots: Snapshot[] = []
for (const path of paths) {
  const input = JSON.parse(await readFile(resolve(path), 'utf8')) as { format?: string; snapshots?: Snapshot[] }
  if (input.format !== 'team-context-snapshots-v1' || !Array.isArray(input.snapshots)) {
    throw new Error(`${path}: expected team-context-snapshots-v1 from the deterministic scenario; raw persistence logs are not this format`)
  }
  snapshots.push(...input.snapshots)
}
const latest = new Map<string, Snapshot>()
for (const snapshot of snapshots) latest.set(snapshot.sessionId, snapshot)
console.log(JSON.stringify({
  inputFiles: paths.length,
  sessions: latest.size,
  snapshots: snapshots.map(measure),
  finalSessions: [...latest.values()].map(snapshot => ({ sessionId: snapshot.sessionId, finalStage: snapshot.stage })),
  note: 'UTF-16 code units, not tokens or cost. Each snapshot is cumulative within its own Session; never sum successive snapshots. Requests are recorded GenerateOptions from the realHarness test preset, which omits the shipped persona prefix; they are not production request totals or provider wire payloads. Part bindings count emitted segments, not unique or currently visible content. Input files are synthetic exports, not counts of Session persistence files.',
}, null, 2))
