import { describe, expect, it } from 'vitest'
import { mentionSurfaceOf, mentionTierIsParticipant } from '../src/client/mention-presentation.ts'

describe('mention row weight', () => {
  it('reads the surface from the draft key the composer already writes to', () => {
    expect(mentionSurfaceOf('thread:thread:one' as never)).toBe('thread')
    expect(mentionSurfaceOf('project:project:one' as never)).toBe('project')
  })

  it('puts a Thread\'s followers inside it and every other tier outside', () => {
    expect(mentionTierIsParticipant('thread-follower', 'thread')).toBe(true)
    // A Project peer takes part in the Project, yet not in this Thread.
    expect(mentionTierIsParticipant('project-peer', 'thread')).toBe(false)
    expect(mentionTierIsParticipant('workspace', 'thread')).toBe(false)
  })

  it('puts a Project peer inside the Project, because the Project is the conversation', () => {
    // A Project row never carries the follower tier — the Project surface is
    // handed no follower set — so membership is what separates its two
    // reachable tiers.
    expect(mentionTierIsParticipant('project-peer', 'project')).toBe(true)
    expect(mentionTierIsParticipant('workspace', 'project')).toBe(false)
  })
})
