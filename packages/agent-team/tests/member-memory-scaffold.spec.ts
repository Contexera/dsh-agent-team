import { describe, expect, it } from 'vitest'
// Slow CI machines (windows lane) can stretch multi-generation rollover
// chains past the default per-test budget. Every test here boots a real
// Host harness and waits on asynchronous session transitions, so both this
// per-test budget and the waitFor deadline below (kept equal) need headroom.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'

import { realHarness, requestId } from './helpers/member-harness.ts'

describe('Agent Team private memory scaffold language (issue #43 #4)', () => {
  it('scaffolds a structural index and never overwrites an existing memory.md', async () => {
    const h = await realHarness()
    const builder = await h.human.addMember('builder', { description: 'Builds the implementation' })
    const memoryPath = join(builder.raw.privateMemoryPath, 'memory.md')
    const scaffold = await readFile(memoryPath, 'utf8')
    // Structural labels, not English prose sentences: the writing rules live in
    // the bundled skill the scaffold points at.
    expect(scaffold).toContain('- <scope>')
    expect(scaffold).toContain('- <rule>')
    expect(scaffold).toContain('- <work in hand>')
    expect(scaffold).not.toContain('what this Member owns')
    expect(scaffold).not.toContain('only rules that must bind')

    // The Member owns the file after creation: a later activation pass (here a
    // suspend/resume round trip re-runs the scaffold) must leave it alone.
    await writeFile(memoryPath, '# Member memory\n\nhand-written\n')
    await h.ctx.agentTeam.suspendMember({ requestId: requestId('scaffold-suspend'), memberId: builder.memberId })
    await h.ctx.agentTeam.resumeMember({ requestId: requestId('scaffold-resume'), memberId: builder.memberId })
    expect(await readFile(memoryPath, 'utf8')).toBe('# Member memory\n\nhand-written\n')
  })
})
