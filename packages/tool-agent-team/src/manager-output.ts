import type { DefineToolOptions } from '@deepseek-ai/dsh-tools'
import { boundedSubject } from './subject.ts'

function managerBoardText(board: { readonly open: number; readonly inReview: number }): string {
  const parts: string[] = []
  if (board.open > 0) parts.push(`${board.open} open`)
  if (board.inReview > 0) parts.push(`${board.inReview} awaiting acceptance`)
  return parts.length === 0 ? 'board clear' : parts.join(', ')
}

/**
 * One ownership grant's responsibility as the overview renders it. A grant that
 * recorded none reads `unspecified` — the same word `team_view` and the Project
 * dialog use — because the render is the only channel that reaches the model,
 * so an absent field that prints nothing would leave the promise in the
 * description unfulfillable. It is a fact about the grant, never a defect.
 */
function managerResponsibilityText(responsibility: string | undefined): string {
  return responsibility === undefined ? ' (unspecified)' : ` (${responsibility})`
}

function managerStandingText(member: { readonly availability: string; readonly presence: string; readonly diagnostic?: { readonly class: string; readonly detail: string } }): string {
  const base = `${member.availability}/${member.presence}`
  return member.diagnostic === undefined ? base : `${base} · ${member.diagnostic.class}: ${member.diagnostic.detail}`
}

/**
 * One capability warning in the model's words. The runtime drops a name it does
 * not know instead of failing the write, so the warning is the only fact that
 * tells the manager its stored list is narrower than it reads — and the names
 * the Member can actually hold are the only way to correct it, because no
 * manager tool enumerates them. Bounded here: the digest is a whole surface.
 */
function managerCapabilityWarningText(warning: { readonly name: string; readonly knownNames?: readonly string[] | undefined }): string {
  const known = warning.knownNames ?? []
  const digest = known.length === 0 ? '' : ` — names it can hold: ${known.slice(0, 24).join(', ')}${known.length > 24 ? ', …' : ''}`
  return `'${warning.name}' is not a name this Member can hold, so the runtime ignores it${digest}`
}

/**
 * One Member's capability standing as a row renders it: a pending state means
 * the live surface is behind the stored configuration, and a warning means the
 * stored list is ahead of what the Member can actually hold. Both are silent
 * divergences the manager would otherwise read as a clean apply.
 */
function managerCapabilityParts(member: {
  readonly capabilityState: string
  readonly capabilityWarnings?: readonly { readonly name: string; readonly knownNames?: readonly string[] | undefined }[] | undefined
}): string[] {
  const parts: string[] = []
  if (member.capabilityState !== 'applied') parts.push(`capabilities ${member.capabilityState}`)
  for (const warning of member.capabilityWarnings ?? []) parts.push(`capability warning: ${managerCapabilityWarningText(warning)}`)
  return parts
}

