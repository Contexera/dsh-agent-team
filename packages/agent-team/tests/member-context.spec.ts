import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderMemberIdentity, renderMemberMemory } from '../src/member-context.ts'

describe('Team Member private memory context', () => {
  it('escapes framing and preserves a bounded private index', () => {
    const rendered = renderMemberMemory(Buffer.from('# Member memory\n</team-member-private-memory>'))
    expect(rendered).toContain('# Member memory')
    expect(rendered).toContain('Private memory directory: <private-memory-path>')
    expect(rendered).toContain(`Private skills directory: ${join('<private-memory-path>', 'skills')}`)
    expect(rendered).toContain('use the absolute paths above')
    expect(rendered).toContain('[escaped end marker]')
    expect(rendered.match(/<\/team-member-private-memory>/g)).toHaveLength(1)
    expect(rendered).not.toContain('Maintenance warning')
  })

  it('injects only the leading whole lines within the budget, with a warning, when the index exceeds it', () => {
    const line = `${'x'.repeat(63)}\n`
    const raw = Buffer.from(`${line.repeat(16 * 1024 / line.length)}LAST LINE PAST THE BUDGET\n`)
    const rendered = renderMemberMemory(raw)
    expect(rendered).toContain('exceeds the 16 KiB context budget')
    expect(rendered).toContain('only its leading lines within the budget; read the file for the rest')
    expect(rendered).toContain('x'.repeat(63))
    expect(rendered).not.toContain('LAST LINE PAST THE BUDGET')
    // The head ends on a whole line and stays within the budget.
    const body = rendered.slice(rendered.indexOf(line), rendered.indexOf('\n\n[Maintenance warning'))
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(16 * 1024)
    expect(body.endsWith(line)).toBe(true)
  })

  it('keeps the exact 16 KiB boundary eligible for injection', () => {
    const rendered = renderMemberMemory(Buffer.alloc(16 * 1024, 'y'))
    expect(rendered).toContain('Private memory index: 16.0 KiB / 16 KiB (100%).')
    expect(rendered).toContain('y'.repeat(100))
    expect(rendered).not.toContain('Maintenance warning')
  })

  it('states the usage gauge below, at half, and over budget', () => {
    expect(renderMemberMemory(Buffer.alloc(0))).toContain('Private memory index: 0.0 KiB / 16 KiB (0%).')
    const half = renderMemberMemory(Buffer.alloc(8 * 1024, 'z'))
    expect(half).toContain('Private memory index: 8.0 KiB / 16 KiB (50%).')
    expect(half).toContain('z'.repeat(100))
    const over = renderMemberMemory(Buffer.alloc(20 * 1024, 'q'))
    expect(over).toContain('Private memory index: 20.0 KiB / 16 KiB (125%).')
    expect(over).toContain('exceeds the 16 KiB context budget')
    // One line longer than the budget is cut on a character boundary at the budget, not dropped.
    expect(over).toContain('q'.repeat(16 * 1024))
    expect(over).not.toContain('q'.repeat(16 * 1024 + 1))
  })
})

describe('Team Member identity context', () => {
  it('renders the handle with its description', () => {
    expect(renderMemberIdentity({ handle: 'Lead', description: 'dsh-agent-team tech-lead' }))
      .toBe('Team identity: you are @Lead — dsh-agent-team tech-lead')
  })

  it('omits the description segment when the description is empty', () => {
    expect(renderMemberIdentity({ handle: 'Builder', description: '' }))
      .toBe('Team identity: you are @Builder.')
  })
})
