#!/usr/bin/env node
// Ticket 06 pre-check: what the released Claude Code CLI actually does on the
// four questions the ticket must answer before any Team implementation.
//
//   steer-tool    a message written while a tool runs: same turn or next?
//   steer-late    a message written at/after the tool result
//   steer-stream  a message written while the final text is streaming
//   lifecycle     the native command_lifecycle order for a mid-tool steer and
//                 for a late one: `started` before the turn's result = same
//                 turn, after = a new turn
//   record        native session id, record location, read-only read after exit
//   stop-record   the same record after SIGKILL mid-tool
//   permissions   OAR's exact arg shape (launchArgs empty): full permission?
//   missing-cli   OAR's installation probe with no claude on PATH
//   not-logged-in no credentials: exit code and the failure the host must read
//
// Every case runs against a local stand-in for the Anthropic Messages API, so
// no provider is contacted and no real account is used. Logs land under
// --out (default: a fresh temp dir) and are never inside the repository.
//
//   node claude-precheck.mjs [--claude <bin>] [--out <dir>] [case ...]
//
// Exit code is 0 when every selected case produced its expected observation.
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const value = argv[i + 1]
  argv.splice(i, 2)
  return value
}
const CLAUDE = flag('claude', process.env.OAR_CLAUDE_BIN ?? '/data/bin/claude')
const OUT = flag('out', fs.mkdtempSync(path.join(os.tmpdir(), 'claude-precheck-')))
const CASES = argv.length > 0 ? argv : ['steer-tool', 'steer-late', 'steer-stream', 'lifecycle', 'record', 'stop-record', 'permissions', 'missing-cli', 'not-logged-in']

fs.mkdirSync(OUT, { recursive: true })
const WORK = path.join(OUT, 'work')
const HOME = path.join(OUT, 'home')
fs.mkdirSync(WORK, { recursive: true })
fs.mkdirSync(HOME, { recursive: true })

const results = []
const record = (name, facts) => {
  results.push({ case: name, ...facts })
  console.log(JSON.stringify({ case: name, ...facts }))
}

/** A local stand-in for POST /v1/messages: records every request, then streams a scripted reply. */
function startEndpoint(options) {
  const requests = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const pathname = req.url.split('?')[0]
      if (pathname === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 100 }))
        return
      }
      if (pathname !== '/v1/messages') {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
        return
      }
      const body = raw === '' ? {} : JSON.parse(raw)
      requests.push({ at: Date.now(), body })
      stream(res, plan(body, requests.length))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }))
  })

  function plan(body, index) {
    const messages = body.messages ?? []
    const hasToolResult = messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))
    if (!hasToolResult) {
      if (options.tool === 'write') {
        return { kind: 'tool', name: 'Bash', input: { command: `printf 'written by the probe\\n' > ${options.writePath}` } }
      }
      return { kind: 'tool', name: 'Bash', input: { command: `sleep ${options.toolSleep ?? 4}` } }
    }
    return { kind: 'text', text: `after-tool req=${index}`, slow: options.slowText ?? 0 }
  }

  function stream(res, plan) {
    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    sse('message_start', { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: 'probe', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    if (plan.kind === 'text') {
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      const finish = () => {
        sse('content_block_stop', { type: 'content_block_stop', index: 0 })
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
        sse('message_stop', { type: 'message_stop' })
        res.end()
      }
      if (plan.slow > 0) {
        const words = `${plan.text} ${'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(12)}`.trim().split(' ')
        let k = 0
        const tick = setInterval(() => {
          if (k >= words.length) { clearInterval(tick); finish(); return }
          sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${words[k++]} ` } })
        }, Math.max(5, plan.slow / words.length))
        return
      }
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: plan.text } })
      finish()
      return
    }
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${Date.now()}`, name: plan.name, input: {} } })
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(plan.input) } })
    sse('content_block_stop', { type: 'content_block_stop', index: 0 })
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })
    sse('message_stop', { type: 'message_stop' })
    res.end()
  }
}

