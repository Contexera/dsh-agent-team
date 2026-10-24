import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RECOVERY_KINDS,
  RECOVERY_REGISTRY,
  assertRecoveryCoverage,
  forbidHandWrittenRecovery,
  recoveryFor,
} from '../src/recovery-hints.ts'

/** The situations the model-facing code can actually produce, by hand. */
const PRODUCED_KINDS: readonly string[] = Object.freeze([
  'unread_required',
  'main_unread_required',
  'project_owner_required',
  'not_project_member',
  'main_stream_addressing',
  'post_requires_project',
  'unread_remaining',
  'stale_revision',
  'stale_revision_token_unrecognized',
  'member_not_following',
  'missing_thread_identity',
  'missing_message_ref',
  'history_only_arguments',
  'action_only_arguments',
  'missing_write_token',
  'start_requires_project',
  'dm_requires_member',
  'claim_requires_direction',
  'claim_close_requires_ref',
  'list_takes_task_only',
  'claim_owned_by_another',
  'reply_target_unknown',
  'attachment_path_rejected',
  'unknown_ref',
  'ambiguous_ref',
  'workspace_required',
  'workspace_ambiguous',
  'workspace_not_participating',
])

describe('the registry covers exactly the situations the Team produces', () => {
  it('every produced situation has an entry, and every entry is reachable', () => {
    expect(() => assertRecoveryCoverage(PRODUCED_KINDS)).not.toThrow()
  })

  it('a new produced situation with no entry fails, so a rejection cannot ship without a way out', () => {
    // The mutation this pins: someone adds a rejection kind and forgets the entry.
    expect(() => assertRecoveryCoverage([...PRODUCED_KINDS, 'some_new_fault'])).toThrow(/some_new_fault/)
  })

  it('a new entry nothing reaches fails, so dead coverage cannot read as protection', () => {
    // The mutation this pins: someone adds an entry, then the rejecting code changes
    // shape and stops producing that kind — the entry silently becomes a lie.
    expect(() => assertRecoveryCoverage(PRODUCED_KINDS.filter(kind => kind !== 'workspace_required'))).toThrow(/workspace_required/)
  })

  it('the list is in the registry: a kind dropped from the registry is a coverage failure, not a missing word', () => {
    for (const kind of PRODUCED_KINDS) expect(RECOVERY_KINDS).toContain(kind)
  })
})

describe('every entry names an action and the value that action takes', () => {
  it('no entry renders an empty line, and none is a bare fault restatement', () => {
    for (const entry of RECOVERY_REGISTRY) {
      const line = entry.sentence({ refused: 'thread:ref', threadRef: 'thread:ref', taskRef: 'task:ref', action: 'done' })
      expect(line.length).toBeGreaterThan(20)
      // A way out must name something to do: a verb the model can perform, or a
      // tool/parameter it can pass. Restating the fault is not a recovery.
      expect(line).toMatch(/\b(read|copy|drain|retry|drop|use|choose|reuse|split|collect|stop|fix|ask|point|list|check)\b/i)
    }
  })

  it('every kind is unique, so a lookup cannot silently bind two entries', () => {
    const kinds = RECOVERY_REGISTRY.map(entry => entry.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('lookup is exact: an unknown kind throws instead of falling back to a neighbour', () => {
    expect(() => recoveryFor('nope')).toThrow(/no registered recovery/)
  })

  it('an entry that names a refused value echoes it, so the line is concrete rather than abstract', () => {
    // The mutation this pins: a sentence stops interpolating `refused` and starts
    // describing the value instead of naming it, which the model cannot act on.
    expect(recoveryFor('reply_target_unknown').sentence({ refused: 'message:abc' })).toContain('message:abc')
    expect(recoveryFor('workspace_required').sentence({ refused: 'workspace:a, workspace:b' })).toContain('workspace:b')
  })
})

describe('a hand-written recovery route in model-facing source is refused', () => {
  it('an imperative route sentence outside the registry fails, with its line', () => {
    expect(() => forbidHandWrittenRecovery('throw new Error("copy the threadRef from team_view, then retry")', 'src/x.ts')).toThrow(/spells a recovery route by hand/)
  })

  it('the registry file itself is exempt, because that is where the routes live', () => {
    expect(() => forbidHandWrittenRecovery('copy the ref from team_view, then retry', 'src/recovery-hints.ts')).not.toThrow()
  })

  it('a comment describing a route is prose, not a route, so it does not fail', () => {
    expect(() => forbidHandWrittenRecovery('// the caller must copy the ref from team_view, then retry\nconst x = 1', 'src/x.ts')).not.toThrow()
  })

  it('a fault with no route sentence passes, because not every sentence is a way out', () => {
    expect(() => forbidHandWrittenRecovery('throw new Error("workspace is required")', 'src/x.ts')).not.toThrow()
  })

  it('the shipped model-facing source is clean, so a route written outside the registry fails the suite', () => {
    // This is the check that makes the registry load-bearing rather than
    // aspirational: it reads the files a model actually sees rejections from
    // and refuses a route sentence in any of them. The mutation it pins is
    // someone reverting one call site to a hand-written sentence — the render
    // tests would stay green, because the words would still be there.
    const sources = [...MODEL_FACING_SOURCES]
    expect(sources.length).toBeGreaterThan(0)
    for (const [name, source] of sources) expect(() => forbidHandWrittenRecovery(source, name), `${name} spells a route by hand`).not.toThrow()
  })
})

/** Every source file whose thrown text reaches a model, as `[name, source]`. */
const MODEL_FACING_SOURCES: readonly (readonly [string, string])[] = await readModelFacingSources()

/** Walk the two source roots that produce model-facing text, skipping the registry itself. */
async function readModelFacingSources(): Promise<readonly (readonly [string, string])[]> {
  const root = resolve(import.meta.dirname, '../../../')
  const found: (readonly [string, string])[] = []
  for (const packageDirectory of ['packages/agent-team/src', 'packages/tool-agent-team/src']) {
    for (const entry of await readdir(join(root, packageDirectory), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
      if (entry.name === 'recovery-hints.ts') continue
      found.push([`${packageDirectory}/${entry.name}`, await readFile(join(root, packageDirectory, entry.name), 'utf8')])
    }
  }
  return found
}
