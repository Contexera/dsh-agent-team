import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentTeamMemberCapabilities } from '../src/types.ts'
import { attachmentsRoot } from '../src/attachments.ts'
import { EmptyAdapter, realHarness, requestId } from './helpers/member-harness.ts'

const spillRoot = mkdtempSync(join(tmpdir(), 'dsh-team-attach-boundary-'))
let fileId = 0

const removeSpillRoot = (): void => {
  rmSync(spillRoot, { recursive: true, force: true })
}
afterAll(removeSpillRoot)
process.once('exit', removeSpillRoot)

/** One file inside the calling Member's working directory and one outside it, plus a symlink inside that points out. */
function attachFixtures(checkout: string) {
  const inside = join(checkout, `inside-${fileId}.txt`)
  writeFileSync(inside, `inside-${fileId}`)
  const outside = join(spillRoot, `outside-${fileId++}.txt`)
  writeFileSync(outside, 'outside')
  const link = join(checkout, `linked-${fileId}.txt`)
  symlinkSync(outside, link)
  return { inside, outside, link }
}

/** The cache entries this attempt would write, so a refusal can be shown to leave the cache untouched. */
async function cacheEntries(): Promise<readonly string[]> {
  return (await readdir(attachmentsRoot()).catch(() => [] as string[])).sort()
}

/** A Main stream post requires the Member to hold every pending entry complete; draining the Human create's notification readies it. */
async function drainMainStream(test: Awaited<ReturnType<typeof memberHarness>>['test'], agent: Awaited<ReturnType<typeof memberHarness>>['agent'], projectRef: Awaited<ReturnType<typeof memberHarness>>['projectRef']): Promise<void> {
  await test.ctx.agentTeam.readMainStreamForAgent(agent, { requestId: requestId(`attach-drain-${fileId}`), workspaceId: test.workspaceId, projectRef })
}

async function memberHarness(options: { readonly readTool?: 'read' | 'read_image' | undefined; readonly shell?: boolean; readonly capabilities?: AgentTeamMemberCapabilities }) {
  const test = await realHarness(new EmptyAdapter(), 'jsonl', undefined, false, undefined, 'memory',
    { memberShellTool: options.shell ?? false, ...(options.readTool === undefined ? {} : { memberReadTool: options.readTool }) })
  const project = await test.ctx.agentTeam.createProject({ requestId: requestId(`attach-project-${fileId}`), workspaceId: test.workspaceId,
    name: 'attach', description: '' })
  const projectRef = project.project.projectRef
  const added = await test.ctx.agentTeam.addMember({ requestId: requestId(`attach-member-${fileId}`), workspaceId: test.workspaceId,
    handle: `writer${fileId}`, description: '', presetId: 'team-member', projectRefs: [projectRef], model: { provider: 'mock', model: 'mock' },
    ...options.capabilities === undefined ? {} : { capabilities: options.capabilities } })
  const memberId = added.status.member.memberId
  await test.ctx.agentTeam.addProjectOwner({ requestId: requestId(`attach-owner-${fileId}`), workspaceId: test.workspaceId, projectRef, memberId })
  const agent = test.ctx.agents.get(added.status.member.sessionId)!
  await drainMainStream(test, agent, projectRef)
  return { test, agent, projectRef }
}

/** A Member whose baseline holds neither a file-reading nor a shell tool must still post without attachments. */
async function plainMessageCommits(test: Awaited<ReturnType<typeof memberHarness>>['test'], agent: Awaited<ReturnType<typeof memberHarness>>['agent'], projectRef: Awaited<ReturnType<typeof memberHarness>>['projectRef']): Promise<void> {
  const posted = await test.ctx.agentTeam.postMainMessageForAgent(agent, {
    requestId: requestId(`attach-plain-${fileId}`), workspaceId: test.workspaceId, projectRef, body: 'no files attached' })
  expect(posted.kind).toBe('committed')
}

