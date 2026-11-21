import { projectRefOf, service } from './host-access.ts'
import type { AgentTeamMemberId, AgentTeamModelSelection, AgentTeamManagerSessionEvidenceFailureKind, AgentTeamManagerSessionEvidenceLocator, AgentTeamManagerSessionEvidenceState, AgentTeamMemberCapabilities, AgentTeamOwnedProject, AgentTeamRequestId, AgentTeamProjectRef } from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { memberCreateOutput, memberStateOutput, memberUpdateOutput, memberWorkspaceOutput, projectCreateOutput,
  projectOwnerOutput, projectUpdateOutput, teamModelsOutput, teamOverviewOutput } from './manager-output.ts'
import { blankToAbsent, requestId } from './tool-input.ts'

/**
 * The Team manager's read of the whole Team. It is not `team_view` for the
 * manager: the manager holds no Member identity, so participation, Project
 * membership and message visibility mean nothing here, and no message body or
 * Thread fact belongs in the answer. The refs it returns are the ones a later
 * write addresses, and a Project whose owner recorded no responsibility reads
 * `unspecified` — a fact about the grant, never a defect to repair.
 */
export const teamOverview = defineTool({
  name: 'team_overview',
  description: "Read the whole Agent Team as the manager: every Workspace in the Host directory with its checkout path, every Project with its shared goal, its owners and what each answers for, its live subscription counts and board summary, and every Member with its standing, where it participates, which model route it is configured to run, how it runs, what its capability configuration mounted, and what it owns. Read-only: no message bodies, no Thread facts, no credentials, no private file contents. Narrow with workspaceId, projectRef, or memberRef (a memberRef read adds that Member's full standing, its actual private directory, and the locator for its current Session — the Session id, the backend-resolved stored-log location, and the shipped read-only reader that inspects it — and nothing beyond them). The same handle in two Workspaces is two Members, so address one by its memberRef. An owner with no recorded responsibility reads `unspecified`, a Project with only the Human as owner is a fact rather than a fault, and a long-standing Member with no owner relation is reported the same way. A capability warning means the stored configuration named a tool this Member cannot hold: the write succeeded and the stored entry stays, but the runtime ignores it, so the Member runs narrower than the list reads, and the warning names the tools it can hold. Each collection is bounded by `limit` and a cut collection says so through `truncated`, so a large Team is paged by scope instead of silently shortened. An empty answer means the Team is empty; a directory that could not be read refuses instead. Full Thread and Task detail stays team_thread read and team_task board; creating a Member, a Project, or an owner grant rides member_create, project_create and project_owner.",
  parameters: {
    workspaceId: { type: 'string', description: "Narrow to one Workspace id exactly as listed in the overview. An unknown id is refused rather than answered as empty." },
    projectRef: { type: 'string', description: "Full branded Project ref exactly as returned by Team tools, including the 'project:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves; an unknown ref is refused rather than answered as empty." },
    memberRef: { type: 'string', description: "Full branded Member ref exactly as returned by Team tools, including the 'member:' prefix. Reading one adds its full standing, its private directory path, its owned Projects, and the locator for its current Session." },
    limit: { type: 'number', description: 'Maximum entries per collection — Workspaces, Projects and Members are each bounded separately — as an integer from 1 to 100; the default is 50. A collection the bound cuts is reported in `truncated`, so raise this or narrow the scope instead of assuming the Team is that small.' },
  },
  output: teamOverviewOutput,
  async execute(rawArgs, exec) {
    const args = blankToAbsent(rawArgs, ['workspaceId', 'projectRef', 'memberRef', 'limit'])
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_overview requires an Agent session')
    const host = service(agent)
    const overview = host.managerOverviewForAgent(agent, {
      ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId as WorkspaceId }),
      ...(args.projectRef === undefined ? {} : { projectRef: projectRefOf(args.projectRef) as AgentTeamProjectRef }),
      ...(args.memberRef === undefined ? {} : { memberRef: args.memberRef as AgentTeamMemberId }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    })
    // The locator is a second read because it is a Session fact, not a ledger
    // one: the Host resolves the Member's current Session and asks the backend
    // where its log is. The overview itself stays synchronous and unchanged.
    const detail = overview.member === undefined ? undefined : {
      memberRef: overview.member.memberRef, handle: overview.member.handle, description: overview.member.description,
      privateMemoryPath: overview.member.privateMemoryPath,
      owns: overview.member.owns.map(owned => managerOwnedProject(owned)),
      sessionEvidence: managerSessionEvidence(await host.managerSessionLocatorForAgent(agent, overview.member.memberRef)),
    }
    return {
      workspaces: overview.workspaces.map(workspace => ({ workspaceId: workspace.workspaceId,
        ...(workspace.title === undefined ? {} : { title: workspace.title }),
        path: workspace.path ?? '', projectCount: workspace.projectCount, memberCount: workspace.memberCount })),
      projects: overview.projects.map(project => ({ workspaceId: project.workspaceId, projectRef: project.projectRef,
        name: project.name, description: project.description, state: project.state,
        owners: project.owners.map(owner => ({ memberRef: owner.memberRef, handle: owner.handle,
          ...(owner.responsibility === undefined ? {} : { responsibility: owner.responsibility }) })),
        subscriptions: { active: project.subscriptions.active, paused: project.subscriptions.paused },
        board: { open: project.board.open, inReview: project.board.inReview } })),
      members: overview.members.map(member => ({ memberRef: member.memberRef, handle: member.handle,
        description: member.description, availability: member.availability, presence: member.presence,
        workspaceIds: [...member.workspaceIds],
        ...(member.diagnostic === undefined ? {} : { diagnostic: {
          class: member.diagnostic.class, detail: member.diagnostic.detail,
          ...(member.diagnostic.location === undefined ? {} : { location: { kind: member.diagnostic.location.kind, path: member.diagnostic.location.path } }),
          ...(member.diagnostic.sessionId === undefined ? {} : { sessionId: member.diagnostic.sessionId }),
          ...(member.diagnostic.source === undefined ? {} : { source: member.diagnostic.source }),
          ...(member.diagnostic.occurredAt === undefined ? {} : { occurredAt: member.diagnostic.occurredAt }),
        } }),
        ...(member.model === undefined ? {} : { model: {
          provider: member.model.provider, model: member.model.model,
          ...(member.model.reasoningEffort === undefined ? {} : { reasoningEffort: member.model.reasoningEffort }),
        } }),
        capabilityState: member.capabilityState,
        ...(member.capabilityWarnings === undefined ? {} : { capabilityWarnings: member.capabilityWarnings.map(warning => ({
          name: warning.name, knownNames: [...warning.knownNames],
        })) }),
        owns: member.owns.map(owned => managerOwnedProject(owned)) })),
      switches: { worker: overview.switches.worker },
      truncated: { workspaces: overview.truncated.workspaces, projects: overview.truncated.projects, members: overview.truncated.members },
      ...(detail === undefined ? {} : { member: detail }),
    }
  },
})