const MANAGER_OVERVIEW_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  workspaces: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    workspaceId: { type: 'string', required: true }, title: { type: 'string' }, path: { type: 'string' },
    projectCount: { type: 'number', required: true }, memberCount: { type: 'number', required: true },
  } } },
  projects: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    workspaceId: { type: 'string', required: true }, projectRef: { type: 'string', required: true },
    name: { type: 'string', required: true }, description: { type: 'string', required: true }, state: { type: 'string', required: true },
    owners: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      memberRef: { type: 'string', required: true }, handle: { type: 'string', required: true }, responsibility: { type: 'string' },
    } } },
    subscriptions: { type: 'object', additionalProperties: false, required: true, properties: {
      active: { type: 'number', required: true }, paused: { type: 'number', required: true },
    } },
    board: { type: 'object', additionalProperties: false, required: true, properties: {
      open: { type: 'number', required: true }, inReview: { type: 'number', required: true },
    } },
  } } },
  members: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    memberRef: { type: 'string', required: true }, handle: { type: 'string', required: true },
    description: { type: 'string', required: true },
    workspaceIds: { type: 'array', required: true, items: { type: 'string' } },
    availability: { type: 'string', required: true }, presence: { type: 'string', required: true },
    diagnostic: { type: 'object', additionalProperties: false, properties: {
      class: { type: 'string', required: true }, detail: { type: 'string', required: true },
      location: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true }, path: { type: 'string', required: true } } },
      sessionId: { type: 'string' }, source: { type: 'string' }, occurredAt: { type: 'string' },
    } },
    model: { type: 'object', additionalProperties: false, properties: {
      provider: { type: 'string', required: true }, model: { type: 'string', required: true }, reasoningEffort: { type: 'string' },
    } },
    capabilityState: { type: 'string', required: true },
    capabilityWarnings: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string', required: true }, knownNames: { type: 'array', items: { type: 'string' } },
    } } },
    owns: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      projectRef: { type: 'string', required: true }, name: { type: 'string', required: true },
      description: { type: 'string', required: true }, state: { type: 'string', required: true },
      responsibility: { type: 'string' },
    } } },
  } } },
  switches: { type: 'object', additionalProperties: false, required: true, properties: {
    worker: { type: 'boolean', required: true },
  } },
  truncated: { type: 'object', additionalProperties: false, required: true, properties: {
    workspaces: { type: 'boolean', required: true }, projects: { type: 'boolean', required: true }, members: { type: 'boolean', required: true },
  } },
  member: { type: 'object', additionalProperties: false, properties: {
    memberRef: { type: 'string', required: true }, handle: { type: 'string', required: true },
    description: { type: 'string', required: true },
    privateMemoryPath: { type: 'string', required: true },
    owns: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      projectRef: { type: 'string', required: true }, name: { type: 'string', required: true },
      description: { type: 'string', required: true }, state: { type: 'string', required: true },
      responsibility: { type: 'string' },
    } } },
    sessionEvidence: { type: 'object', additionalProperties: false, required: true, properties: {
      sessionId: { type: 'string', required: true },
      state: { type: 'string', required: true, enum: ['stored', 'pending', 'missing', 'unreadable'] },
      location: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', required: true }, path: { type: 'string', required: true },
      } },
      reader: { type: 'object', additionalProperties: false, required: true, properties: {
        script: { type: 'string', required: true }, anchor: { type: 'string' },
      } },
      failure: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', required: true }, detail: { type: 'string', required: true },
        location: { type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', required: true }, path: { type: 'string', required: true },
        } },
      } },
    } },
  } },
} } as const

interface ManagerSessionLocatorView {
  readonly sessionId: string
  readonly state: 'stored' | 'pending' | 'missing' | 'unreadable'
  readonly location?: { readonly kind: string; readonly path: string }
  readonly reader: { readonly script: string; readonly anchor?: string }
  readonly failure?: { readonly kind: string; readonly detail: string; readonly location?: { readonly kind: string; readonly path: string } }
}

/**
 * The Session locator lines a memberRef read adds. The locator is where the
 * evidence is, not the evidence: the manager runs the shipped reader for a
 * bounded index and window, and never opens the log path by hand.
 */
function managerSessionLocatorLines(locator: ManagerSessionLocatorView): string[] {
  const lines = [`Session evidence: session ${locator.sessionId} · ${locator.state}`]
  if (locator.location !== undefined) lines.push(`Stored log: ${locator.location.kind} · ${locator.location.path} (backend-resolved provenance; never open it directly)`)
  if (locator.state === 'missing') lines.push('No durable log yet: the Session may be live and not flushed, so this is not evidence that the Member did no work.')
  if (locator.state === 'pending') lines.push('The Session exists but has no materialized log yet.')
  if (locator.failure !== undefined) {
    lines.push(`Unreadable: ${locator.failure.kind} — ${locator.failure.detail}${locator.failure.location === undefined ? '' : ` (${locator.failure.location.kind} · ${locator.failure.location.path})`}`)
  }
  lines.push(`Reader: node ${locator.reader.script}${locator.reader.anchor === undefined ? '' : ` --anchor ${locator.reader.anchor}`} — load the manager-session-evidence skill for the bounded index and window commands.`)
  return lines
}

const MANAGER_MODELS_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  default: { type: 'object', additionalProperties: false, required: true, properties: {
    provider: { type: 'string', required: true }, model: { type: 'string', required: true }, reasoningEffort: { type: 'string' },
  } },
  routableProviders: { type: 'array', required: true, items: { type: 'string' } },
  groups: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    id: { type: 'string', required: true }, name: { type: 'string', required: true },
    models: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', required: true }, name: { type: 'string', required: true }, description: { type: 'string' },
      reasoning: { type: 'object', additionalProperties: false, properties: {
        efforts: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true }, name: { type: 'string', required: true },
        } } },
      } },
    } } },
  } } },
  failures: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    id: { type: 'string', required: true }, name: { type: 'string', required: true }, message: { type: 'string', required: true },
  } } },
  memberPresets: { type: 'array', required: true, items: { type: 'string' } },
} } as const

