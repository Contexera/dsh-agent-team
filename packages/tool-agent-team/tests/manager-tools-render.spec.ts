import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { renderText, teamTools } from './render-text.ts'

/**
 * The nine manager tools' model-visible contract. A render is the only channel
 * a tool result reaches the model through, so every fact these specs assert is
 * one the manager would otherwise have to guess: what each Member is for, what
 * its capability configuration actually mounted, and which literal a write
 * answers with. Each fixture is validated against the tool's own output schema
 * first, so a render cannot drift from the shape it claims to describe.
 */

const WORKSPACE = 'workspace:alpha'
const PROJECT = 'project:046dd831-c679-4279-b6aa-7813476cf12e'
const OTHER_PROJECT = 'project:5c87f6ba-039a-4db6-97fa-30f680ef3323'
const MEMBER = 'member:93ab2850-4d67-4218-9913-e68fc291c920'
const OTHER_MEMBER = 'member:6d5ac10d-3ef6-4466-a1f7-d105ca1b6da5'
const RECEIPT = { operationId: 'operation:1', requestId: 'request:1', sequence: 42, occurredAt: '2026-11-16T07:00:00.000Z' }
const SESSION_ID = 'agent-team-93ab2850-4d67-4218-9913-e68fc291c920'
const LOG_PATH = `/data/dsh/sessions/--data-repos-dsh-agent-team--/${SESSION_ID}/session.v4.jsonl.zstd`
const READER = '/data/repos/dsh-agent-team/packages/agent-team/manager-skills/manager-session-evidence/scripts/session-evidence.mjs'
/** The Session locator every `memberRef` read carries; a fixture without it is not a real answer. */
const SESSION_EVIDENCE = { sessionId: SESSION_ID, state: 'stored', location: { kind: 'jsonl', path: LOG_PATH }, reader: { script: READER } }

function render(name: string, value: unknown, args: Record<string, unknown> = {}): string {
  const tool = teamTools().get(name)
  expect(tool, `${name} is registered`).toBeDefined()
  expect(validateJsonSchemaValue(tool!.output.schema as never, value as never), `${name} fixture matches its output schema`).toEqual([])
  return renderText(tool!, args, value)
}

function overview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaces: [{ workspaceId: WORKSPACE, title: 'Main', path: '/data/repos/dsh-agent-team', projectCount: 1, memberCount: 1 }],
    projects: [{ workspaceId: WORKSPACE, projectRef: PROJECT, name: 'general', description: 'ship the team manager', state: 'active',
      owners: [{ memberRef: OTHER_MEMBER, handle: 'Reeve', responsibility: 'owns the manager prompt' }],
      subscriptions: { active: 1, paused: 0 }, board: { open: 2, inReview: 1 } }],
    members: [{ memberRef: MEMBER, handle: 'Vera', description: '独立验收与产品评测', workspaceIds: [WORKSPACE],
      availability: 'active', presence: 'available', model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
      capabilityState: 'applied', owns: [] }],
    switches: { worker: true },
    truncated: { workspaces: false, projects: false, members: false },
    ...overrides,
  }
}