function managerOwnedProject(owned: AgentTeamOwnedProject): { projectRef: string; name: string; description: string; state: string; responsibility?: string } {
  return {
    projectRef: owned.project.projectRef, name: owned.project.name,
    description: owned.project.description, state: owned.project.state,
    ...(owned.responsibility === undefined ? {} : { responsibility: owned.responsibility }),
  }
}

function managerSessionEvidence(locator: AgentTeamManagerSessionEvidenceLocator): {
  sessionId: string
  state: AgentTeamManagerSessionEvidenceState
  location?: { kind: string; path: string }
  reader: { script: string; anchor?: string }
  failure?: { kind: AgentTeamManagerSessionEvidenceFailureKind; detail: string; location?: { kind: string; path: string } }
} {
  return {
    sessionId: locator.sessionId, state: locator.state,
    ...(locator.location === undefined ? {} : { location: { kind: locator.location.kind, path: locator.location.path } }),
    reader: { script: locator.reader.script, ...(locator.reader.anchor === undefined ? {} : { anchor: locator.reader.anchor }) },
    ...(locator.failure === undefined ? {} : { failure: {
      kind: locator.failure.kind, detail: locator.failure.detail,
      ...(locator.failure.location === undefined ? {} : { location: { kind: locator.failure.location.kind, path: locator.failure.location.path } }),
    } }),
  }
}

/**
 * The model routes a Member may run. This reads the Session controller's own
 * catalog rather than restating it, so the manager can never offer a route the
 * Web member editor does not, and a provider whose lookup failed is reported as
 * a failure rather than folded into an empty list.
 */