const MANAGER_RECEIPT_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  operationId: { type: 'string', required: true }, requestId: { type: 'string', required: true },
  sequence: { type: 'number', required: true }, occurredAt: { type: 'string', required: true },
} } as const

/** The live standing a committed Member reads after its write: a failed activation is a committed fact with a diagnostic. */
const MANAGER_MEMBER_STATUS_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  availability: { type: 'string', required: true }, presence: { type: 'string', required: true },
  capabilityState: { type: 'string', required: true },
  diagnostic: { type: 'object', additionalProperties: false, properties: {
    class: { type: 'string', required: true }, detail: { type: 'string', required: true },
  } },
  capabilityWarnings: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    name: { type: 'string', required: true }, knownNames: { type: 'array', items: { type: 'string' } },
  } } },
} } as const

const MEMBER_CREATE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  requestId: { type: 'string', required: true }, outcome: { type: 'string', required: true },
  receipt: { ...MANAGER_RECEIPT_SCHEMA, required: true },
  memberRef: { type: 'string', required: true },
  workspaceIds: { type: 'array', required: true, items: { type: 'string' } },
  status: { ...MANAGER_MEMBER_STATUS_SCHEMA, required: true },
} } as const

const PROJECT_CREATE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  requestId: { type: 'string', required: true }, outcome: { type: 'string', required: true },
  receipt: { ...MANAGER_RECEIPT_SCHEMA, required: true },
  projectRef: { type: 'string', required: true },
} } as const

const PROJECT_OWNER_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  requestId: { type: 'string', required: true }, action: { type: 'string', required: true }, outcome: { type: 'string', required: true },
  receipt: { ...MANAGER_RECEIPT_SCHEMA, required: true },
  projectRef: { type: 'string', required: true },
  memberRef: { type: 'string', required: true },
  responsibility: { type: 'string' },
} } as const

function projectOwnerHead(action: string): string {
  return action === 'add' ? 'Owner granted' : action === 'update' ? 'Responsibility updated' : 'Owner withdrawn'
}

const PROJECT_UPDATE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  requestId: { type: 'string', required: true }, action: { type: 'string', required: true }, outcome: { type: 'string', required: true },
  receipt: { ...MANAGER_RECEIPT_SCHEMA, required: true },
  projectRef: { type: 'string', required: true },
  name: { type: 'string', required: true }, description: { type: 'string', required: true }, state: { type: 'string', required: true },
  releasedClaims: { type: 'number' }, subscriptionsCleared: { type: 'number' }, cleanupWarning: { type: 'string' },
} } as const

const MEMBER_UPDATE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  requestId: { type: 'string', required: true }, outcome: { type: 'string', required: true },
  receipt: { ...MANAGER_RECEIPT_SCHEMA, required: true },
  memberRef: { type: 'string', required: true },
  effect: { type: 'string', required: true },
  status: { ...MANAGER_MEMBER_STATUS_SCHEMA, required: true },
} } as const

function memberEffectText(effect: string): string {
  switch (effect) {
    case 'applied': return 'the live runtime picked up the new configuration'
    case 'already-applied': return 'no runtime change was needed'
    case 'deferred:no-live-handle': return 'stored; it takes effect at the next activation'
    case 'deferred:generation-changed': return 'stored; the Member changed generation before it could apply'
    case 'failed:model-apply': return 'stored, but the live model route apply failed'
    case 'failed:capability-apply': return 'stored, but the live capability apply failed'
    default: return effect
  }
}

const MEMBER_STATE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  requestId: { type: 'string', required: true }, action: { type: 'string', required: true },
  outcome: { type: 'string', required: true },
  receipt: { ...MANAGER_RECEIPT_SCHEMA },
  memberRef: { type: 'string', required: true },
  status: { ...MANAGER_MEMBER_STATUS_SCHEMA, required: true },
  releasedClaims: { type: 'number' }, removedAttention: { type: 'number' },
} } as const

const MEMBER_WORKSPACE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  requestId: { type: 'string', required: true }, outcome: { type: 'string', required: true },
  receipt: { ...MANAGER_RECEIPT_SCHEMA, required: true },
  memberRef: { type: 'string', required: true }, workspaceId: { type: 'string', required: true },
  workspaceIds: { type: 'array', required: true, items: { type: 'string' } },
  releasedClaims: { type: 'number' }, removedAttention: { type: 'number' },
} } as const

