import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { agentTeamHumanActor, type AgentTeamLedger } from '../../src/ledger.ts'
import type {
  AgentTeamAgentMember,
  AgentTeamClaimRef,
  AgentTeamMemberActor,
  AgentTeamMemberId,
  AgentTeamProject,
  AgentTeamProjectRef,
  AgentTeamRequestId,
  AgentTeamTask,
  AgentTeamTaskRef,
  AgentTeamThread,
  AgentTeamThreadRef,
} from '../../src/types.ts'

export function committed<T extends { readonly kind: string }>(result: T): Extract<T, { readonly kind: 'committed' }> {
  if (result.kind !== 'committed') throw new Error(`expected committed result, received ${result.kind}`)
  return result as Extract<T, { readonly kind: 'committed' }>
}

export function waitForAgentIdle(ctx: Context, agent: Agent): Promise<void> {
  if (agent.status === 'idle') return Promise.resolve()
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
  })
}

export interface TestProject {
  readonly projectRef: AgentTeamProjectRef
  readonly workspaceId: WorkspaceId
  readonly name: string
  readonly raw: AgentTeamProject
}

export interface TestTask {
  readonly taskRef: AgentTeamTaskRef
  readonly threadRef: AgentTeamThreadRef
  readonly workspaceId: WorkspaceId
  readonly raw: AgentTeamThread
  readonly task: AgentTeamTask | undefined
}

export interface TestThreadTarget {
  readonly threadRef?: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
  readonly workspaceId?: WorkspaceId
}

export type ProjectInput = TestProject | AgentTeamProjectRef
export type TaskOrThreadInput = TestTask | AgentTeamTaskRef | AgentTeamThreadRef

const asProjectRef = (input: ProjectInput): AgentTeamProjectRef =>
  typeof input === 'string' ? input : input.projectRef

function asThreadTarget(input: TaskOrThreadInput, defaultWorkspaceId: WorkspaceId): {
  readonly workspaceId: WorkspaceId
  readonly taskRef?: AgentTeamTaskRef
  readonly threadRef?: AgentTeamThreadRef
} {
  if (typeof input === 'string') {
    return input.startsWith('task:')
      ? { workspaceId: defaultWorkspaceId, taskRef: input as AgentTeamTaskRef }
      : { workspaceId: defaultWorkspaceId, threadRef: input as AgentTeamThreadRef }
  }
  return input.taskRef !== undefined
    ? { workspaceId: input.workspaceId, taskRef: input.taskRef }
    : { workspaceId: input.workspaceId, threadRef: input.threadRef }
}

function asTaskRef(input: TestTask | AgentTeamTaskRef): AgentTeamTaskRef {
  return typeof input === 'string' ? input : input.taskRef
}

export class TestMember {
  readonly ctx: Context
  readonly raw: AgentTeamAgentMember
  readonly memberId: AgentTeamMemberId
  readonly sessionId: SessionId
  readonly handle: string
  readonly actor: AgentTeamMemberActor
  private readonly defaultWorkspaceId: WorkspaceId
  private readonly nextRequestId: (prefix?: string) => AgentTeamRequestId

  constructor(
    ctx: Context,
    member: AgentTeamAgentMember,
    defaultWorkspaceId: WorkspaceId,
    nextRequestId: (prefix?: string) => AgentTeamRequestId,
  ) {
    this.ctx = ctx
    this.raw = member
    this.memberId = member.memberId
    this.sessionId = member.sessionId
    this.handle = member.handle
    this.actor = { kind: 'member', memberId: member.memberId, handle: member.handle }
    this.defaultWorkspaceId = defaultWorkspaceId
    this.nextRequestId = nextRequestId
  }

  get live(): Agent | undefined {
    return this.ctx.agents.get(this.sessionId)
  }

  get agent(): Agent {
    const live = this.ctx.agents.get(this.sessionId)
    if (live === undefined) throw new Error(`Member '${this.handle}' (${this.sessionId}) is not live in ctx.agents`)
    return live
  }