export const teamModels = defineTool({
  name: 'team_models',
  description: 'List the model routes a Team Member may run: every provider group with its models, each model\'s own description and reasoning efforts, the deployment default, and the providers whose catalog lookup failed. This is the same catalog the Web member editor offers, so a route named here is selectable there. A failed provider is reported in `failures` and is never read as an empty catalog. `memberPresets` names the one preset a Member may compose; the manager\'s own preset is deliberately not member-selectable and never appears here.',
  parameters: {},
  output: teamModelsOutput,
  async execute(_rawArgs, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_models requires an Agent session')
    const host = service(agent)
    const models = await host.managerModelsForAgent(agent)
    const defaultRoute = models.catalog.default
    return {
      default: { provider: defaultRoute.provider, model: defaultRoute.model,
        ...(defaultRoute.reasoningEffort === undefined ? {} : { reasoningEffort: defaultRoute.reasoningEffort }) },
      routableProviders: [...models.catalog.routableProviders],
      groups: models.catalog.groups.map(group => ({
        id: group.id,
        name: group.name,
        models: group.models.map(model => {
          const modelRow: { id: string; name: string; description?: string; reasoning?: { efforts: { id: string; name: string }[] } } = { id: model.id, name: model.name }
          if (model.description !== undefined) modelRow.description = model.description
          if (model.reasoning !== undefined) modelRow.reasoning = { efforts: model.reasoning.efforts.map(effort => ({ id: effort.id, name: effort.name })) }
          return modelRow
        }),
      })),
      failures: models.catalog.failures.map(failure => ({ id: failure.id, name: failure.name, message: failure.message })),
      memberPresets: [...models.memberPresets],
    }
  },
})

/**
 * One Member's live standing as every manager write answers it. The projection
 * is shared so a write can never answer a narrower standing than its sibling:
 * the diagnostic and the capability warnings are the two facts a manager acts
 * on, and dropping either turns a divergence into a clean-looking success.
 */
function managerStatusView(status: {
  readonly availability: string
  readonly presence: string
  readonly capabilityState: string
  readonly diagnostic?: { readonly class: string; readonly detail: string } | undefined
  readonly capabilityWarnings?: readonly { readonly name: string; readonly knownNames?: readonly string[] | undefined }[] | undefined
}): {
  availability: string; presence: string; capabilityState: string
  diagnostic?: { class: string; detail: string }
  capabilityWarnings?: { name: string; knownNames?: string[] }[]
} {
  return {
    availability: status.availability, presence: status.presence, capabilityState: status.capabilityState,
    ...(status.diagnostic === undefined ? {} : { diagnostic: { class: status.diagnostic.class, detail: status.diagnostic.detail } }),
    ...(status.capabilityWarnings === undefined ? {} : { capabilityWarnings: status.capabilityWarnings.map(warning => ({
      name: warning.name,
      ...(warning.knownNames === undefined ? {} : { knownNames: [...warning.knownNames] }),
    })) }),
  }
}

export const memberCreate = defineTool({
  name: 'member_create',
  description: "Create one Agent Member in one Workspace as the Team manager. The Member is a durable Team record: it appears in the Web Client, answers in its own Session, and is addressed from now on by its memberRef — never by its handle, because the same handle in two Workspaces is two different Members. Requires the handle (free in that Workspace), a description of the Member's global standing, and an explicit model route exactly as team_models listed it; the Member preset is fixed and is not a choice. Capabilities are optional; absent means the full standard surface. Every write carries a requestId: pass your own when the write matters enough to retry — the same id with the same parameters answers with the original receipt instead of writing twice, while a changed parameter under a reused id is refused as a collision. A refusal names its reason and wrote nothing. A committed Member whose activation failed is still committed: the answer keeps its receipt, ref and activation diagnostic, so continue from there instead of creating it again. Only the live Team manager Session holds this tool.",
  parameters: {
    workspaceId: { type: 'string', required: true, description: "Target Workspace id exactly as team_overview listed it. The Member is created in this Workspace and its Session runs in that Workspace's checkout." },
    handle: { type: 'string', required: true, description: 'The Member handle, unique within the target Workspace. It names the Member to the Human; it is never an address for a later write.' },
    description: { type: 'string', required: true, description: "The Member's global standing — what it is for across every Project. Required here; an empty standing is refused." },
    model: { type: 'object', additionalProperties: false, required: true, properties: {
      provider: { type: 'string', required: true, description: 'Provider id exactly as team_models listed it.' },
      model: { type: 'string', required: true, description: 'Model id exactly as team_models listed it under that provider.' },
      reasoningEffort: { type: 'string', description: 'Reasoning effort id exactly as team_models listed it for that model; absent uses the provider default.' },
    } },
    capabilities: { type: 'object', additionalProperties: false, properties: {
      tools: { type: 'object', additionalProperties: false, properties: { allow: { type: 'array', items: { type: 'string' } } } },
      skills: { type: 'object', additionalProperties: false, properties: { allow: { type: 'array', items: { type: 'string' } } } },
    }, description: 'Optional durable capability intent; absent means the full standard surface. Unknown names drop with a warning rather than failing the write.' },
    requestId: { type: 'string', description: 'Your own idempotency key for this write. Omit it and the Host derives one per call — but then a lost answer cannot be retried by id, so read back with team_overview instead.' },
  },
  output: memberCreateOutput,
  async execute(rawArgs, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('member_create requires an Agent session')
    const host = service(agent)
    const args = blankToAbsent(rawArgs, ['requestId', 'capabilities'])
    const result = await host.managerCreateMemberForAgent(agent, {
      requestId: (args.requestId as AgentTeamRequestId | undefined) ?? requestId(agent.id, exec.callId),
      workspaceId: args.workspaceId as WorkspaceId,
      handle: args.handle,
      description: args.description,
      model: args.model as AgentTeamModelSelection,
      ...(args.capabilities === undefined ? {} : { capabilities: args.capabilities as AgentTeamMemberCapabilities }),
    })
    return {
      requestId: result.requestId, outcome: result.outcome,
      receipt: { operationId: result.receipt.operationId, requestId: result.receipt.requestId, sequence: result.receipt.sequence, occurredAt: result.receipt.occurredAt },
      memberRef: result.memberRef, workspaceIds: [...result.workspaceIds],
      status: managerStatusView(result.status),
    }
  },
})

