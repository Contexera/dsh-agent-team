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

describe('Agent Team generated Typert boundary', () => {
  it('publishes the complete Agent Team Client boundary', () => {
    const host = TYPERT as GeneratedHost
    const client = remote as unknown as GeneratedRemote
    const expected = [
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
      'joinChannel',
      'joinWorkspace',
      'leaveWorkspace',
      'members',
      'promoteThread',
      'putAttachment',
      'putHumanAvatar',
      'readThread',
      'recoverMember',
      'removeChannelMember',
      'removeHumanAvatar',
      'reply',
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
    expect(host.invocations.map(invocation => invocation.method).sort()).toEqual(expected)
    expect(client.descriptors.map(invocation => invocation.method).sort()).toEqual(expected)
  })
})