  waitForIdle(): Promise<void> {
    return waitForAgentIdle(this.ctx, this.agent)
  }

  async readThread(
    target: TaskOrThreadInput,
    options?: { readonly workspaceId?: WorkspaceId; readonly requestId?: AgentTeamRequestId },
  ) {
    const resolved = asThreadTarget(target, options?.workspaceId ?? this.defaultWorkspaceId)
    return this.ctx.agentTeam.readThreadForAgent(this.agent, {
      requestId: options?.requestId ?? this.nextRequestId(`read-${this.handle}`),
      workspaceId: options?.workspaceId ?? resolved.workspaceId,
      ...(resolved.taskRef !== undefined ? { taskRef: resolved.taskRef } : { threadRef: resolved.threadRef! }),
    })
  }

  async claimTask(
    target: TestTask | AgentTeamTaskRef,
    direction = 'own the work',
    options?: { readonly workspaceId?: WorkspaceId; readonly requestId?: AgentTeamRequestId },
  ) {
    const taskRef = asTaskRef(target)
    const workspaceId = options?.workspaceId ?? (typeof target === 'string' ? this.defaultWorkspaceId : target.workspaceId)
    const read = await this.readThread(taskRef, { workspaceId })
    return committed(await this.ctx.agentTeam.changeClaimForAgent(this.agent, {
      requestId: options?.requestId ?? this.nextRequestId(`claim-${this.handle}`),
      workspaceId,
      taskRef,
      action: 'claim',
      baseRevision: read.thread.revision,
      direction,
    }))
  }

  async releaseClaim(
    target: TestTask | AgentTeamTaskRef,
    claimRef: AgentTeamClaimRef,
    options?: { readonly workspaceId?: WorkspaceId; readonly requestId?: AgentTeamRequestId },
  ) {
    const taskRef = asTaskRef(target)
    const workspaceId = options?.workspaceId ?? (typeof target === 'string' ? this.defaultWorkspaceId : target.workspaceId)
    const read = await this.readThread(taskRef, { workspaceId })
    return committed(await this.ctx.agentTeam.changeClaimForAgent(this.agent, {
      requestId: options?.requestId ?? this.nextRequestId(`release-${this.handle}`),
      workspaceId,
      taskRef,
      action: 'release',
      claimRef,
      baseRevision: read.thread.revision,
    }))
  }

  async reply(
    target: TaskOrThreadInput,
    body: string,
    options?: {
      readonly workspaceId?: WorkspaceId
      readonly targetMemberIds?: readonly AgentTeamMemberId[]
      readonly requestId?: AgentTeamRequestId
    },
  ) {
    const resolved = asThreadTarget(target, options?.workspaceId ?? this.defaultWorkspaceId)
    const workspaceId = options?.workspaceId ?? resolved.workspaceId
    const read = await this.readThread(target, { workspaceId })
    return committed(await this.ctx.agentTeam.replyForAgent(this.agent, {
      requestId: options?.requestId ?? this.nextRequestId(`reply-${this.handle}`),
      workspaceId,
      ...(resolved.taskRef !== undefined ? { taskRef: resolved.taskRef } : { threadRef: resolved.threadRef! }),
      baseRevision: read.thread.revision,
      body,
      ...(options?.targetMemberIds !== undefined ? { targetMemberIds: [...options.targetMemberIds] } : {}),
    }))
  }

  queuedNotices(predicate?: (message: UserMessage) => boolean): UserMessage[] {
    const live = this.agent
    const all = [...live.inbox.nextStep, ...live.inbox.nextTurn]
    return predicate === undefined ? all : all.filter(predicate)
  }

  splicedNoticeTargets(predicate?: (message: UserMessage) => boolean): string[] {
    return this.agent.session.ownEvents()
      .filter(event => event.type === 'agent/inbox/spliced'
        && ((event.data as { inserted?: UserMessage[] }).inserted ?? []).some(msg => predicate === undefined || predicate(msg)))
      .map(event => (event.data as { target: string }).target)
  }
}