/**
 * Record one Project's shared goal for the manager. Creation admits only
 * Members that are already active in the Workspace — the Host's own admission
 * rule, stricter than the ledger's — so a Member whose activation failed is
 * reported through its own receipt rather than silently joining the Project.
 */
export const projectCreate = defineTool({
  name: 'project_create',
  description: "Create one Project in an existing Workspace as the Team manager, recording its shared goal as the description. A Project is a durable Team record addressed from now on by its projectRef; any Member that participates in the Workspace can already read and write in it, so owners are granted afterwards with project_owner. An empty shared goal is refused: a Project exists for a continuing result someone answers for. Every write carries a requestId with the same replay rule as member_create — the same id and parameters answer with the original receipt, a changed parameter under a reused id is a collision. A refusal names its reason and wrote nothing. Only the live Team manager Session holds this tool.",
  parameters: {
    workspaceId: { type: 'string', required: true, description: "Target Workspace id exactly as team_overview listed it. The Project is created in this Workspace." },
    name: { type: 'string', required: true, description: 'Short display name for the Project.' },
    description: { type: 'string', required: true, description: "The Project's shared goal — the continuing result its owners answer for. Required here; an empty goal is refused." },
    requestId: { type: 'string', description: 'Your own idempotency key for this write, with the same replay rule as member_create.' },
  },
  output: projectCreateOutput,
  async execute(rawArgs, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('project_create requires an Agent session')
    const host = service(agent)
    const args = blankToAbsent(rawArgs, ['requestId'])
    const result = await host.managerCreateProjectForAgent(agent, {
      requestId: (args.requestId as AgentTeamRequestId | undefined) ?? requestId(agent.id, exec.callId),
      workspaceId: args.workspaceId as WorkspaceId,
      name: args.name,
      description: args.description,
    })
    return {
      requestId: result.requestId, outcome: result.outcome,
      receipt: { operationId: result.receipt.operationId, requestId: result.receipt.requestId, sequence: result.receipt.sequence, occurredAt: result.receipt.occurredAt },
      projectRef: result.projectRef,
    }
  },
})

/**
 * Grant, re-describe, or withdraw one Agent Member's ownership of one Project.
 * Eligibility is the ledger's own rule and the grant itself is the Member's
 * Project participation, so every action reuses the Host's own ownership path
 * rather than restating either rule here.
 */