describe('team_message attachment paths an Agent asks the Host to copy', () => {
  it.each([
    ['a preset without a file-reading or shell tool', {}],
    ['an allow-list that drops the file-reading and shell tools', { readTool: 'read' as const, shell: true, capabilities: { tools: { allow: ['working_directory'] } } }],
  ] as const)('are refused for a Member with %s, while plain messages still commit', async (_label, options) => {
    const { test, agent, projectRef } = await memberHarness(options)
    const { inside, outside } = attachFixtures(test.checkout)
    const before = await cacheEntries()
    const refused = /attachment_read_required/

    const started = await test.ctx.agentTeam.startThreadForAgent(agent, {
      kind: 'discussion', requestId: requestId('attach-start'), workspaceId: test.workspaceId, projectRef, body: 'with a file' })
    const threadRef = started.kind === 'committed' ? started.thread.threadRef : undefined
    const baseRevision = started.kind === 'committed' ? started.thread.revision : undefined
    expect(threadRef, 'a plain start still commits').toBeDefined()
    await drainMainStream(test, agent, projectRef)

    await expect(test.ctx.agentTeam.startThreadForAgent(agent, {
      kind: 'discussion', requestId: requestId('attach-start-refused'), workspaceId: test.workspaceId, projectRef, body: 'with a file',
      attachmentPaths: [inside] })).rejects.toThrow(refused)
    await expect(test.ctx.agentTeam.startThreadForAgent(agent, {
      kind: 'discussion', requestId: requestId('attach-start-outside-refused'), workspaceId: test.workspaceId, projectRef, body: 'with an outside file',
      attachmentPaths: [outside] })).rejects.toThrow(refused)
    await expect(test.ctx.agentTeam.replyForAgent(agent, {
      requestId: requestId('attach-reply-refused'), workspaceId: test.workspaceId, threadRef: threadRef!, body: 'with a file',
      baseRevision: baseRevision!, attachmentPaths: [inside] })).rejects.toThrow(refused)
    await expect(test.ctx.agentTeam.postMainMessageForAgent(agent, {
      requestId: requestId('attach-post-refused'), workspaceId: test.workspaceId, projectRef, body: 'with a file',
      attachmentPaths: [inside] })).rejects.toThrow(refused)
    expect(await cacheEntries(), 'no refused call writes a cache entry').toEqual(before)
    await plainMessageCommits(test, agent, projectRef)
  })

  it.each([
    ['read', 'read' as const, false],
    ['read_image', 'read_image' as const, false],
    ['bash', undefined, true],
  ] as const)('commits for a Member whose enforced surface holds only %s', async (_label, readTool, shell) => {
    const { test, agent, projectRef } = await memberHarness({ readTool, shell })
    const { inside } = attachFixtures(test.checkout)
    const posted = await test.ctx.agentTeam.postMainMessageForAgent(agent, {
      requestId: requestId('attach-granted'), workspaceId: test.workspaceId, projectRef, body: 'with a file', attachmentPaths: [inside] })
    expect(posted.kind).toBe('committed')
    if (posted.kind === 'committed') expect(posted.message.attachments).toHaveLength(1)
  })

  it('commits for a Member whose extraToolGrants reopen read', async () => {
    const { test, agent, projectRef } = await memberHarness({ readTool: 'read', capabilities: { tools: { allow: ['working_directory'] } } })
    const member = test.ctx.agentTeam.memberForAgent(agent)
    if (member === undefined) throw new Error('expected a live Member')
    // The seam a turn/start freeze reaches: the profile grant reopens the
    // baseline name the stored allow-list dropped.
    test.ctx.agentTeam['memberRuntime'].toolPolicy.applyMemberToolPolicy(agent.ctx, member, false, ['read'])
    const { inside } = attachFixtures(test.checkout)
    const posted = await test.ctx.agentTeam.postMainMessageForAgent(agent, {
      requestId: requestId('attach-grant'), workspaceId: test.workspaceId, projectRef, body: 'with a file', attachmentPaths: [inside] })
    expect(posted.kind).toBe('committed')
    if (posted.kind === 'committed') expect(posted.message.attachments).toHaveLength(1)
  })

  it('refuses a path that escapes the Member working directory, lexically or through a symlink', async () => {
    const { test, agent, projectRef } = await memberHarness({ readTool: 'read' })
    const { outside, link } = attachFixtures(test.checkout)
    const before = await cacheEntries()
    const escapes = /outside your working directory/
    const post = (name: string, attachmentPaths: string[]) => test.ctx.agentTeam.postMainMessageForAgent(agent, {
      requestId: requestId(`attach-escape-${name}`), workspaceId: test.workspaceId, projectRef, body: 'with a file', attachmentPaths })
    await expect(post('absolute', [outside])).rejects.toThrow(escapes)
    await expect(post('parent', [join(test.checkout, '..', 'escape.txt')])).rejects.toThrow(escapes)
    await expect(post('symlink', [link])).rejects.toThrow(escapes)
    expect(await cacheEntries(), 'no escaping path writes a cache entry').toEqual(before)
  })

  it('still accepts paths on the Human path without Member capability or working-directory limits', async () => {
    const { test, projectRef } = await memberHarness({ readTool: 'read' })
    const { outside } = attachFixtures(test.checkout)
    const posted = await test.ctx.agentTeam.postMainMessage({
      requestId: requestId('attach-human-post'), workspaceId: test.workspaceId, projectRef, body: 'with a file', attachmentPaths: [outside] })
    expect(posted.kind).toBe('committed')
    if (posted.kind === 'committed') expect(posted.message.attachments).toHaveLength(1)
    const started = await test.ctx.agentTeam.startThread({
      kind: 'discussion', requestId: requestId('attach-human-start'), workspaceId: test.workspaceId, projectRef, body: 'with a file', attachmentPaths: [outside] })
    expect(started.kind).toBe('committed')
    if (started.kind !== 'committed') throw new Error('expected the Human start to commit')
    const replied = await test.ctx.agentTeam.reply({
      requestId: requestId('attach-human-reply'), workspaceId: test.workspaceId, threadRef: started.thread.threadRef, body: 'with a file',
      baseRevision: started.thread.revision, attachmentPaths: [outside] })
    expect(replied.kind).toBe('committed')
  })
})