export class TestHuman {
  readonly ctx: Context
  readonly raw = agentTeamHumanActor()
  readonly defaultWorkspaceId: WorkspaceId
  private seq = 0

  constructor(ctx: Context, defaultWorkspaceId: WorkspaceId) {
    this.ctx = ctx
    this.defaultWorkspaceId = defaultWorkspaceId
  }

  requestId = (prefix = 'req'): AgentTeamRequestId => {
    this.seq += 1
    return `${prefix}-${this.seq}` as AgentTeamRequestId
  }

  async createProject(
    name: string,
    options?: { readonly description?: string; readonly workspaceId?: WorkspaceId; readonly requestId?: AgentTeamRequestId },
  ): Promise<TestProject> {
    const workspaceId = options?.workspaceId ?? this.defaultWorkspaceId
    const result = await this.ctx.agentTeam.createProject({
      requestId: options?.requestId ?? this.requestId(`project-${name}`),
      workspaceId,
      name,
      description: options?.description ?? `${name} work`,
    })
    return {
      projectRef: result.project.projectRef,
      workspaceId,
      name: result.project.name,
      raw: result.project,
    }
  }

  async addMember(
    handle: string,
    options?: {
      readonly description?: string
      readonly workspaceId?: WorkspaceId
      readonly presetId?: string
      readonly projects?: ReadonlyArray<ProjectInput>
      readonly projectRefs?: ReadonlyArray<ProjectInput>
      readonly model?: { readonly provider: string; readonly model: string }
      readonly waitForIdle?: boolean
      readonly requestId?: AgentTeamRequestId
    },
  ): Promise<TestMember> {
    const workspaceId = options?.workspaceId ?? this.defaultWorkspaceId
    const projectRefs = (options?.projects ?? options?.projectRefs ?? []).map(asProjectRef)
    const added = await this.ctx.agentTeam.addMember({
      requestId: options?.requestId ?? this.requestId(`member-${handle}`),
      workspaceId,
      handle,
      description: options?.description ?? `${handle} member`,
      presetId: options?.presetId ?? 'team-member',
      projectRefs,
      model: options?.model ?? { provider: 'mock', model: 'mock' },
    })
    const member = new TestMember(this.ctx, added.status.member, workspaceId, this.requestId)
    if (options?.waitForIdle !== false && member.live !== undefined) {
      await member.waitForIdle()
    }
    return member
  }

  member(raw: AgentTeamAgentMember): TestMember {
    return new TestMember(this.ctx, raw, raw.workspaceId, this.requestId)
  }

  async startTask(
    project: ProjectInput,
    body: string,
    options?: {
      readonly workspaceId?: WorkspaceId
      readonly targetMemberIds?: readonly AgentTeamMemberId[]
      readonly requestId?: AgentTeamRequestId
    },
  ): Promise<TestTask> {
    const workspaceId = options?.workspaceId ?? (typeof project === 'string' ? this.defaultWorkspaceId : project.workspaceId)
    const result = committed(await this.ctx.agentTeam.startThread({
      kind: 'task',
      requestId: options?.requestId ?? this.requestId('task'),
      workspaceId,
      projectRef: asProjectRef(project),
      body,
      ...(options?.targetMemberIds !== undefined ? { targetMemberIds: [...options.targetMemberIds] } : {}),
    }))
    return {
      taskRef: result.task!.taskRef,
      threadRef: result.thread.threadRef,
      workspaceId,
      raw: result.thread,
      task: result.task,
    }
  }

  async startDiscussion(
    project: ProjectInput,
    body: string,
    options?: {
      readonly workspaceId?: WorkspaceId
      readonly targetMemberIds?: readonly AgentTeamMemberId[]
      readonly requestId?: AgentTeamRequestId
    },
  ) {
    const workspaceId = options?.workspaceId ?? (typeof project === 'string' ? this.defaultWorkspaceId : project.workspaceId)
    const result = committed(await this.ctx.agentTeam.startThread({
      kind: 'discussion',
      requestId: options?.requestId ?? this.requestId('discussion'),
      workspaceId,
      projectRef: asProjectRef(project),
      body,
      ...(options?.targetMemberIds !== undefined ? { targetMemberIds: [...options.targetMemberIds] } : {}),
    }))
    return {
      threadRef: result.thread.threadRef,
      workspaceId,
      raw: result.thread,
    }
  }