export const projectOwner = defineTool({
  name: 'project_owner',
  description: "Change one Agent Member's ownership of one Project as the Team manager. `add` grants it and records what the owner answers for there; `update` replaces that responsibility without withdrawing and re-granting, so the Member keeps its grant, its Main stream following and its history; `remove` withdraws the ownership. The grantee must already participate in the Project's Workspace and be enabled or suspended — an archived Member is refused with its reason — and a grant itself is that Member's Project participation. The responsibility is what this owner answers for in this Project: a bounded statement, distinct from the Member's global description and the Project's shared goal. `add` refuses an empty one; `update` accepts an explicit empty one and records that the responsibility is unspecified, exactly as the Web entry does; `remove` takes none. Withdrawing an owner keeps the Task responsibility of a Member that still participates in the Project in another way, and returns open Tasks to the Human only when the ownership was its last participation. Every write carries a requestId with the same replay rule as member_create — the same id and parameters answer with the original receipt, a changed parameter under a reused id is a collision. A refusal names its reason and wrote nothing. Only the live Team manager Session holds this tool.",
  parameters: {
    action: { type: 'string', required: true, enum: ['add', 'update', 'remove'], description: "The ownership change to make: 'add' grants it, 'update' replaces its responsibility, 'remove' withdraws it." },
    workspaceId: { type: 'string', required: true, description: "The Project's Workspace id exactly as team_overview listed it." },
    projectRef: { type: 'string', required: true, description: "Full branded Project ref exactly as team_overview returned it, including the 'project:' prefix." },
    memberRef: { type: 'string', required: true, description: "Full branded Member ref exactly as team_overview returned it, including the 'member:' prefix. Never a handle: the same handle in two Workspaces is two Members." },
    responsibility: { type: 'string', description: "add and update only: what this owner answers for in this Project, at most 2,000 characters. 'add' refuses an empty one; on 'update' an empty one is the same as clearResponsibility. Refused on 'remove', which describes nothing." },
    clearResponsibility: { type: 'boolean', description: "update only: record that this owner's responsibility is unspecified, exactly as the Web entry does when it is left empty. Refused together with a non-empty responsibility, and refused on add or remove." },
    requestId: { type: 'string', description: 'Your own idempotency key for this write, with the same replay rule as member_create.' },
  },
  output: projectOwnerOutput,
  async execute(rawArgs, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('project_owner requires an Agent session')
    const host = service(agent)
    // A blank requestId names no retry key and `false` names no clearing. A
    // blank responsibility is different on `update`: the documented empty value
    // is how a model records "unspecified", so it survives here and only the
    // actions that describe nothing drop it.
    const args = blankToAbsent(rawArgs, ['clearResponsibility', 'requestId'])
    const action = args.action as 'add' | 'update' | 'remove'
    if (action !== 'update' && typeof args.responsibility === 'string' && args.responsibility.trim() === '') {
      delete (args as { responsibility?: unknown }).responsibility
    }
    if (action === 'remove' && (args.responsibility !== undefined || args.clearResponsibility === true)) {
      throw new Error("project_owner takes responsibility only with add or update; a withdrawn ownership describes nothing.")
    }
    if (action === 'add' && args.clearResponsibility === true) {
      throw new Error('project_owner add needs the responsibility the owner answers for; there is nothing to clear on a new grant.')
    }
    if (args.clearResponsibility === true && typeof args.responsibility === 'string' && args.responsibility.trim() !== '') {
      throw new Error('project_owner takes either responsibility or clearResponsibility, not both: clearing records that it is unspecified.')
    }
    const responsibility = args.clearResponsibility === true ? '' : args.responsibility as string | undefined
    const result = await host.managerChangeProjectOwnerForAgent(agent, {
      requestId: (args.requestId as AgentTeamRequestId | undefined) ?? requestId(agent.id, exec.callId),
      workspaceId: args.workspaceId as WorkspaceId,
      projectRef: projectRefOf(args.projectRef) as AgentTeamProjectRef,
      memberRef: args.memberRef as AgentTeamMemberId,
      action,
      ...(responsibility === undefined ? {} : { responsibility }),
    })
    return {
      requestId: result.requestId, action: result.action, outcome: result.outcome,
      receipt: { operationId: result.receipt.operationId, requestId: result.receipt.requestId, sequence: result.receipt.sequence, occurredAt: result.receipt.occurredAt },
      projectRef: result.projectRef, memberRef: result.memberRef,
      ...(result.responsibility === undefined ? {} : { responsibility: result.responsibility }),
    }
  },
})

/**
 * Edit one Project's display facts or archive it. The update is a patch: a
 * field the call leaves out keeps the value stored when the ledger's serialized
 * section runs, so a rename never writes back a goal the Human changed while it
 * was queued. Archival is the lifecycle decision, not a deletion.
 */
