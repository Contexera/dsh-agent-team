import { describe, expect, it } from 'vitest'
import { TYPERT } from '../lib/typert.host.js'
import remote from '../lib/typert.remote-client.js'

interface GeneratedInvocation {
  readonly method: string
}

interface GeneratedHost {
  readonly invocations: readonly GeneratedInvocation[]
}

interface GeneratedRemote {
  readonly descriptors: readonly GeneratedInvocation[]
}

// The Client boundary, written out by hand.
//
// This list is deliberately NOT derived from anything in this run. The version
// this file replaced compared the host artifact against the remote artifact —
// both emitted by one generator call — so the two sides could not disagree and
// the assertion could never fail. What that misses is the question that
// matters: is the boundary still the one we intend to publish? Only a
// hand-written expected set can answer it, so adding a Remote method with no
// caller, or renaming one out from under the Client, fails here.
//
// Keeping this list costs one line per method and buys the answer; treat an
// edit to it as a statement about the public boundary, not as test maintenance.
const EXPECTED_REMOTE_METHODS = [
  'addMember',
  'archiveChannel',
  'archiveMember',
  'changeAttention',
  'changeTask',
  'changes',
  'clearMemberContext',
  'contextJudge',
  'createChannel',
  'environment',
  'getAttachment',
  'getHumanAvatar',
  'humanProfile',
  'inbox',
  'joinWorkspace',
  'leaveWorkspace',
  'members',
  'promoteThread',
  'putAttachment',
  'putHumanAvatar',
  'readMessage',
  'readThread',
  'recoverMember',
  'removeHumanAvatar',
  'reply',
  'resolveMessageRefs',
  'resolveTaskRefs',
  'resolveThreadRefs',
  'sendMessage',
  'setHumanProfile',
  'threadHistory',
  'threadObservations',
  'updateChannel',
  'updateMember',
  'view',
]

describe('Agent Team generated Typert boundary', () => {
  it('publishes exactly the intended Agent Team Client boundary', () => {
    const host = TYPERT as GeneratedHost
    const client = remote as unknown as GeneratedRemote
    const hostMethods = host.invocations.map(invocation => invocation.method)
    const clientMethods = client.descriptors.map(invocation => invocation.method)
    // Sorted once here so the diff output reads as a set difference, not noise.
    expect([...hostMethods].sort()).toEqual(EXPECTED_REMOTE_METHODS)
    expect([...clientMethods].sort()).toEqual(EXPECTED_REMOTE_METHODS)
  })

  // The generator emits both artifacts from one analysis, so a host/remote
  // disagreement is not the failure mode worth guarding on its own — but it is
  // still cheaper to name than to debug, and it costs nothing next to the above.
  it('keeps the host and remote artifacts in agreement', () => {
    const host = TYPERT as GeneratedHost
    const client = remote as unknown as GeneratedRemote
    expect(host.invocations.map(invocation => invocation.method).sort())
      .toEqual(client.descriptors.map(invocation => invocation.method).sort())
  })
})