  async readThread(
    target: TaskOrThreadInput,
    options?: { readonly workspaceId?: WorkspaceId; readonly requestId?: AgentTeamRequestId },
  ) {
    const resolved = asThreadTarget(target, options?.workspaceId ?? this.defaultWorkspaceId)
    return this.ctx.agentTeam.readThread({
      requestId: options?.requestId ?? this.requestId('human-read'),
      workspaceId: options?.workspaceId ?? resolved.workspaceId,
      ...(resolved.taskRef !== undefined ? { taskRef: resolved.taskRef } : { threadRef: resolved.threadRef! }),
    })
  }

  async acceptTask(
    target: TestTask | AgentTeamTaskRef,
    options?: { readonly workspaceId?: WorkspaceId; readonly summary?: string; readonly requestId?: AgentTeamRequestId },
  ) {
    const taskRef = asTaskRef(target)
    const workspaceId = options?.workspaceId ?? (typeof target === 'string' ? this.defaultWorkspaceId : target.workspaceId)
    const read = await this.readThread(taskRef, { workspaceId })
    return committed(await this.ctx.agentTeam.changeTask({
      requestId: options?.requestId ?? this.requestId('accept'),
      workspaceId,
      taskRef,
      action: 'accept',
      baseRevision: read.thread.revision,
      ...(options?.summary !== undefined ? { summary: options.summary } : {}),
    }))
  }

  async closeTask(
    target: TestTask | AgentTeamTaskRef,
    options?: { readonly workspaceId?: WorkspaceId; readonly summary?: string; readonly requestId?: AgentTeamRequestId },
  ) {
    const taskRef = asTaskRef(target)
    const workspaceId = options?.workspaceId ?? (typeof target === 'string' ? this.defaultWorkspaceId : target.workspaceId)
    const read = await this.readThread(taskRef, { workspaceId })
    return committed(await this.ctx.agentTeam.changeTask({
      requestId: options?.requestId ?? this.requestId('close'),
      workspaceId,
      taskRef,
      action: 'close',
      baseRevision: read.thread.revision,
      ...(options?.summary !== undefined ? { summary: options.summary } : {}),
    }))
  }

  async reply(
    target: TaskOrThreadInput,
    body: string,
    options?: {
      readonly workspaceId?: WorkspaceId
      readonly targetMemberIds?: readonly AgentTeamMemberId[]
      readonly requestId?: AgentTeamRequestId
    },
  ) {
    const resolved = asThreadTarget(target, options?.workspaceId ?? this.defaultWorkspaceId)
    const workspaceId = options?.workspaceId ?? resolved.workspaceId
    const read = await this.readThread(target, { workspaceId })
    return committed(await this.ctx.agentTeam.reply({
      requestId: options?.requestId ?? this.requestId('human-reply'),
      workspaceId,
      ...(resolved.taskRef !== undefined ? { taskRef: resolved.taskRef } : { threadRef: resolved.threadRef! }),
      baseRevision: read.thread.revision,
      body,
      ...(options?.targetMemberIds !== undefined ? { targetMemberIds: [...options.targetMemberIds] } : {}),
    }))
  }
}

export interface TestLedgerMember {
  readonly memberId: AgentTeamMemberId
  readonly sessionId: SessionId
  readonly handle: string
  readonly actor: AgentTeamMemberActor
  readonly raw: AgentTeamAgentMember
}

export class TestLedgerHuman {
  readonly ledger: AgentTeamLedger
  readonly raw = agentTeamHumanActor()
  readonly defaultWorkspaceId: WorkspaceId
  private seq = 0

  constructor(ledger: AgentTeamLedger, defaultWorkspaceId: WorkspaceId) {
    this.ledger = ledger
    this.defaultWorkspaceId = defaultWorkspaceId
  }