/** The arg shape OAR builds for claude: launchArgs empty, permissions from the default bypass. */
function claudeArgs(sessionId, { bare = false } = {}) {
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--replay-user-messages', '--include-partial-messages', '--session-id', sessionId,
    '--dangerously-skip-permissions', ...(bare ? ['--bare'] : []), '--model', 'probe-model']
}

// A uuid on the user message is what makes the CLI report command_lifecycle
// frames for it; without one the message has no observable lifecycle at all.
const userLine = (text, uuid) => `${JSON.stringify({ type: 'user', ...(uuid === undefined ? {} : { uuid }), message: { role: 'user', content: [{ type: 'text', text }] } })}\n`

/**
 * Run one claude session against the stand-in. `onEvent` sees every parsed
 * stdout event and may return a function to run after the event is recorded;
 * `steerAt` decides when the extra message goes in.
 */
function runClaude({ sessionId, port, configDir, cwd = WORK, bare = false, prompt = 'start', steerAt = null, steerAfterMs = null, steerText = 'STEER-ALPHA', killAfterMs = null, closeAfterResult = true }) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, claudeArgs(sessionId, { bare }), {
      cwd,
      env: { HOME, PATH: '/usr/local/bin:/usr/bin:/bin', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'probe-key', CLAUDE_CONFIG_DIR: configDir },
    })
    const events = []
    let buffer = ''
    let steered = false
    const steer = (why) => {
      if (steered) return
      steered = true
      child.stdin.write(userLine(steerText, `steer-${why}`))
      events.push({ at: Date.now(), kind: 'steer-written', why })
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let i
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        if (line.trim() === '') continue
        let event
        try { event = JSON.parse(line) } catch { continue }
        if (event.type === 'command_lifecycle') {
          events.push({ at: Date.now(), kind: 'command_lifecycle', commandUuid: event.command_uuid, state: event.state })
        }
        if (event.type === 'assistant' || event.type === 'user' || event.type === 'result' || event.type === 'system') {
          events.push({ at: Date.now(), kind: event.type, subtype: event.subtype, ts: event.timestamp,
            blocks: (event.message?.content ?? []).map((b) => b.type),
            permissionMode: event.permissionMode, apiKeySource: event.apiKeySource,
            isError: event.is_error, terminalReason: event.terminal_reason, denials: event.permission_denials })
        }
        if (steerAt === 'tool-result' && event.type === 'user' && event.tool_use_result !== undefined) steer('tool-result')
        if (steerAt === 'tool-use' && event.type === 'assistant' && (event.message?.content ?? []).some((b) => b.type === 'tool_use')) steer('tool-use')
        if (event.type === 'result' && closeAfterResult) setTimeout(() => child.stdin.end(), 600)
      }
    })
    child.stderr.on('data', () => {})
    child.stdin.write(userLine(prompt))
    if (steerAfterMs !== null) setTimeout(() => steer('delay'), steerAfterMs)
    if (killAfterMs !== null) setTimeout(() => child.kill('SIGKILL'), killAfterMs)
    child.on('exit', (code, signal) => resolve({ code, signal, events, steered }))
    setTimeout(() => child.kill('SIGKILL'), 60000)
  })
}

const shapes = (requests) => requests.map((r) => (r.body.messages ?? []).map((m) => `${m.role}:${Array.isArray(m.content) ? m.content.map((b) => (b.type === 'text' ? 'TXT' : b.type)).join('+') : '?'}`).join(' | '))
const carries = (requests, text) => requests.map((r) => JSON.stringify(r.body).includes(text))

async function withEndpoint(options, fn) {
  const endpoint = await startEndpoint(options)
  try { return await fn(endpoint) } finally { endpoint.server.close() }
}