export const teamOverviewOutput = { schema: MANAGER_OVERVIEW_SCHEMA,
  render: (_args, value) => {
    const lines: string[] = ['Team overview — every Workspace in this installation']
    lines.push('', 'Workspaces')
    if (value.workspaces.length === 0) lines.push('No Workspaces in the Host directory.')
    else lines.push(...value.workspaces.map(workspace => `${workspace.workspaceId}${workspace.title === undefined ? '' : ` · ${workspace.title}`} · ${workspace.path ?? 'no checkout path'} · ${workspace.projectCount} Project(s), ${workspace.memberCount} Member(s)`))
    lines.push('', 'Projects')
    if (value.projects.length === 0) lines.push('No Projects.')
    else lines.push(...value.projects.map(project => {
      const owners = project.owners.length === 0 ? 'owners: the Human only'
        : `owners ${project.owners.map(owner => `@${owner.handle}${managerResponsibilityText(owner.responsibility)}`).join(', ')}`
      const subscriptions = project.subscriptions.active === 0 && project.subscriptions.paused === 0
        ? ' · subscriptions 0'
        : ` · subscriptions ${project.subscriptions.active === 0 ? '' : `${project.subscriptions.active} active`}${project.subscriptions.active > 0 && project.subscriptions.paused > 0 ? ', ' : ''}${project.subscriptions.paused === 0 ? '' : `${project.subscriptions.paused} paused`}`
      return `${project.projectRef} · ${project.name}${project.description === '' ? '' : ` — ${boundedSubject(project.description)}`} · ${owners} · ${managerBoardText(project.board)}${subscriptions}`
    }))
    lines.push('', 'Members')
    if (value.members.length === 0) lines.push('No Members.')
    else lines.push(...value.members.map(member => {
      const standing = member.description === '' ? '' : ` — ${boundedSubject(member.description)}`
      const capability = managerCapabilityParts(member)
      // A failed live apply leaves the running route behind the configured one.
      const model = member.model === undefined
        ? 'configured model: the deployment default'
        : `configured model: ${member.model.provider}/${member.model.model}${member.model.reasoningEffort === undefined ? '' : ` · effort ${member.model.reasoningEffort}`}`
      return `${member.memberRef} · @${member.handle}${standing} · ${managerStandingText(member)} · ${model}${capability.length === 0 ? '' : ` · ${capability.join(' · ')}`} · Workspaces ${member.workspaceIds.join(', ') || 'none'}${member.owns.length === 0 ? '' : ` · owns ${member.owns.map(owned => `${owned.projectRef}${managerResponsibilityText(owned.responsibility)}`).join(', ')}`}`
    }))
    lines.push('', `Switches — Worker delegation ${value.switches.worker ? 'on' : 'off'}`)
    const cut = [value.truncated.workspaces ? 'Workspaces' : '', value.truncated.projects ? 'Projects' : '', value.truncated.members ? 'Members' : ''].filter(part => part !== '')
    if (cut.length > 0) lines.push(`Truncated: ${cut.join(', ')} — narrow the scope or raise limit; nothing was dropped silently.`)
    if (value.member !== undefined) {
      lines.push('', `Member detail — ${value.member.memberRef} · @${value.member.handle}`,
        `Standing: ${value.member.description === '' ? '(none recorded)' : value.member.description}`,
        `Private directory: ${value.member.privateMemoryPath} — its path only; contents, credentials and Session bodies are not read.`,
        value.member.owns.length === 0 ? 'Owns no Project.' : `Owns ${value.member.owns.map(owned => `${owned.projectRef}${managerResponsibilityText(owned.responsibility)}`).join(', ')}.`,
        ...managerSessionLocatorLines(value.member.sessionEvidence))
    }
    lines.push('', 'Creating a Member, a Project, or an owner grant rides member_create, project_create and project_owner; Thread and Task detail stays team_thread read and team_task board.')
    return [{ type: 'text', text: lines.join('\n') }]
  },
} satisfies DefineToolOptions<{}, typeof MANAGER_OVERVIEW_SCHEMA>['output']

