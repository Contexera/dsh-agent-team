import { vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamAddMemberRequest,
  AgentTeamCreateProjectRequest,
  AgentTeamMemberDiagnostic,
} from '@contexera/dsh-agent-team/types'

export function createProjectsAndMembersDouble(options?: { readonly initialProjects?: boolean | undefined }) {
  const status = (
    memberId: string,
    workspaceId: string,
    handle: string,
    presence: 'available' | 'working' | 'error' | 'unavailable',
    diagnostic?: AgentTeamMemberDiagnostic,
  ) => ({
    member: {
      memberId,
      workspaceId,
      handle,
      description: `${handle} description`,
      presetId: 'team-member',
      state: 'enabled',
      sessionId: `session:${memberId}`,
    },
    workspaceIds: [workspaceId],
    availability: presence === 'unavailable' ? 'unavailable' : 'active',
    presence,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  })

  let memberRows = [
    status('member:builder', 'w1', 'builder', 'available'),
    status('member:worker', 'w1', 'worker', 'working'),
    status('member:failed', 'w1', 'failed', 'error', { class: 'runtime', detail: 'model failed' }),
    status('member:offline', 'w1', 'offline', 'unavailable', { class: 'preset-composition', detail: 'preset missing' }),
    status('member:builder-beta', 'w2', 'builder', 'available'),
  ]

  const members = vi.fn(async ({ workspaceId }: { workspaceId?: string }) => ({
    ok: true,
    value: memberRows.filter(entry => workspaceId === undefined || entry.workspaceIds.includes(workspaceId)),
  }))

  const joinWorkspace = vi.fn(async (request: { memberId: string; workspaceId: string }) => {
    const member = memberRows.find(entry => entry.member.memberId === request.memberId)!
    if (!member.workspaceIds.includes(request.workspaceId)) member.workspaceIds.push(request.workspaceId)
    return { ok: true as const, value: {} }
  })

  const leaveWorkspace = vi.fn(async (request: { memberId: string; workspaceId: string }) => {
    const member = memberRows.find(entry => entry.member.memberId === request.memberId)!
    member.workspaceIds = member.workspaceIds.filter(id => id !== request.workspaceId)
    return { ok: true as const, value: {} }
  })

  const addMember = vi.fn(async (request: AgentTeamAddMemberRequest) => ({
    ok: true,
    value: {
      receipt: {},
      status: {
        member: {
          memberId: 'member:new',
          workspaceId: request.workspaceId,
          handle: request.handle,
          description: request.description,
          presetId: request.presetId,
          state: 'enabled',
          sessionId: 'session:new',
        },
        availability: 'active',
        presence: 'available',
      },
      workspaceIds: [request.workspaceId],
    },
  }))

  let projects: Array<Record<string, unknown>> = options?.initialProjects === true
    ? [{ projectRef: 'project:engineering', workspaceId: 'w1', name: 'engineering', description: 'Engineering work', createdAtSequence: 1 }]
    : []
  let memberships: Array<Record<string, unknown>> = []
  let owners: Array<{ projectRef: string; memberId: string }> = []

  const createProject = vi.fn(async (request: AgentTeamCreateProjectRequest) => {
    const project = {
      projectRef: 'project:new',
      workspaceId: request.workspaceId,
      name: request.name,
      description: request.description,
      createdAtSequence: 1,
    }
    projects = [...projects, project]
    memberships = (request.memberIds ?? []).map(memberId => ({ projectRef: project.projectRef, memberId }))
    return { ok: true, value: { receipt: {}, project, memberIds: request.memberIds ?? [] } }
  })

  const updateProject = vi.fn(async (request: { requestId: string; workspaceId: string; projectRef: string; name: string; description: string }) => {
    projects = projects.map(project => project.projectRef === request.projectRef
      ? { ...project, name: request.name, description: request.description }
      : project)
    return { ok: true as const, value: { receipt: {}, project: projects.find(project => project.projectRef === request.projectRef) } }
  })

  let projectOwnerFailure: string | undefined
  const failProjectOwnerWrite = (message?: string): void => { projectOwnerFailure = message }
  const writeProjectOwner = (add: boolean) => async (request: { requestId: string; workspaceId: string; projectRef: string; memberId: string }) => {
    if (projectOwnerFailure !== undefined) return { ok: false as const, error: { message: projectOwnerFailure } }
    owners = owners.filter(owner => !(owner.projectRef === request.projectRef && owner.memberId === request.memberId))
    if (add) owners = [...owners, { projectRef: request.projectRef, memberId: request.memberId }]
    return {
      ok: true as const,
      value: {
        receipt: {},
        projectRef: request.projectRef,
        ownerIds: owners.filter(owner => owner.projectRef === request.projectRef).map(owner => owner.memberId),
      },
    }
  }
  const addProjectOwner = vi.fn(writeProjectOwner(true))
  const removeProjectOwner = vi.fn(writeProjectOwner(false))

  const updateMember = vi.fn(async (request: { requestId: string; memberId: string; handle: string; description: string; model?: { provider: string; model: string } }) => {
    memberRows = memberRows.map(entry => entry.member.memberId === request.memberId
      ? { ...entry, member: { ...entry.member, handle: request.handle, description: request.description, ...(request.model === undefined ? {} : { model: request.model }) } }
      : entry)
    const nextStatus = memberRows.find(entry => entry.member.memberId === request.memberId)
    return { ok: true as const, value: { receipt: {}, ...(nextStatus === undefined ? {} : { status: nextStatus }) } }
  })

  const recoverMember = vi.fn(async (request: { requestId: string; memberId: string }) => ({
    ok: true as const,
    value: { status: memberRows.find(entry => entry.member.memberId === request.memberId) },
  }))

  // Archival hides the row: the mock transitions the member the way the real
  // archiveMember remote does (state archived, availability archived).
  const archiveMember = vi.fn(async (request: { requestId: string; memberId: string }) => {
    memberRows = memberRows.map(entry => entry.member.memberId === request.memberId
      ? { ...entry, member: { ...entry.member, state: 'archived' }, availability: 'archived', presence: 'unavailable' }
      : entry)
    const archived = memberRows.find(entry => entry.member.memberId === request.memberId)
    return {
      ok: true as const,
      value: { receipt: {}, member: archived?.member, releasedClaims: [], removedAttention: [] },
    }
  })

  // Project archival hides the row from every view; the mock drops it like
  // the Host's workspace-scoped wake refetch would.
  const archiveProject = vi.fn(async (request: { requestId: string; workspaceId: string; projectRef: string }) => {
    const archived = projects.find(project => project.projectRef === request.projectRef)
    projects = projects.filter(project => project.projectRef !== request.projectRef)
    return { ok: true as const, value: { receipt: {}, project: archived, releasedClaims: [] } }
  })

  const modelCatalog = vi.fn(async () => ({
    ok: true as const,
    value: {
      groups: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }] } },
          { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
        ],
      }],
      failures: [],
    },
  }))

  let putAttachmentCounter = 0
  const putAttachment = vi.fn(async (request: { requestId: string; name: string; mediaType?: string; bytesBase64: string }) => ({
    ok: true as const,
    value: {
      attachmentId: `attachment:${putAttachmentCounter += 1}`,
      path: `/cache/${request.name}`,
      name: request.name,
      byteSize: request.bytesBase64.length,
      mediaType: request.mediaType ?? 'application/octet-stream',
    },
  }))

  const getAttachment = vi.fn(async (request: { attachmentId: string }) => {
    if (request.attachmentId === 'attachment:2') {
      return { ok: false as const, error: new RemoteError('team/attachment-not-found', 'no longer cached', { attachmentId: request.attachmentId as never }) }
    }
    return { ok: true as const, value: { name: 'x', mediaType: 'image/png', byteSize: 8, bytesBase64: 'aGVsbG8=' } }
  })

  const seedProject = (project: Record<string, unknown>) => { projects = [...projects, project] }

  return {
    status,
    members,
    joinWorkspace,
    leaveWorkspace,
    addMember,
    updateMember,
    recoverMember,
    archiveMember,
    createProject,
    updateProject,
    archiveProject,
    addProjectOwner,
    removeProjectOwner,
    failProjectOwnerWrite,
    modelCatalog,
    putAttachment,
    getAttachment,
    seedProject,
    getProjects: () => projects,
    getMemberships: () => memberships,
    getOwners: () => owners,
  }
}