export const projectUpdate = defineTool({
  name: 'project_update',
  description: "Edit one Project as the Team manager: rename it, restate its shared goal, or archive it. `update` is a partial patch — every field you leave out keeps the value stored at the moment the write runs, so a rename cannot overwrite a goal that landed while it was queued — and it needs at least one of `name` or `description`. `archive` takes the refs alone: the Project disappears from every Team surface with its history kept, its active Claims release, the related Attention clears, and every subscription it owns stops with its private state cleared; open Tasks return to the Human under the ledger's own rules. Archiving is the end state this version offers — there is no permanent-removal tool, and the Project's facts stay readable. A refusal names its reason and wrote nothing, including a repeated archive and an archived Project ref. A cleanup that fails after the archival committed is named in the answer as a cleanup warning, and the receipt still stands. Only the live Team manager Session holds this tool.",
  parameters: {
    action: { type: 'string', required: true, enum: ['update', 'archive'], description: "The change to make: 'update' patches the display facts, 'archive' ends the Project's life without deleting it." },
    workspaceId: { type: 'string', required: true, description: "The Project's Workspace id exactly as team_overview listed it." },
    projectRef: { type: 'string', required: true, description: "Full branded Project ref exactly as team_overview returned it, including the 'project:' prefix." },
    name: { type: 'string', description: "update only: the Project's new name, non-empty. Omit to keep the stored one; refused on archive." },
    description: { type: 'string', description: "update only: the shared goal, which may be an explicit empty string. Omit to keep the stored one; refused on archive." },
    requestId: { type: 'string', description: 'Your own idempotency key for this write, with the same replay rule as member_create.' },
  },
  output: projectUpdateOutput,
  async execute(rawArgs, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('project_update requires an Agent session')
    const host = service(agent)
    // A blank name names no rename. A description is different: an explicit
    // empty one clears the shared goal, so it is only meaningless on archive.
    const args = blankToAbsent(rawArgs, ['name', 'requestId'])
    const action = args.action as 'update' | 'archive'
    const description = typeof rawArgs.description === 'string' ? rawArgs.description : undefined
    if (action === 'archive' && (args.name !== undefined || (description !== undefined && description !== ''))) {
      throw new Error('project_update archives a Project by ref alone; a name or shared goal belongs to the update action.')
    }
    const statedDescription = action === 'archive' ? undefined : description
    const result = await host.managerUpdateProjectForAgent(agent, {
      requestId: (args.requestId as AgentTeamRequestId | undefined) ?? requestId(agent.id, exec.callId),
      workspaceId: args.workspaceId as WorkspaceId,
      projectRef: projectRefOf(args.projectRef) as AgentTeamProjectRef,
      action,
      ...(args.name === undefined ? {} : { name: args.name as string }),
      ...(statedDescription === undefined ? {} : { description: statedDescription }),
    })
    return {
      requestId: result.requestId, action: result.action, outcome: result.outcome,
      receipt: { operationId: result.receipt.operationId, requestId: result.receipt.requestId, sequence: result.receipt.sequence, occurredAt: result.receipt.occurredAt },
      projectRef: result.projectRef, name: result.name, description: result.description, state: result.state,
      ...(result.releasedClaims === undefined ? {} : { releasedClaims: result.releasedClaims }),
      ...(result.subscriptionsCleared === undefined ? {} : { subscriptionsCleared: result.subscriptionsCleared }),
      ...(result.cleanupWarning === undefined ? {} : { cleanupWarning: result.cleanupWarning }),
    }
  },
})

/**
 * Edit one Member's mutable facts as the manager. The write is a patch: every
 * field the call leaves out keeps the value stored when the ledger's serialized
 * section runs, so a concurrent rename or description edit is never written
 * back over. A capability override is cleared only by `clearCapabilities`,
 * which is why "unchanged" and "cleared" stay different calls.
 */