describe('team_overview renders the Team a manager designs against', () => {
  it('states what each Member is for, because that standing is what the manager itself wrote', () => {
    const text = render('team_overview', overview())
    expect(text).toContain(`${MEMBER} · @Vera — 独立验收与产品评测 · active/available · configured model: deepseek/deepseek-chat · effort high · Workspaces ${WORKSPACE}`)
  })

  it('keeps the row bounded and renders the full standing in the single-Member read', () => {
    const description = '负责跨 Project 的独立验收：评审结论、测试证据与提交检查，并对产品做系统评测——方案设计、基准与 harness 建设、执行与可复现结论，同时维护质量门禁的判定口径'
    const text = render('team_overview', overview({
      members: [{ memberRef: MEMBER, handle: 'Vera', description, workspaceIds: [WORKSPACE],
        availability: 'active', presence: 'available', capabilityState: 'applied', owns: [] }],
      member: { memberRef: MEMBER, handle: 'Vera', description, privateMemoryPath: '/data/dsh/agent-team/members/member-93ab2850', owns: [], sessionEvidence: SESSION_EVIDENCE },
    }))
    // The row carries a bounded subject with an explicit cut mark; the detail read carries the whole text.
    expect(text).toContain(`${MEMBER} · @Vera — ${description.slice(0, 79)}…`)
    expect(text).toContain(`Standing: ${description}`)
    expect(text).toContain('Private directory: /data/dsh/agent-team/members/member-93ab2850')
    // The locator is provenance plus the reader that inspects it: the manager
    // is told where the log is and that it must never open it itself.
    expect(text).toContain(`Session evidence: session ${SESSION_ID} · stored`)
    expect(text).toContain(`Stored log: jsonl · ${LOG_PATH} (backend-resolved provenance; never open it directly)`)
    expect(text).toContain(`Reader: node ${READER} — load the manager-session-evidence skill`)
  })

  it('reports a Session it cannot read as a state, never as no work', () => {
    const detail = (sessionEvidence: Record<string, unknown>) => render('team_overview', overview({
      member: { memberRef: MEMBER, handle: 'Vera', description: '独立验收', privateMemoryPath: '/data/dsh/agent-team/members/member-93ab2850',
        owns: [], sessionEvidence },
    }))
    const pending = detail({ sessionId: SESSION_ID, state: 'pending', reader: { script: READER } })
    expect(pending).toContain(`Session evidence: session ${SESSION_ID} · pending`)
    expect(pending).toContain('no materialized log yet')
    expect(pending).not.toContain('Stored log:')

    const missing = detail({ sessionId: SESSION_ID, state: 'missing', reader: { script: READER } })
    expect(missing).toContain('not evidence that the Member did no work')

    const unreadable = detail({ sessionId: SESSION_ID, state: 'unreadable', reader: { script: READER },
      failure: { kind: 'corrupt', detail: 'corrupt session log: header line is not valid JSON' } })
    expect(unreadable).toContain('Unreadable: corrupt — corrupt session log: header line is not valid JSON')
    // A refused format names the artifact it refused, because that is the only
    // actionable fact: the log exists and this build cannot interpret it.
    const refused = detail({ sessionId: SESSION_ID, state: 'unreadable', reader: { script: READER },
      failure: { kind: 'refused', detail: 'uses log format v9', location: { kind: 'jsonl', path: LOG_PATH } } })
    expect(refused).toContain(`Unreadable: refused — uses log format v9 (jsonl · ${LOG_PATH})`)
  })

  it('says so when a Member records no standing instead of printing nothing', () => {
    const text = render('team_overview', overview({
      members: [{ memberRef: MEMBER, handle: 'Vera', description: '', workspaceIds: [WORKSPACE],
        availability: 'active', presence: 'available', capabilityState: 'applied', owns: [] }],
      member: { memberRef: MEMBER, handle: 'Vera', description: '', privateMemoryPath: '/data/dsh/agent-team/members/member-93ab2850', owns: [], sessionEvidence: SESSION_EVIDENCE },
    }))
    expect(text).toContain(`${MEMBER} · @Vera · active/available · configured model: the deployment default`)
    expect(text).toContain('Standing: (none recorded)')
  })

  it('reads an inherited route as the deployment default rather than as a missing answer', () => {
    const text = render('team_overview', overview({
      members: [{ memberRef: MEMBER, handle: 'Vera', description: '独立验收', workspaceIds: [WORKSPACE],
        availability: 'active', presence: 'available', capabilityState: 'applied', owns: [] }],
    }))
    expect(text).toContain(`${MEMBER} · @Vera — 独立验收 · active/available · configured model: the deployment default`)
  })

  it('reports a dropped capability name with the names the Member can hold, and a stored-but-unapplied configuration', () => {
    const text = render('team_overview', overview({
      members: [
        { memberRef: MEMBER, handle: 'Vera', description: '独立验收', workspaceIds: [WORKSPACE],
          availability: 'active', presence: 'available', capabilityState: 'applied',
          capabilityWarnings: [{ name: 'read_file', knownNames: ['read', 'write', 'edit'] }], owns: [] },
        { memberRef: OTHER_MEMBER, handle: 'Reeve', description: '技术把关', workspaceIds: [WORKSPACE],
          availability: 'active', presence: 'available', capabilityState: 'pending', owns: [] },
      ],
    }))
    expect(text).toContain("capability warning: 'read_file' is not a name this Member can hold, so the runtime ignores it — names it can hold: read, write, edit")
    expect(text).toContain('capabilities pending')
    // An applied configuration is the normal case and stays unlabelled.
    expect(text).not.toContain('capabilities applied')
  })

  it('names the collection a bound cut instead of shortening it silently', () => {
    const text = render('team_overview', overview({ truncated: { workspaces: false, projects: false, members: true } }))
    expect(text).toContain('Truncated: Members — narrow the scope or raise limit; nothing was dropped silently.')
  })

  it('reads an owner with no recorded responsibility as unspecified, and a Human-only Project as a fact', () => {
    const text = render('team_overview', overview({
      projects: [
        { workspaceId: WORKSPACE, projectRef: PROJECT, name: 'general', description: 'ship the team manager', state: 'active',
          owners: [{ memberRef: OTHER_MEMBER, handle: 'Reeve' }], subscriptions: { active: 0, paused: 0 }, board: { open: 0, inReview: 0 } },
        { workspaceId: WORKSPACE, projectRef: OTHER_PROJECT, name: 'evaluation', description: '', state: 'active',
          owners: [], subscriptions: { active: 0, paused: 2 }, board: { open: 1, inReview: 0 } },
      ],
    }))
    expect(text).toContain(`owners @Reeve (unspecified) · board clear · subscriptions 0`)
    expect(text).toContain(`${OTHER_PROJECT} · evaluation · owners: the Human only · 1 open · subscriptions 2 paused`)
  })
})