const configDir = (name) => {
  const dir = path.join(OUT, `config-${name}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const slugFor = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-')
const recordPath = (config, cwd, sessionId) => path.join(config, 'projects', slugFor(cwd), `${sessionId}.jsonl`)

async function caseSteerTool() {
  await withEndpoint({ toolSleep: 4 }, async ({ port, requests }) => {
    const sessionId = crypto.randomUUID()
    const run = await runClaude({ sessionId, port, configDir: configDir('steer-tool'), steerAt: 'tool-use' })
    const carried = carries(requests, 'STEER-ALPHA')
    record('steer-tool', {
      requests: requests.length,
      carriedInRequest: carried,
      sameTurn: carried[1] === true,
      resultEvents: run.events.filter((e) => e.kind === 'result').length,
      shapes: shapes(requests),
    })
  })
}

async function caseSteerLate() {
  await withEndpoint({ toolSleep: 4 }, async ({ port, requests }) => {
    const sessionId = crypto.randomUUID()
    const run = await runClaude({ sessionId, port, configDir: configDir('steer-late'), steerAt: 'tool-result' })
    const carried = carries(requests, 'STEER-ALPHA')
    record('steer-late', {
      requests: requests.length,
      carriedInRequest: carried,
      sameTurn: carried[1] === true,
      resultEvents: run.events.filter((e) => e.kind === 'result').length,
      shapes: shapes(requests),
    })
  })
}

async function caseSteerStream() {
  await withEndpoint({ toolSleep: 4, slowText: 6000 }, async ({ port, requests }) => {
    const sessionId = crypto.randomUUID()
    // The tool finishes at ~4s; the final text then streams for ~6s. Steer 6s
    // in: the tool is long done, the turn is still open.
    const run = await runClaude({ sessionId, port, configDir: configDir('steer-stream'), steerAfterMs: 6000 })
    const carried = carries(requests, 'STEER-ALPHA')
    record('steer-stream', {
      requests: requests.length,
      carriedInRequest: carried,
      sameTurn: carried[1] === true,
      resultEvents: run.events.filter((e) => e.kind === 'result').length,
      shapes: shapes(requests),
    })
  })
}

async function caseRecord() {
  await withEndpoint({ toolSleep: 1 }, async ({ port }) => {
    const sessionId = crypto.randomUUID()
    const config = configDir('record')
    const run = await runClaude({ sessionId, port, configDir: config })
    const file = recordPath(config, WORK, sessionId)
    const exists = fs.existsSync(file)
    const lines = exists ? fs.readFileSync(file, 'utf8').trim().split('\n') : []
    const first = lines.length > 0 ? JSON.parse(lines[0]) : null
    const types = {}
    for (const line of lines) { const e = JSON.parse(line); types[e.type] = (types[e.type] ?? 0) + 1 }
    record('record', {
      exitCode: run.code,
      recordFile: file,
      exists,
      entries: lines.length,
      sessionIdMatches: first?.sessionId === sessionId,
      cwdRecorded: lines.some((l) => l.includes(`"cwd":"${WORK}"`)),
      types,
    })
  })
}

async function caseStopRecord() {
  await withEndpoint({ toolSleep: 6 }, async ({ port }) => {
    const sessionId = crypto.randomUUID()
    const config = configDir('stop-record')
    const run = await runClaude({ sessionId, port, configDir: config, killAfterMs: 1500 })
    const file = recordPath(config, WORK, sessionId)
    const exists = fs.existsSync(file)
    const lines = exists ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []
    record('stop-record', { signal: run.signal, exists, entries: lines.length })
  })
}

async function casePermissions() {
  const writePath = path.join(WORK, 'written.txt')
  fs.rmSync(writePath, { force: true })
  await withEndpoint({ tool: 'write', writePath }, async ({ port }) => {
    const sessionId = crypto.randomUUID()
    const run = await runClaude({ sessionId, port, configDir: configDir('permissions'), prompt: 'write it' })
    const init = run.events.find((e) => e.kind === 'system' && e.subtype === 'init')
    record('permissions', {
      exitCode: run.code,
      fileWritten: fs.existsSync(writePath),
      permissionMode: init?.permissionMode ?? null,
      permissionDenials: run.events.find((e) => e.kind === 'result')?.denials ?? null,
    })
  })
}

async function caseMissingCli() {
  const { claudeInstallation } = await import('@botiverse/oar')
  const snapshot = await claudeInstallation({ env: { PATH: '/usr/bin:/bin', HOME } })
  const pinned = await claudeInstallation({ env: { PATH: '/usr/bin:/bin', HOME, OAR_CLAUDE_BIN: '/nonexistent/claude' } })
  const present = await claudeInstallation({ env: { PATH: '/usr/bin:/bin', HOME, OAR_CLAUDE_BIN: CLAUDE } })
  record('missing-cli', { noClaudeOnPath: snapshot, pinnedMissingPath: pinned, pinnedRealPath: present })
}

async function caseNotLoggedIn() {
  const sessionId = crypto.randomUUID()
  const child = spawn(CLAUDE, ['-p', '--output-format', 'stream-json', '--verbose', '--bare', '--model', 'probe-model', 'hi'], {
    cwd: WORK,
    env: { HOME, PATH: '/usr/local/bin:/usr/bin:/bin', CLAUDE_CONFIG_DIR: configDir('not-logged-in') },
  })
  let text = ''
  child.stdout.on('data', (c) => { text += c })
  child.stderr.on('data', (c) => { text += c })
  const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)))
  const events = text.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const result = events.find((e) => e.type === 'result')
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init')
  const authMessage = events.find((e) => e.type === 'assistant' && e.error === 'authentication_failed')
  record('not-logged-in', {
    exitCode: code,
    apiKeySource: init?.apiKeySource ?? null,
    isError: result?.is_error ?? null,
    terminalReason: result?.terminal_reason ?? null,
    resultText: result?.result ?? null,
    authError: authMessage?.error ?? null,
  })
}

/**
 * The native per-message lifecycle (`command_lifecycle`) is what tells a
 * same-turn steer from one that opens a new turn: `started` before the turn's
 * `result` means the running turn took it in; after means a new turn.
 */
async function caseLifecycle() {
  for (const [label, steerAt] of [['mid-tool', 'tool-use'], ['late', 'tool-result']]) {
    await withEndpoint({ toolSleep: 4 }, async ({ port, requests }) => {
      const sessionId = crypto.randomUUID()
      const run = await runClaude({ sessionId, port, configDir: configDir(`lifecycle-${label}`), steerAt })
      const order = []
      let resultsSeen = 0
      for (const event of run.events) {
        if (event.kind === 'command_lifecycle') order.push(`${event.state}`)
        if (event.kind === 'result') { resultsSeen += 1; order.push(`result#${resultsSeen}`) }
      }
      const startedIndex = order.indexOf('started')
      const firstResultIndex = order.indexOf('result#1')
      record(`lifecycle-${label}`, {
        order,
        startedBeforeFirstResult: startedIndex >= 0 && firstResultIndex >= 0 && startedIndex < firstResultIndex,
        resultEvents: resultsSeen,
        carriedInSecondRequest: carries(requests, 'STEER-ALPHA')[1] === true,
      })
    })
  }
}

const handlers = {
  lifecycle: caseLifecycle,
  'steer-tool': caseSteerTool,
  'steer-late': caseSteerLate,
  'steer-stream': caseSteerStream,
  record: caseRecord,
  'stop-record': caseStopRecord,
  permissions: casePermissions,
  'missing-cli': caseMissingCli,
  'not-logged-in': caseNotLoggedIn,
}

for (const name of CASES) {
  const handler = handlers[name]
  if (handler === undefined) { console.error(`unknown case: ${name}`); process.exitCode = 2; continue }
  await handler()
}

fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ claude: CLAUDE, out: OUT, results }, null, 2))
console.error(`artifacts: ${OUT}`)