export const memberUpdate = defineTool({
  name: 'member_update',
  description: "Edit one Agent Member's mutable facts as the Team manager: its description, its model route, and its capability configuration. The handle and the Member preset are not editable here. This is a partial update — every field you leave out keeps the value stored at the moment the write runs, so an edit cannot overwrite a rename or description change that landed while it was queued. An omitted `capabilities` keeps the stored override; pass `clearCapabilities: true` to restore the full standard surface (the two are refused together, because clearing is not the same as setting an empty list). A replacement model is checked against the same catalog team_models lists, and only while the request is new: the same requestId with the same patch replays to its original receipt even if the catalog or the Member's other fields changed since, while a changed patch under a reused id is refused as a collision. The answer keeps the durable receipt and reports how far the stored configuration reached the live runtime; a committed write whose live apply failed answers `effect: failed:model-apply` or `failed:capability-apply` with the Member's own diagnostic instead of pretending it took effect, and replaying the same requestId retries the effect the stored route still owes. Only the live Team manager Session holds this tool.",
  parameters: {
    memberRef: { type: 'string', required: true, description: "Full branded Member ref exactly as team_overview returned it, including the 'member:' prefix. Never a handle: the same handle in two Workspaces is two Members." },
    description: { type: 'string', description: "The Member's new global standing. Omit to keep the current one; an explicit blank is refused, because a Member is addressed by what it is for." },
    model: { type: 'object', additionalProperties: false, properties: {
      provider: { type: 'string', required: true, description: 'Provider id exactly as team_models listed it.' },
      model: { type: 'string', required: true, description: 'Model id exactly as team_models listed it under that provider.' },
      reasoningEffort: { type: 'string', description: 'Reasoning effort id exactly as team_models listed it for that model; absent uses the provider default.' },
    }, description: 'A replacement model route. Omit to keep the stored route; a Member always runs an explicit route, so a route cannot be cleared.' },
    capabilities: { type: 'object', additionalProperties: false, properties: {
      tools: { type: 'object', additionalProperties: false, properties: { allow: { type: 'array', items: { type: 'string' } } } },
      skills: { type: 'object', additionalProperties: false, properties: { allow: { type: 'array', items: { type: 'string' } } } },
    }, description: 'A replacement capability intent. Omit to keep the stored override; unknown names drop with a warning rather than failing the write.' },
    clearCapabilities: { type: 'boolean', description: 'Explicitly restore the full standard surface by clearing the stored capability override. Refused together with capabilities; omit (or false) to keep the override.' },
    requestId: { type: 'string', description: 'Your own idempotency key for this write. Omit it and the Host derives one per call — but then a lost answer cannot be retried by id, so read back with team_overview instead.' },
  },
  output: memberUpdateOutput,
  async execute(rawArgs, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('member_update requires an Agent session')
    const host = service(agent)
    const args = blankToAbsent(rawArgs, ['description', 'model', 'capabilities', 'clearCapabilities', 'requestId'])
    if (args.clearCapabilities === true && args.capabilities !== undefined) {
      throw new Error('member_update takes either capabilities or clearCapabilities, not both: clearing restores the full standard surface, while an empty capability list would mount nothing.')
    }
    const capabilities = args.clearCapabilities === true ? null : args.capabilities as AgentTeamMemberCapabilities | undefined
    const result = await host.managerUpdateMemberForAgent(agent, {
      requestId: (args.requestId as AgentTeamRequestId | undefined) ?? requestId(agent.id, exec.callId),
      memberRef: args.memberRef as AgentTeamMemberId,
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.model === undefined ? {} : { model: args.model as AgentTeamModelSelection }),
      ...(capabilities === undefined ? {} : { capabilities }),
    })
    return {
      requestId: result.requestId, outcome: result.outcome,
      receipt: { operationId: result.receipt.operationId, requestId: result.receipt.requestId, sequence: result.receipt.sequence, occurredAt: result.receipt.occurredAt },
      memberRef: result.memberRef, effect: result.effect,
      status: managerStatusView(result.status),
    }
  },
})

/**
 * Move one Member through its lifecycle as the manager. The three durable
 * actions ride the Host's own ledger operations; `recover` is the runtime
 * nudge with no ledger record, which is why it alone names a Workspace.
 */
