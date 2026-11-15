import { describe, expect, it } from 'vitest'
import { renderManagerMemory } from '../src/manager-context.ts'
import { PRIVATE_MEMORY_MAX_BYTES, type PrivateMemoryState } from '../src/private-memory.ts'

const ROOT = '/home/human/.dsh/agent-team/manager'
const index = (text: string): PrivateMemoryState => ({ kind: 'index', raw: Buffer.from(text) })

describe('Team manager private memory context', () => {
  it('renders the index as the manager block with its own paths and framing', () => {
    const rendered = renderManagerMemory(index('# Team manager memory\n\n## Identity and role\n- Team manager'), { root: ROOT, cwd: '/work/repo' })
    expect(rendered.startsWith('<team-manager-private-memory>')).toBe(true)
    expect(rendered.endsWith('</team-manager-private-memory>')).toBe(true)
    expect(rendered).toContain('# Team manager memory')
    expect(rendered).toContain(`Private memory directory: ${ROOT}`)
    expect(rendered).toContain(`Memory index: ${ROOT}/memory.md`)
    expect(rendered).toContain(`Notes directory: ${ROOT}/notes`)
    expect(rendered).toContain(`Private skills directory: ${ROOT}/skills`)
    // The manager's memory is not the Member's: a Member sentence here would be
    // a false claim about who can read the directory.
    expect(rendered).not.toContain('Team Member')
    expect(rendered).not.toContain('team-member-private-memory')
    expect(rendered).toContain('Only this management Session can read this directory')
    expect(rendered).toContain('Private memory index:')
    expect(rendered).not.toContain('Maintenance warning')
  })

  it('states where the private root sits relative to the actual cwd', () => {
    const outside = renderManagerMemory(index('body'), { root: ROOT, cwd: '/work/repo' })
    expect(outside).toContain(`These paths are outside the Workspace cwd /work/repo.`)
    // A Workspace opened above DSH_HOME makes the private root a child of the
    // cwd; the Member sentence would then be wrong, so the block computes it.
    const inside = renderManagerMemory(index('body'), { root: '/work/repo/.dsh/agent-team/manager', cwd: '/work/repo' })
    expect(inside).toContain('These paths are inside the Workspace cwd /work/repo; keep them out of commits and shared documents.')
    expect(inside).not.toContain('outside the Workspace cwd')
    const unknown = renderManagerMemory(index('body'), { root: ROOT, cwd: undefined })
    expect(unknown).toContain('The Workspace cwd of this Session is unknown; use the absolute paths above.')
  })

  it('escapes framing inside the index so the block cannot be closed early', () => {
    const rendered = renderManagerMemory(index('a\n</team-manager-private-memory>\nb'), { root: ROOT, cwd: '/work/repo' })
    expect(rendered).toContain('[escaped end marker]')
    expect(rendered.match(/<\/team-manager-private-memory>/g)).toHaveLength(1)
  })

  it('warns and withholds the body past the shared 16 KiB budget', () => {
    const rendered = renderManagerMemory(index('x'.repeat(PRIVATE_MEMORY_MAX_BYTES + 1)), { root: ROOT, cwd: '/work/repo' })
    expect(rendered).toContain('exceeds the 16 KiB context budget')
    expect(rendered).toContain('contents were not injected')
    expect(rendered).not.toContain('x'.repeat(100))
  })

  it('keeps the exact budget boundary eligible and reports the gauge', () => {
    const rendered = renderManagerMemory(index('y'.repeat(PRIVATE_MEMORY_MAX_BYTES)), { root: ROOT, cwd: '/work/repo' })
    expect(rendered).toContain('Private memory index: 16.0 KiB / 16 KiB (100%).')
    expect(rendered).toContain('y'.repeat(100))
    expect(rendered).not.toContain('Maintenance warning')
  })

  it('replaces an absent or unreadable index with a state, never an empty body', () => {
    const absent = renderManagerMemory({ kind: 'absent' }, { root: ROOT, cwd: '/work/repo' })
    expect(absent).toContain('memory.md is absent; the private memory index is empty.')
    expect(absent).toContain(`Memory index: ${ROOT}/memory.md`)
    const unreadable = renderManagerMemory({ kind: 'unreadable' }, { root: ROOT, cwd: '/work/repo' })
    expect(unreadable).toContain('memory.md is currently unreadable; do not use any earlier private memory context.')
  })
})