  requestId = (prefix = 'req'): AgentTeamRequestId => {
    this.seq += 1
    return `${prefix}-${this.seq}` as AgentTeamRequestId
  }

  async createProject(
    name: string,
    options?: { readonly description?: string; readonly workspaceId?: WorkspaceId; readonly requestId?: AgentTeamRequestId },
  ): Promise<TestProject> {
    const workspaceId = options?.workspaceId ?? this.defaultWorkspaceId
    const result = await this.ledger.createProject({
      requestId: options?.requestId ?? this.requestId(`project-${name}`),
      actor: this.raw,
      workspaceId,
      name,
      description: options?.description ?? `${name} work`,
    })
    return {
      projectRef: result.value.project.projectRef,
      workspaceId,
      name: result.value.project.name,
      raw: result.value.project,
    }
  }

  async addMember(
    handle: string,
    options?: {
      readonly memberId?: AgentTeamMemberId
      readonly description?: string
      readonly workspaceId?: WorkspaceId
      readonly presetId?: string
      readonly projects?: ReadonlyArray<ProjectInput>
      readonly projectRefs?: ReadonlyArray<ProjectInput>
      readonly model?: { readonly provider: string; readonly model: string }
      readonly requestId?: AgentTeamRequestId
    },
  ): Promise<TestLedgerMember> {
    const workspaceId = options?.workspaceId ?? this.defaultWorkspaceId
    const memberId = (options?.memberId ?? `member:${handle}`) as AgentTeamMemberId
    const projectRefs = (options?.projects ?? options?.projectRefs ?? []).map(asProjectRef)
    const model = options?.model ?? { provider: 'mock', model: 'mock' }
    const member: AgentTeamAgentMember = {
      memberId,
      sessionId: SessionId(`session:${memberId}`),
      workspaceId,
      handle,
      description: options?.description ?? `${handle} member`,
      presetId: options?.presetId ?? 'team-member',
      model,
      privateMemoryPath: `/tmp/${memberId}`,
      state: 'enabled',
    }
    await this.ledger.addMember({
      requestId: options?.requestId ?? this.requestId(`member-${handle}`),
      actor: this.raw,
      member,
      handle,
      description: member.description,
      presetId: member.presetId,
      workspaceId,
      projectRefs,
      model,
    })
    return {
      memberId,
      sessionId: member.sessionId,
      handle,
      actor: { kind: 'member', memberId, handle },
      raw: member,
    }
  }

  async makeOwner(
    project: ProjectInput,
    member: TestLedgerMember | AgentTeamMemberId,
    options?: { readonly workspaceId?: WorkspaceId; readonly requestId?: AgentTeamRequestId },
  ) {
    const workspaceId = options?.workspaceId ?? (typeof project === 'string' ? this.defaultWorkspaceId : project.workspaceId)
    const memberId = typeof member === 'string' ? member : member.memberId
    return this.ledger.addProjectOwner({
      requestId: options?.requestId ?? this.requestId(`owner-${memberId}`),
      actor: this.raw,
      workspaceId,
      projectRef: asProjectRef(project),
      memberId,
    })
  }

  async startTask(
    project: ProjectInput,
    body: string,
    options?: {
      readonly workspaceId?: WorkspaceId
      readonly targetMemberIds?: readonly AgentTeamMemberId[]
      readonly requestId?: AgentTeamRequestId
    },
  ): Promise<TestTask> {
    const workspaceId = options?.workspaceId ?? (typeof project === 'string' ? this.defaultWorkspaceId : project.workspaceId)
    const started = await this.ledger.startThread({
      kind: 'task',
      requestId: options?.requestId ?? this.requestId('task'),
      actor: this.raw,
      workspaceId,
      projectRef: asProjectRef(project),
      body,
      ...(options?.targetMemberIds !== undefined ? { targetMemberIds: [...options.targetMemberIds] } : {}),
    })
    const result = committed(started.value)
    return {
      taskRef: result.task!.taskRef,
      threadRef: result.thread.threadRef,
      workspaceId,
      raw: result.thread,
      task: result.task,
    }
  }
}