export const memberState = defineTool({
  name: 'member_state',
  description: "Change one Agent Member's lifecycle as the Team manager. `suspend` and `resume` are the Host's existing durable operations (a suspended Member keeps its Session and private data, and resume activates it again); `archive` hides the Member everywhere, releases its active Claims, clears its Attention, and keeps its private memory and Session log on disk — this version has no permanent-removal tool, and archived is the end state it offers. `recover` is a runtime-only repair with no ledger record: it finishes an interrupted generation swap or suspend cleanup, rebuilds a Member whose preset composition was orphaned by a reload, or restarts one whose activation failed; it needs the Workspace id whose participation the Host verifies, and it refuses a Member that is not enabled when a restart is the only path. A refusal names its reason and writes nothing; a committed write answers its receipt and the Member's standing after it. Only the live Team manager Session holds this tool.",
  parameters: {
    action: { type: 'string', required: true, enum: ['suspend', 'resume', 'archive', 'recover'], description: "The lifecycle change to make. 'recover' is runtime-only and takes workspaceId; the other three are ledger writes that take only memberRef." },
    memberRef: { type: 'string', required: true, description: "Full branded Member ref exactly as team_overview returned it, including the 'member:' prefix." },
    workspaceId: { type: 'string', description: "recover only: the Workspace id the Member must participate in, exactly as team_overview listed it. Refused on the other actions, which address the Member alone." },
    requestId: { type: 'string', description: 'Your own idempotency key for a durable action, with the same replay rule as member_create. Ignored by recover, which writes no ledger record.' },
  },
  output: memberStateOutput,
  async execute(rawArgs, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('member_state requires an Agent session')
    const host = service(agent)
    const args = blankToAbsent(rawArgs, ['workspaceId', 'requestId'])
    const action = args.action as 'suspend' | 'resume' | 'archive' | 'recover'
    if (action === 'recover' && args.workspaceId === undefined) {
      throw new Error('member_state recover needs workspaceId: the Host verifies the Member participates in that Workspace before it repairs the runtime.')
    }
    if (action !== 'recover' && args.workspaceId !== undefined) {
      throw new Error("member_state takes workspaceId only with recover; suspend, resume and archive address the Member alone.")
    }
    const result = await host.managerSetMemberStateForAgent(agent, {
      requestId: (args.requestId as AgentTeamRequestId | undefined) ?? requestId(agent.id, exec.callId),
      memberRef: args.memberRef as AgentTeamMemberId,
      action,
      ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId as WorkspaceId }),
    })
    return {
      requestId: result.requestId, action: result.action, outcome: result.outcome,
      ...(result.receipt === undefined ? {} : { receipt: { operationId: result.receipt.operationId, requestId: result.receipt.requestId, sequence: result.receipt.sequence, occurredAt: result.receipt.occurredAt } }),
      memberRef: result.memberRef,
      status: managerStatusView(result.status),
      ...(result.releasedClaims === undefined ? {} : { releasedClaims: result.releasedClaims }),
      ...(result.removedAttention === undefined ? {} : { removedAttention: result.removedAttention }),
    }
  },
})

/**
 * Change one Member's Workspace participation as the manager. Joining is the
 * same pure relation the Web Client grants — no Session is created or moved —
 * and leaving the creation Workspace is the ledger's own refusal, which points
 * at archival instead.
 */
export const memberWorkspace = defineTool({
  name: 'member_workspace',
  description: "Change one Agent Member's Workspace participation as the Team manager. 'join' grants participation in another Workspace as a pure relation — the Member's Session is not created, copied, or moved, and it keeps working from its original checkout; the grant itself is what lets the Member be addressed there. 'leave' withdraws one non-default Workspace: its active Claims there release, its Attention and markers on those Threads clear, while identity, Session, and remaining participations stay. The creation Workspace cannot be left — archive the Member instead — and a Member that is inactive or archived is refused with its reason. Every write carries a requestId with the same replay rule as member_create. Only the live Team manager Session holds this tool.",
  parameters: {
    action: { type: 'string', required: true, enum: ['join', 'leave'], description: "The participation change to make: 'join' adds a Workspace, 'leave' withdraws one." },
    workspaceId: { type: 'string', required: true, description: "The Workspace id to join or leave, exactly as team_overview listed it. Leaving the Member's creation Workspace is refused." },
    memberRef: { type: 'string', required: true, description: "Full branded Member ref exactly as team_overview returned it, including the 'member:' prefix." },
    requestId: { type: 'string', description: 'Your own idempotency key for this write, with the same replay rule as member_create.' },
  },
  output: memberWorkspaceOutput,
  async execute(rawArgs, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('member_workspace requires an Agent session')
    const host = service(agent)
    const args = blankToAbsent(rawArgs, ['requestId'])
    const result = await host.managerChangeMemberWorkspaceForAgent(agent, {
      requestId: (args.requestId as AgentTeamRequestId | undefined) ?? requestId(agent.id, exec.callId),
      action: args.action as 'join' | 'leave',
      memberRef: args.memberRef as AgentTeamMemberId,
      workspaceId: args.workspaceId as WorkspaceId,
    })
    return {
      requestId: result.requestId, outcome: result.outcome,
      receipt: { operationId: result.receipt.operationId, requestId: result.receipt.requestId, sequence: result.receipt.sequence, occurredAt: result.receipt.occurredAt },
      memberRef: result.memberRef, workspaceId: result.workspaceId, workspaceIds: [...result.workspaceIds],
      ...(result.releasedClaims === undefined ? {} : { releasedClaims: result.releasedClaims }),
      ...(result.removedAttention === undefined ? {} : { removedAttention: result.removedAttention }),
    }
  },
})