export const teamModelsOutput = { schema: MANAGER_MODELS_SCHEMA,
  render: (_args, value) => {
    const lines: string[] = ['Model catalog — what a Member may run',
      `Default: ${value.default.provider}/${value.default.model}${value.default.reasoningEffort === undefined ? '' : ` · effort ${value.default.reasoningEffort}`}`]
    if (value.groups.length === 0 && value.failures.length === 0) lines.push('', 'No provider returned a model.')
    for (const group of value.groups) {
      lines.push('', `${group.name} (${group.id})`)
      if (group.models.length === 0) lines.push('  no model available')
      else lines.push(...group.models.map(model => `  ${model.id} · ${model.name}${model.description === undefined || model.description === '' ? '' : ` — ${boundedSubject(model.description)}`}${model.reasoning?.efforts === undefined || model.reasoning.efforts.length === 0 ? '' : ` · efforts ${model.reasoning.efforts.map(effort => effort.id).join(', ')}`}`))
    }
    if (value.failures.length > 0) {
      lines.push('', 'Failures — providers whose catalog could not be read; a failure, never an empty list:')
      lines.push(...value.failures.map(failure => `  ${failure.id} · ${failure.name} — ${failure.message}`))
    }
    lines.push('', `Member presets: ${value.memberPresets.join(', ') || 'none'}`)
    return [{ type: 'text', text: lines.join('\n') }]
  },
} satisfies DefineToolOptions<{}, typeof MANAGER_MODELS_SCHEMA>['output']

export const memberCreateOutput = { schema: MEMBER_CREATE_SCHEMA,
  render: (_args, value) => {
    const lines = [`Member created — ${value.memberRef}`, `Workspaces ${value.workspaceIds.join(', ') || 'none'} · receipt ${value.receipt.operationId} (sequence ${value.receipt.sequence})`]
    const diagnostic = value.status.diagnostic
    if (diagnostic === undefined) {
      lines.push(`Availability ${value.status.availability} · presence ${value.status.presence} · capabilities ${value.status.capabilityState}`)
    } else {
      lines.push(`Committed, but the Member is not live: ${diagnostic.class} — ${diagnostic.detail}`,
        'The write stands; continue from this receipt and ref instead of creating it again.')
    }
    // A name the stored capability list could not hold is dropped rather than
    // refused, so the warning is the only fact that keeps "created as asked"
    // from being a false reading.
    for (const warning of value.status.capabilityWarnings ?? []) lines.push(`Capability warning: ${managerCapabilityWarningText(warning)}`)
    return [{ type: 'text', text: lines.join('\n') }]
  },
} satisfies DefineToolOptions<{}, typeof MEMBER_CREATE_SCHEMA>['output']

export const projectCreateOutput = { schema: PROJECT_CREATE_SCHEMA,
  render: (_args, value) => [
    { type: 'text', text: [
      `Project created — ${value.projectRef}`,
      `receipt ${value.receipt.operationId} (sequence ${value.receipt.sequence})`,
    ].join('\n') },
  ],
} satisfies DefineToolOptions<{}, typeof PROJECT_CREATE_SCHEMA>['output']

export const projectOwnerOutput = { schema: PROJECT_OWNER_SCHEMA,
  render: (_args, value) => {
    const lines = [`${projectOwnerHead(value.action)} — ${value.memberRef} ${value.action === 'remove' ? 'no longer owns' : 'owns'} ${value.projectRef}`]
    if (value.responsibility !== undefined) {
      lines.push(`Responsibility: ${value.responsibility === '' ? 'unspecified' : value.responsibility}`)
    }
    if (value.action === 'add') lines.push('The grant itself is this Member\'s Project participation')
    if (value.action === 'remove') lines.push('A Member that still participates in this Project in another way keeps its Task responsibility')
    lines.push(`Receipt ${value.receipt.operationId} (sequence ${value.receipt.sequence})`)
    return [{ type: 'text', text: lines.join('\n') }]
  },
} satisfies DefineToolOptions<{}, typeof PROJECT_OWNER_SCHEMA>['output']