describe('team_models renders the catalog a route choice reads', () => {
  it('carries each model\'s own description and names the failed providers as failures', () => {
    const text = render('team_models', {
      default: { provider: 'deepseek', model: 'deepseek-chat' },
      routableProviders: ['deepseek'],
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', description: 'general purpose', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', description: 'long reasoning' },
      ] }],
      failures: [{ id: 'anthropic', name: 'Anthropic', message: 'catalog lookup timed out' }],
      memberPresets: ['team-member'],
    })
    expect(text).toContain('  deepseek-chat · DeepSeek Chat — general purpose · efforts high')
    expect(text).toContain('  deepseek-reasoner · DeepSeek Reasoner — long reasoning')
    expect(text).toContain('Failures — providers whose catalog could not be read; a failure, never an empty list:')
    expect(text).toContain('  anthropic · Anthropic — catalog lookup timed out')
    expect(text).toContain('Member presets: team-member')
  })
})

describe('member_create renders the standing a retry continues from', () => {
  it('answers a live Member with its receipt and the surface it mounted', () => {
    const text = render('member_create', {
      requestId: 'request:1', outcome: 'committed', receipt: RECEIPT, memberRef: MEMBER, workspaceIds: [WORKSPACE],
      status: { availability: 'active', presence: 'available', capabilityState: 'applied' },
    })
    expect(text).toContain(`Member created — ${MEMBER}`)
    expect(text).toContain(`Workspaces ${WORKSPACE} · receipt operation:1 (sequence 42)`)
    expect(text).toContain('Availability active · presence available · capabilities applied')
  })

  it('keeps a committed Member whose activation failed, and names the diagnostic instead of the liveness', () => {
    const text = render('member_create', {
      requestId: 'request:1', outcome: 'committed', receipt: RECEIPT, memberRef: MEMBER, workspaceIds: [WORKSPACE],
      status: { availability: 'unavailable', presence: 'unavailable', capabilityState: 'pending',
        diagnostic: { class: 'session-refused', detail: 'the stored Session could not be read' } },
    })
    expect(text).toContain('Committed, but the Member is not live: session-refused — the stored Session could not be read')
    expect(text).toContain('The write stands; continue from this receipt and ref instead of creating it again.')
  })

  it('reports a capability name the Member cannot hold, because the write succeeded with it dropped', () => {
    const text = render('member_create', {
      requestId: 'request:1', outcome: 'committed', receipt: RECEIPT, memberRef: MEMBER, workspaceIds: [WORKSPACE],
      status: { availability: 'active', presence: 'available', capabilityState: 'applied',
        capabilityWarnings: [{ name: 'ghost_tool', knownNames: ['read', 'write'] }] },
    })
    expect(text).toContain("Capability warning: 'ghost_tool' is not a name this Member can hold, so the runtime ignores it — names it can hold: read, write")
  })
})

