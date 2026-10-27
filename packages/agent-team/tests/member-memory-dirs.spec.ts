import { afterEach, describe, expect, it, vi } from 'vitest'
// Slow CI machines (windows lane) can stretch multi-generation rollover
// chains past the default per-test budget. Every test here boots a real
// Host harness and waits on asynchronous session transitions, so both this
// per-test budget and the waitFor deadline below (kept equal) need headroom.
vi.setConfig({ testTimeout: 60_000 })
import { SessionId } from '@deepseek-ai/dsh-session'
import { writeFile } from 'node:fs/promises'
import type { AgentTeamMemberId } from '../src/types.ts'

import { access, mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

import { realHarness, requestId } from './helpers/member-harness.ts'



describe('Agent Team Member private memory directory sanitization (issue #7)', () => {
  it('derives a Windows-safe directory segment without touching the member ref', async () => {
    const { memberMemoryDirectoryName } = await import('../src/member-runtime.ts')
    const memberId = 'member:9d903b7c-0f9f-4d7c-8be9-3f5c0f8f1a2b' as AgentTeamMemberId
    expect(memberMemoryDirectoryName(memberId)).toBe('member-9d903b7c-0f9f-4d7c-8be9-3f5c0f8f1a2b')
    // No path-segment-forbidden characters remain on any platform.
    expect(memberMemoryDirectoryName(memberId)).not.toContain(':')
  })

  it('sanitizes only the final segment of a legacy colon path on any platform', async () => {
    // F8: the fallback must be segment arithmetic, not whole-string length
    // math on the memberId. A Windows drive-letter prefix keeps its colon; a
    // recorded path whose final segment is not the memberId no longer
    // crashes and still resolves to the member's sanitized directory.
    const { memberMemoryDirectoryPath } = await import('../src/member-runtime.ts')
    const memberId = 'member:1a2b3c4d-0000-4000-8000-000000000001' as AgentTeamMemberId
    expect(memberMemoryDirectoryPath({ memberId, privateMemoryPath: '/home/yu/.dsh/agent-team/members/member:1a2b3c4d-0000-4000-8000-000000000001' }))
      .toBe('/home/yu/.dsh/agent-team/members/member-1a2b3c4d-0000-4000-8000-000000000001')
    expect(memberMemoryDirectoryPath({ memberId, privateMemoryPath: 'C:\\Users\\team\\.dsh\\agent-team\\members\\member:1a2b3c4d-0000-4000-8000-000000000001' }))
      .toBe('C:\\Users\\team\\.dsh\\agent-team\\members\\member-1a2b3c4d-0000-4000-8000-000000000001')
    // A colon-free final segment keeps the recorded path verbatim even when
    // earlier segments carry the Windows drive-letter colon — a member
    // record without a memberId never reaches the rewrite branch.
    expect(memberMemoryDirectoryPath({ memberId: undefined as never, privateMemoryPath: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\team-member-memory-x' }))
      .toBe('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\team-member-memory-x')
    expect(memberMemoryDirectoryPath({ memberId, privateMemoryPath: 'C:\\dsh-homes\\team\\.dsh\\agent-team\\members\\a1' }))
      .toBe('C:\\dsh-homes\\team\\.dsh\\agent-team\\members\\a1')
    // A colon in the final segment without any separator collapses to the
    // sanitized member name.
    expect(memberMemoryDirectoryPath({ memberId, privateMemoryPath: 'member:1a2b3c4d-0000-4000-8000-000000000001' }))
      .toBe('member-1a2b3c4d-0000-4000-8000-000000000001')
  })

  it('provisions new Members under a colon-free private memory path', async () => {
    const { ctx, workspaceId } = await realHarness()
    await ctx.agentTeam.createProject({ requestId: requestId('san-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('san-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [] })
    const member = added.status.member
    expect(member.memberId).toContain(':')
    // The colon-free guarantee is about the directory segment: a Windows
    // absolute prefix still carries its drive-letter colon (F7b).
    const recordedDirectory = member.privateMemoryPath.replaceAll('\\', '/')
    expect(basename(recordedDirectory)).not.toContain(':')
    expect(recordedDirectory).toContain(member.memberId.replaceAll(':', '-'))
    await expect(access(join(member.privateMemoryPath, 'notes'))).resolves.toBeUndefined()
    await expect(access(join(member.privateMemoryPath, 'skills'))).resolves.toBeUndefined()
    await expect(access(join(member.privateMemoryPath, 'memory.md'))).resolves.toBeUndefined()
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('migrates a legacy colon directory onto the sanitized path on activation, preserving memory', async () => {
    const { ctx } = await realHarness()
    // Exercise the migration seam directly with a synthetic pre-fix Member
    // record: the ledger recorded the colon path and the colon directory
    // holds the Member's existing private memory. On Windows the colon
    // directory cannot be constructed at all (NTFS parses it as an ADS
    // separator), so the legacy record there is the path-only form (F7c).
    const memberId = 'member:1a2b3c4d-0000-4000-8000-000000000001' as AgentTeamMemberId
    const parent = join(process.env.DSH_HOME!, 'agent-team', 'members')
    const legacyPath = join(parent, memberId)
    const sanitized = join(parent, memberId.replaceAll(':', '-'))
    const legacyDirectoryExists = process.platform !== 'win32'
    if (legacyDirectoryExists) {
      await mkdir(join(legacyPath, 'notes'), { recursive: true })
      await writeFile(join(legacyPath, 'notes', 'kept.md'), 'persistent note')
      await writeFile(join(legacyPath, 'memory.md'), '# Member memory\n\n## Stable facts\n- legacy fact\n')
    }

    const { MemberRuntime } = await import('../src/member-runtime.ts')
    const runtime = new MemberRuntime({ ctx: ctx as never, liveMemberContext: () => { throw new Error('unused') }, runningAgents: new Set() })
    await runtime.initializePrivateMemory(sanitized, legacyPath)

    if (legacyDirectoryExists) {
      // The sanitized directory now holds the migrated memory; the colon
      // directory is gone (renamed, not copied).
      await expect(readFile(join(sanitized, 'notes', 'kept.md'), 'utf8')).resolves.toBe('persistent note')
      await expect(readFile(join(sanitized, 'memory.md'), 'utf8')).resolves.toContain('legacy fact')
      await expect(access(legacyPath)).rejects.toThrow()
    } else {
      // Windows: no legacy directory could exist, so activation provisions
      // the sanitized directory from scratch without throwing.
      await expect(access(join(sanitized, 'notes'))).resolves.toBeUndefined()
    }

    // Re-running activation is idempotent: sanitized wins, no throw.
    await runtime.initializePrivateMemory(sanitized, legacyPath)
    if (legacyDirectoryExists) {
      await expect(readFile(join(sanitized, 'notes', 'kept.md'), 'utf8')).resolves.toBe('persistent note')
    }
  })

  it('refuses to migrate recorded private memory that lives under another DSH home', async () => {
    const { ctx, root } = await realHarness()
    // The recorded path is a durable absolute fact. In a process resolving a
    // different DSH home (an isolated test home, a second instance) the
    // sanitized target lands in THAT home while the record still names the real
    // Member directory; renaming across trees took one whole private memory out
    // of ~/.dsh on 2026-09-13, silently. The live harness keeps DSH_HOME at
    // <root>/dsh-home, so <root>/other-home is a foreign home.
    const memberId = 'member:1a2b3c4d-0000-4000-8000-000000000003' as AgentTeamMemberId
    const legacyPath = join(root, 'other-home', 'agent-team', 'members', memberId.replaceAll(':', '-'))
    await mkdir(join(legacyPath, 'notes'), { recursive: true })
    await writeFile(join(legacyPath, 'notes', 'kept.md'), 'real private memory')
    const sanitized = join(process.env.DSH_HOME!, 'agent-team', 'members', memberId.replaceAll(':', '-'))

    const { MemberRuntime } = await import('../src/member-runtime.ts')
    const runtime = new MemberRuntime({ ctx: ctx as never, liveMemberContext: () => { throw new Error('unused') }, runningAgents: new Set() })
    await runtime.initializePrivateMemory(sanitized, legacyPath)

    // The foreign directory is untouched — not moved, and not copied either: a
    // copy would leak the Member's private memory into the foreign home.
    await expect(readFile(join(legacyPath, 'notes', 'kept.md'), 'utf8')).resolves.toBe('real private memory')
    await expect(access(join(legacyPath, 'memory.md'))).rejects.toThrow()
    // This home still provisions the Member, from scratch and in place.
    await expect(readFile(join(sanitized, 'memory.md'), 'utf8')).resolves.toContain('# Member memory')
    await expect(access(join(sanitized, 'notes'))).resolves.toBeUndefined()
  })

  it('deletes recorded private memory only inside this DSH home', async () => {
    const { ctx, root, archived } = await realHarness()
    const { MemberRuntime } = await import('../src/member-runtime.ts')
    const runtime = new MemberRuntime({ ctx: ctx as never, liveMemberContext: () => { throw new Error('unused') }, runningAgents: new Set() })

    // A removal running under another DSH home must not delete the directory
    // the record names: that is the real Member's private memory, and this is
    // the shape that wiped three live directories on 2026-08-23.
    const foreignId = 'member:1a2b3c4d-0000-4000-8000-000000000004' as AgentTeamMemberId
    // Containment is about the location, not the spelling: this arm only needs
    // a directory outside this process's members root, so it uses the sanitized
    // name — win32 cannot create a colon directory at all (the colon is an NTFS
    // alternate-data-stream separator, so mkdir reports ENOENT). The colon
    // spelling is covered by the same-home arm below, gated to the platforms
    // that can hold such a directory.
    const foreignPath = join(root, 'other-home', 'agent-team', 'members', foreignId.replaceAll(':', '-'))
    await mkdir(join(foreignPath, 'notes'), { recursive: true })
    await writeFile(join(foreignPath, 'notes', 'kept.md'), 'real private memory')
    await runtime.cleanupRemovedMember({ memberId: foreignId, sessionId: SessionId('session:probe-foreign-cleanup'), privateMemoryPath: foreignPath } as never)
    await expect(readFile(join(foreignPath, 'notes', 'kept.md'), 'utf8')).resolves.toBe('real private memory')

    // Same home: both the recorded legacy colon directory and its sanitized
    // spelling are this process's to remove.
    const parent = join(process.env.DSH_HOME!, 'agent-team', 'members')
    const localId = 'member:1a2b3c4d-0000-4000-8000-000000000005' as AgentTeamMemberId
    const colonPath = join(parent, localId)
    const sanitizedPath = join(parent, localId.replaceAll(':', '-'))
    const colonDirectoryExists = process.platform !== 'win32'
    if (colonDirectoryExists) await mkdir(join(colonPath, 'notes'), { recursive: true })
    await mkdir(join(sanitizedPath, 'notes'), { recursive: true })
    await runtime.cleanupRemovedMember({ memberId: localId, sessionId: SessionId('session:probe-local-cleanup'), privateMemoryPath: colonPath } as never)
    await expect(access(sanitizedPath)).rejects.toThrow()
    if (colonDirectoryExists) await expect(access(colonPath)).rejects.toThrow()

    // The refusal is scoped to the filesystem: both Sessions are archived.
    expect(archived).toEqual([SessionId('session:probe-foreign-cleanup'), SessionId('session:probe-local-cleanup')])
  })

  it('merges a hand-created colon twin directory into the sanitized root on activation', async () => {
    const { ctx } = await realHarness()
    const memberId = 'member:1a2b3c4d-0000-4000-8000-000000000002' as AgentTeamMemberId
    const parent = join(process.env.DSH_HOME!, 'agent-team', 'members')
    const sanitized = join(parent, memberId.replaceAll(':', '-'))
    const twin = join(parent, memberId)
    const twinDirectoryExists = process.platform !== 'win32'
    // The live root pre-exists (the injected paths and skill provider point
    // at it) with its own memory.md and one note the twin does not know.
    await mkdir(join(sanitized, 'notes'), { recursive: true })
    await writeFile(join(sanitized, 'memory.md'), '# Member memory\n\n## Stable facts\n- live root fact\n')
    await writeFile(join(sanitized, 'notes', 'live-only.md'), 'live root note')
    if (twinDirectoryExists) {
      await mkdir(join(twin, 'notes'), { recursive: true })
      await writeFile(join(twin, 'notes', 'twin-only.md'), 'twin note')
      await writeFile(join(twin, 'memory.md'), '# Member memory\n\n## Stable facts\n- twin fact\n')
      // A nested twin-only skill survives the merge at its own relative path.
      await mkdir(join(twin, 'skills', 'probe'), { recursive: true })
      await writeFile(join(twin, 'skills', 'probe', 'SKILL.md'), 'twin skill')
    }

    const { MemberRuntime } = await import('../src/member-runtime.ts')
    const runtime = new MemberRuntime({ ctx: ctx as never, liveMemberContext: () => { throw new Error('unused') }, runningAgents: new Set() })
    // No legacyPath argument: the ledger never recorded the twin.
    await runtime.initializePrivateMemory(sanitized)

    if (twinDirectoryExists) {
      // Content preservation: every twin-only file moved into the live root.
      await expect(readFile(join(sanitized, 'notes', 'twin-only.md'), 'utf8')).resolves.toBe('twin note')
      await expect(readFile(join(sanitized, 'skills', 'probe', 'SKILL.md'), 'utf8')).resolves.toBe('twin skill')
      await expect(readFile(join(sanitized, 'notes', 'live-only.md'), 'utf8')).resolves.toBe('live root note')
      // Conflict resolution is explicit: the live root's memory.md wins; the
      // twin's losing copy stays traceable beside it, never silently dropped.
      await expect(readFile(join(sanitized, 'memory.md'), 'utf8')).resolves.toContain('live root fact')
      await expect(readFile(join(sanitized, 'memory.colon-twin.md'), 'utf8')).resolves.toContain('twin fact')
      // The twin directory itself is gone: the drift cannot silently recur.
      await expect(access(twin)).rejects.toThrow()
    }

    // Idempotent: a second activation without any twin present is a no-op
    // and keeps every merged file.
    await runtime.initializePrivateMemory(sanitized)
    if (twinDirectoryExists) {
      await expect(readFile(join(sanitized, 'notes', 'twin-only.md'), 'utf8')).resolves.toBe('twin note')
      await expect(readFile(join(sanitized, 'memory.md'), 'utf8')).resolves.toContain('live root fact')
      await expect(access(join(sanitized, 'notes'))).resolves.toBeUndefined()
    }
  })
})
