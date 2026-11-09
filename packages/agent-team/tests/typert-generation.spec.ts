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

const EXPECTED_REMOTE_METHODS = [
  'addMember',
  'addProjectOwner',
  'archiveMember',
  'archiveProject',
  'baselineSubscription',
  'cancelMemberReminder',
  'changeAttention',
  'changeTask',
  'changes',
  'createProject',
  'createSubscription',
  'deleteSubscription',
  'environment',
  'getAttachment',
  'getHumanAvatar',
  'humanProfile',
  'inbox',
  'joinWorkspace',
  'leaveWorkspace',
  'mainStreamHistory',
  'memberReminders',
  'members',
  'pauseSubscription',
  'postMainMessage',
  'promoteThread',
  'putAttachment',
  'putHumanAvatar',
  'readMainStream',
  'readMessage',
  'readThread',
  'recoverMember',
  'removeHumanAvatar',
  'removeProjectOwner',
  'replaySubscriptionDelivery',
  'reply',
  'resetSubscriptionWebhook',
  'resolveMessageRefs',
  'resolveTaskRefs',
  'resolveThreadRefs',
  'resumeSubscription',
  'setHumanProfile',
  'setSidebarOrder',
  'sidebarOrder',
  'startThread',
  'stopWorker',
  'subscriptionDeliveries',
  'subscriptionLogs',
  'subscriptions',
  'taskBoard',
  'testSubscription',
  'testSubscriptionDraft',
  'threadHistory',
  'threadObservations',
  'transferTask',
  'updateMember',
  'updateProject',
  'updateSubscription',
  'view',
  'workerRuns',
]

describe('Agent Team generated Typert boundary', () => {
  it('publishes exactly the intended Agent Team Client boundary', () => {
    const host = TYPERT as GeneratedHost
    const client = remote as unknown as GeneratedRemote
    const hostMethods = host.invocations.map(invocation => invocation.method)
    const clientMethods = client.descriptors.map(invocation => invocation.method)
    expect([...hostMethods].sort()).toEqual(EXPECTED_REMOTE_METHODS)
    expect([...clientMethods].sort()).toEqual(EXPECTED_REMOTE_METHODS)
  })
})