describe('project_create renders the ref a later grant addresses', () => {
  it('names the Project and the Members admitted at creation', () => {
    const text = render('project_create', { requestId: 'request:1', outcome: 'committed', receipt: RECEIPT, projectRef: PROJECT, memberIds: [MEMBER] })
    expect(text).toContain(`Project created — ${PROJECT}`)
    expect(text).toContain(`Members ${MEMBER} · receipt operation:1 (sequence 42)`)
  })

  it('reads an empty Project as a fact rather than a missing answer', () => {
    const text = render('project_create', { requestId: 'request:1', outcome: 'committed', receipt: RECEIPT, projectRef: PROJECT, memberIds: [] })
    expect(text).toContain('Members none yet · receipt operation:1 (sequence 42)')
  })
})

describe('project_owner renders what an owner now answers for', () => {
  it('states a grant with its responsibility and the participation it implies', () => {
    const text = render('project_owner', { requestId: 'request:1', action: 'add', outcome: 'committed', receipt: RECEIPT,
      projectRef: PROJECT, memberRef: MEMBER, responsibility: 'owns the release checklist' })
    expect(text).toContain(`Owner granted — ${MEMBER} owns ${PROJECT}`)
    expect(text).toContain('Responsibility: owns the release checklist')
    expect(text).toContain("The grant itself is this Member's Project participation")
  })

  it('renders a cleared responsibility as unspecified, the same word every other surface uses', () => {
    const text = render('project_owner', { requestId: 'request:1', action: 'update', outcome: 'committed', receipt: RECEIPT,
      projectRef: PROJECT, memberRef: MEMBER, responsibility: '' })
    expect(text).toContain('Responsibility updated')
    expect(text).toContain('Responsibility: unspecified')
  })

  it('says what withdrawing keeps, so a removal is not read as a Task loss', () => {
    const text = render('project_owner', { requestId: 'request:1', action: 'remove', outcome: 'committed', receipt: RECEIPT,
      projectRef: PROJECT, memberRef: MEMBER })
    expect(text).toContain(`Owner withdrawn — ${MEMBER} no longer owns ${PROJECT}`)
    expect(text).toContain('A Member that still participates in this Project in another way keeps its Task responsibility')
    expect(text).not.toContain('Responsibility:')
  })
})

describe('project_update renders the patch it applied and the cleanup it owes', () => {
  it('answers an update with the stored name and goal', () => {
    const text = render('project_update', { requestId: 'request:1', action: 'update', outcome: 'committed', receipt: RECEIPT,
      projectRef: PROJECT, name: 'Parser', description: '把解析收敛到一个权威实现', state: 'active' })
    expect(text).toContain(`Project updated — ${PROJECT}`)
    expect(text).toContain('Name: Parser')
    expect(text).toContain('Shared goal: 把解析收敛到一个权威实现')
  })

  it('renders an explicit empty goal as recorded-none rather than blank', () => {
    const text = render('project_update', { requestId: 'request:1', action: 'update', outcome: 'committed', receipt: RECEIPT,
      projectRef: PROJECT, name: 'Parser', description: '', state: 'active' })
    expect(text).toContain('Shared goal: (none recorded)')
  })

  it('counts what archival released and keeps a failed cleanup visible beside a standing receipt', () => {
    const text = render('project_update', { requestId: 'request:1', action: 'archive', outcome: 'committed', receipt: RECEIPT,
      projectRef: PROJECT, name: 'Parser', description: '', state: 'archived',
      releasedClaims: 2, subscriptionsCleared: 1, cleanupWarning: 'the subscription store is read-only' })
    expect(text).toContain(`Project archived — ${PROJECT} (Parser)`)
    expect(text).toContain('2 active Claim(s) released · 1 subscription(s) stopped and cleared')
    expect(text).toContain('Cleanup warning: the archival is durable, but clearing subscription state failed — the subscription store is read-only')
    expect(text).toContain('Receipt operation:1 (sequence 42)')
  })
})