export const projectUpdateOutput = { schema: PROJECT_UPDATE_SCHEMA,
  render: (_args, value) => {
    if (value.action === 'update') {
      return [{ type: 'text', text: [
        `Project updated — ${value.projectRef}`,
        `Name: ${value.name}`,
        `Shared goal: ${value.description === '' ? '(none recorded)' : value.description}`,
        `Receipt ${value.receipt.operationId} (sequence ${value.receipt.sequence})`,
      ].join('\n') }]
    }
    const lines = [
      `Project archived — ${value.projectRef} (${value.name})`,
      `${value.releasedClaims ?? 0} active Claim(s) released · ${value.subscriptionsCleared ?? 0} subscription(s) stopped and cleared`,
      'History is kept and the Project is hidden from every Team surface; nothing was deleted.',
      `Receipt ${value.receipt.operationId} (sequence ${value.receipt.sequence})`,
    ]
    if (value.cleanupWarning !== undefined) {
      lines.push(`Cleanup warning: the archival is durable, but clearing subscription state failed — ${value.cleanupWarning}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  },
} satisfies DefineToolOptions<{}, typeof PROJECT_UPDATE_SCHEMA>['output']

export const memberUpdateOutput = { schema: MEMBER_UPDATE_SCHEMA,
  render: (_args, value) => {
    const lines = [`Member updated — ${value.memberRef} · receipt ${value.receipt.operationId} (sequence ${value.receipt.sequence})`]
    const diagnostic = value.status.diagnostic
    // The literal effect token is part of the contract the description names,
    // and the render is the only channel a model reads it through.
    const effect = `Runtime effect: ${value.effect} — ${memberEffectText(value.effect)}.`
    if (value.effect === 'failed:capability-apply') {
      lines.push(`Saved, but the capability restriction could not be applied: ${diagnostic?.detail ?? 'the live runtime refused it'}`,
        'The stored configuration stands; the next activation retries it.', effect)
    } else if (value.effect === 'failed:model-apply') {
      lines.push(`Saved, but the model route could not be applied: ${diagnostic?.detail ?? 'the live runtime refused it'}`,
        'The stored route stands; replaying this request retries it, and the next activation applies it.', effect)
    } else if (diagnostic !== undefined) {
      lines.push(`Committed, but the Member is not live: ${diagnostic.class} — ${diagnostic.detail}`, effect)
    } else {
      lines.push(`Availability ${value.status.availability} · presence ${value.status.presence} · capabilities ${value.status.capabilityState}`, effect)
    }
    for (const warning of value.status.capabilityWarnings ?? []) lines.push(`Capability warning: ${managerCapabilityWarningText(warning)}`)
    return [{ type: 'text', text: lines.join('\n') }]
  },
} satisfies DefineToolOptions<{}, typeof MEMBER_UPDATE_SCHEMA>['output']

export const memberStateOutput = { schema: MEMBER_STATE_SCHEMA,
  render: (_args, value) => {
    const head = value.action === 'suspend' ? `Member suspended — ${value.memberRef}`
      : value.action === 'resume' ? `Member resumed — ${value.memberRef}`
      : value.action === 'archive' ? `Member archived — ${value.memberRef}`
      : `Member recovery — ${value.memberRef}`
    const lines = [head]
    if (value.action === 'recover') {
      lines.push('Runtime-only: no ledger record was written.')
      const diagnostic = value.status.diagnostic
      lines.push(diagnostic === undefined
        ? `Availability ${value.status.availability} · presence ${value.status.presence}`
        : `Still not live: ${diagnostic.class} — ${diagnostic.detail}`)
      return [{ type: 'text', text: lines.join('\n') }]
    }
    lines.push(`Receipt ${value.receipt!.operationId} (sequence ${value.receipt!.sequence}) · availability ${value.status.availability} · presence ${value.status.presence}`)
    if (value.action === 'archive') {
      lines.push(`${value.releasedClaims ?? 0} active Claim(s) released · ${value.removedAttention ?? 0} Attention row(s) cleared`,
        'Private memory and the Session log stay on disk; nothing was deleted.')
    }
    if (value.status.diagnostic !== undefined) {
      lines.push(`Diagnostic: ${value.status.diagnostic.class} — ${value.status.diagnostic.detail}`)
    }
    for (const warning of value.status.capabilityWarnings ?? []) lines.push(`Capability warning: ${managerCapabilityWarningText(warning)}`)
    return [{ type: 'text', text: lines.join('\n') }]
  },
} satisfies DefineToolOptions<{}, typeof MEMBER_STATE_SCHEMA>['output']

export const memberWorkspaceOutput = { schema: MEMBER_WORKSPACE_SCHEMA,
  render: (_args, value) => {
    const lines = [value.workspaceIds.length === 0
      ? `Member ${value.memberRef} now participates in no Workspace`
      : `Member ${value.memberRef} participates in ${value.workspaceIds.join(', ')}`]
    lines.push(`Receipt ${value.receipt.operationId} (sequence ${value.receipt.sequence})`)
    if (value.releasedClaims !== undefined || value.removedAttention !== undefined) {
      lines.push(`${value.releasedClaims ?? 0} active Claim(s) released · ${value.removedAttention ?? 0} Attention row(s) cleared in ${value.workspaceId}`)
    }
    lines.push('Its Session did not move: participation is a ledger relation, not a Session copy.')
    return [{ type: 'text', text: lines.join('\n') }]
  },
} satisfies DefineToolOptions<{}, typeof MEMBER_WORKSPACE_SCHEMA>['output']
