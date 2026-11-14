import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const script = join(root, 'scripts/session-trace.ts')
const sessionId = 'agent-team-trace-fixture'
let home: string
let temporaryRoot: string

async function snapshot(): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const relative of (await readdir(home, { recursive: true })).sort()) {
    const file = join(home, relative)
    if ((await stat(file)).isFile()) files[relative] = createHash('sha256').update(await readFile(file)).digest('hex')
  }
  return files
}

beforeEach(async () => {
  temporaryRoot = await realpath(tmpdir())
  home = await mkdtemp(join(temporaryRoot, 'team-session-trace-'))
  await mkdir(join(home, 'storages'))
  const db = new DatabaseSync(join(home, 'storages/agent_team.sqlite'))
  try {
    db.exec('CREATE TABLE u_agent_team_operations (value TEXT NOT NULL)')
    db.prepare('INSERT INTO u_agent_team_operations (value) VALUES (?)').run(JSON.stringify({
      kind: 'team/member-added',
      data: { member: { memberId: 'member-fixture', workspaceId: 'workspace-fixture', handle: 'Vera', sessionId, state: 'enabled' } },
    }))
  } finally {
    db.close()
  }
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') })
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('JSONL persistence did not mount')
    for (const id of [sessionId, 'unrelated-session']) {
      const handle = await persistence.create({ version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: Date.now(), cwd: resolve(root), isSeeded: false, delegationDepth: 0, agentPreset: 'team-member' })
      try {
        await handle.append([{
          type: 'user/message', seq: SessionSeq(0), time: Date.now(), surfaceOp: 'append',
          data: createUserMessage({ content: [{ type: 'text', text: 'trace fixture' }], source: { kind: 'user' } }),
        }])
        await handle.flush()
      } finally {
        await handle.close()
      }
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

afterEach(async () => {
  if (home === undefined) return
  expect(dirname(home)).toBe(temporaryRoot)
  expect(basename(home).startsWith('team-session-trace-')).toBe(true)
  await rm(home, { recursive: true, force: true })
})

function cli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, ['--import', 'tsx', script, ...args, '--home', home, '--json'], {
    cwd: root,
    timeout: 15_000,
  })
}

describe('session trace CLI', () => {
  it('lists only member sessions and reads their canonical events without changing files', async () => {
    const before = await snapshot()
    const list = JSON.parse((await cli('list')).stdout)
    expect(list).toMatchObject({ command: 'list', scope: 'team members', count: 1 })
    expect(list.members).toEqual([expect.objectContaining({ handle: 'Vera', sessionId, eventCount: 1, logMissing: false })])

    const timeline = JSON.parse((await cli('timeline', 'vera', '--type', 'user/message', '--limit', '1')).stdout)
    expect(timeline).toMatchObject({ command: 'timeline', sessionId, returned: 1, seqRange: { from: 0, to: 0 } })
    expect(timeline.events).toEqual([expect.objectContaining({ seq: 0, type: 'user/message' })])

    const event = JSON.parse((await cli('event', 'Vera', '0')).stdout)
    expect(event).toMatchObject({ command: 'event', sessionId, event: { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'trace fixture' }] } } })
    const window = JSON.parse((await cli('read', 'Vera', '0', '--before', '0', '--after', '0')).stdout)
    expect(window).toMatchObject({ command: 'read', sessionId, count: 1, events: [event.event] })
    expect(await snapshot()).toEqual(before)
  })

  it('refuses an unknown member instead of searching unrelated sessions', async () => {
    await expect(cli('timeline', 'unrelated-session')).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('unknown member "unrelated-session". known handles: Vera'),
    })
  })
})