describe('member_update renders how far the stored configuration reached', () => {
  const base = { requestId: 'request:1', outcome: 'committed', receipt: RECEIPT, memberRef: MEMBER }

  it('names the literal effect the description promises for a live apply', () => {
    const text = render('member_update', { ...base, effect: 'applied',
      status: { availability: 'active', presence: 'available', capabilityState: 'applied' } })
    expect(text).toContain('Runtime effect: applied — the live runtime picked up the new configuration.')
  })

  it('names a failed model apply by its literal token and keeps the stored route standing', () => {
    const text = render('member_update', { ...base, effect: 'failed:model-apply',
      status: { availability: 'active', presence: 'error', capabilityState: 'applied',
        diagnostic: { class: 'runtime', detail: 'provider refused the route' } } })
    expect(text).toContain('Runtime effect: failed:model-apply — stored, but the live model route apply failed.')
    expect(text).toContain('Saved, but the model route could not be applied: provider refused the route')
    expect(text).toContain('The stored route stands; replaying this request retries it, and the next activation applies it.')
  })

  it('names a failed capability apply by its literal token', () => {
    const text = render('member_update', { ...base, effect: 'failed:capability-apply',
      status: { availability: 'active', presence: 'error', capabilityState: 'pending',
        diagnostic: { class: 'runtime', detail: 'the runtime refused the restriction' } } })
    expect(text).toContain('Runtime effect: failed:capability-apply — stored, but the live capability apply failed.')
    expect(text).toContain('The stored configuration stands; the next activation retries it.')
  })

  it('reports a deferred effect as stored, not as applied', () => {
    const text = render('member_update', { ...base, effect: 'deferred:no-live-handle',
      status: { availability: 'suspended', presence: 'unavailable', capabilityState: 'pending' } })
    expect(text).toContain('Runtime effect: deferred:no-live-handle — stored; it takes effect at the next activation.')
  })

  it('reports a capability name the Member cannot hold', () => {
    const text = render('member_update', { ...base, effect: 'applied',
      status: { availability: 'active', presence: 'available', capabilityState: 'applied',
        capabilityWarnings: [{ name: 'ghost_tool', knownNames: ['read'] }] } })
    expect(text).toContain("Capability warning: 'ghost_tool' is not a name this Member can hold")
  })
})

describe('member_state renders the lifecycle fact and its consequences', () => {
  it('answers a durable action with its receipt and the standing after it', () => {
    const text = render('member_state', { requestId: 'request:1', action: 'suspend', outcome: 'committed', receipt: RECEIPT,
      memberRef: MEMBER, status: { availability: 'suspended', presence: 'unavailable', capabilityState: 'pending' } })
    expect(text).toContain(`Member suspended — ${MEMBER}`)
    expect(text).toContain('Receipt operation:1 (sequence 42) · availability suspended · presence unavailable')
  })

  it('counts what archival released and keeps the private data a fact', () => {
    const text = render('member_state', { requestId: 'request:1', action: 'archive', outcome: 'committed', receipt: RECEIPT,
      memberRef: MEMBER, status: { availability: 'archived', presence: 'unavailable', capabilityState: 'pending' },
      releasedClaims: 1, removedAttention: 3 })
    expect(text).toContain('1 active Claim(s) released · 3 Attention row(s) cleared')
    expect(text).toContain('Private memory and the Session log stay on disk; nothing was deleted.')
  })

  it('says a recovery wrote no ledger record, and reports a Member that is still not live', () => {
    const text = render('member_state', { requestId: 'request:1', action: 'recover', outcome: 'runtime-only',
      memberRef: MEMBER, status: { availability: 'unavailable', presence: 'unavailable', capabilityState: 'pending',
        diagnostic: { class: 'preset-composition', detail: 'the preset composition is orphaned' } } })
    expect(text).toContain(`Member recovery — ${MEMBER}`)
    expect(text).toContain('Runtime-only: no ledger record was written.')
    expect(text).toContain('Still not live: preset-composition — the preset composition is orphaned')
    expect(text).not.toContain('Receipt')
  })
})

describe('member_workspace renders participation as a relation, not a Session move', () => {
  it('lists every Workspace after a join and states that no Session moved', () => {
    const text = render('member_workspace', { requestId: 'request:1', outcome: 'committed', receipt: RECEIPT,
      memberRef: MEMBER, workspaceId: WORKSPACE, workspaceIds: [WORKSPACE, 'workspace:beta'] })
    expect(text).toContain(`Member ${MEMBER} participates in ${WORKSPACE}, workspace:beta`)
    expect(text).toContain('Its Session did not move: participation is a ledger relation, not a Session copy.')
  })

  it('counts what leaving released, in the Workspace that was left', () => {
    const text = render('member_workspace', { requestId: 'request:1', outcome: 'committed', receipt: RECEIPT,
      memberRef: MEMBER, workspaceId: 'workspace:beta', workspaceIds: [WORKSPACE], releasedClaims: 2, removedAttention: 1 })
    expect(text).toContain(`Member ${MEMBER} participates in ${WORKSPACE}`)
    expect(text).toContain('2 active Claim(s) released · 1 Attention row(s) cleared in workspace:beta')
  })
})
