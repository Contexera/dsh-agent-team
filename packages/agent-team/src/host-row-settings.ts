/**
 * The Team Host row's whole Config, and the one rule that carries a pre-rename
 * row's values forward. Dependency-light: `index.ts` owns the service, this
 * module owns the shape and the precedence judgement.
 * @module @contexera/dsh-agent-team/host-row-settings
 */

import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { DEFAULT_MEMBER_COMPACTION, type MemberCompactionConfig } from './member-compaction.ts'
import { DEFAULT_WORKER_CONFIG, type WorkerConfig } from './worker-service.ts'
import { DEFAULT_WORKER_SANDBOX } from './worker-settings.ts'
import { DEFAULT_WAKE_RECYCLE, type WakeRecycleConfig } from './wake-recycle.ts'
import { HUMAN_PROFILE_DEFAULT_NAME, HUMAN_PROFILE_SETTINGS_SCHEMA, assertValidHumanName } from './human-profile.ts'
import { HUMAN_AVATAR_NONE } from './human-settings.ts'
import { SIDEBAR_ORDER_SETTINGS_SCHEMA, SIDEBAR_ORDER_VALUE_SCHEMA, type SidebarOrderConfig } from './sidebar-order.ts'

/**
 * The webhook trigger's deployment facts: not the listener's host and port, which the
 * isolated group in `cordis.patch.yml` owns, but where an outside service reaches it.
 */
export interface WebhookConfig {
  /** The public origin hook addresses hang from; empty means no address exists yet. */
  readonly publicOrigin: string
}

/** The webhook group before a Human has configured anything: no origin, so no address. */
export const DEFAULT_WEBHOOK_CONFIG: WebhookConfig = Object.freeze({ publicOrigin: '' })

/**
 * Config of the Team Host row. Every field is volatile: the settings service
 * offers a form only for volatile fields, so a non-volatile field would be
 * invisible and unwritable.
 */
export interface Config {
  name: Volatile<string>
  avatarRef: Volatile<string | null | undefined>
  wakeRecycle: Volatile<WakeRecycleConfig>
  memberCompaction: Volatile<MemberCompactionConfig>
  worker: Volatile<WorkerConfig>
  webhook: Volatile<WebhookConfig>
  sidebarOrder: Volatile<SidebarOrderConfig>
}

/**
 * The value form of each group: calling it validates a stored object and fills
 * the fields an older row never had. The row's own schema is derived from it,
 * so a value this module accepts is exactly a value the settings form accepts.
 */
const WAKE_RECYCLE_VALUE = z.object({
  enabled: z.boolean().default(DEFAULT_WAKE_RECYCLE.enabled),
  idleMs: z.number().min(0).default(DEFAULT_WAKE_RECYCLE.idleMs),
  minContextTokens: z.number().min(0).default(DEFAULT_WAKE_RECYCLE.minContextTokens),
})

/** Member input budget, checked before each request; a tool result can exceed it between requests. */
const MEMBER_COMPACTION_VALUE = z.object({
  enabled: z.boolean().default(DEFAULT_MEMBER_COMPACTION.enabled),
  tokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MEMBER_COMPACTION.tokens),
})

/** The wake-swap thresholds as one volatile group, with its own defaults so an unwritten profile still resolves a complete config. */
export const WAKE_RECYCLE_SETTINGS_SCHEMA = WAKE_RECYCLE_VALUE.default({}).volatile()

/** The Member input budget as one volatile group. */
export const MEMBER_COMPACTION_SETTINGS_SCHEMA = MEMBER_COMPACTION_VALUE.default({}).volatile()

/**
 * The public origin as one volatile group, judged where it is used by
 * `webhookOriginProblem`: a second regex here would be a second answer.
 */
const WEBHOOK_VALUE = z.object({
  publicOrigin: z.string().default(DEFAULT_WEBHOOK_CONFIG.publicOrigin),
})

/**
 * One engine's Worker settings: whether the operator allows it, where its CLI
 * lives, and (Codex only) the sandbox policy it runs under. The executable is a
 * deployment fact, not a per-call choice: a model never names a binary.
 */
const workerEngineValue = (sandbox: string) => z.object({
  enabled: z.boolean().default(false),
  executable: z.string().default(''),
  sandbox: z.string().default(sandbox),
})

const WORKER_VALUE = z.object({
  enabled: z.boolean().default(DEFAULT_WORKER_CONFIG.enabled),
  defaultEngine: z.union(['codex', 'claude'] as const).default(DEFAULT_WORKER_CONFIG.defaultEngine),
  engines: z.object({
    codex: workerEngineValue(DEFAULT_WORKER_SANDBOX).default({}),
    claude: workerEngineValue('').default({}),
  }).default({}),
  timeoutMs: z.number().min(0).default(DEFAULT_WORKER_CONFIG.timeoutMs),
})

/** The experimental Worker delegation group; off until the operator turns it on. */
export const WORKER_SETTINGS_SCHEMA = WORKER_VALUE.default({}).volatile()

/** The webhook deployment group. */
export const WEBHOOK_SETTINGS_SCHEMA = WEBHOOK_VALUE.default({}).volatile()

/**
 * The Host row's whole schema: the profile fields verbatim, so {@link HUMAN_PROFILE_SETTINGS_SCHEMA} keeps owning their volatility and defaults.
 * A patch layer replaces the row's whole config, so the parts are declared together.
 */
export const TEAM_HOST_ROW_SETTINGS_SCHEMA = z.object({
  ...HUMAN_PROFILE_SETTINGS_SCHEMA.dict,
  wakeRecycle: WAKE_RECYCLE_SETTINGS_SCHEMA,
  memberCompaction: MEMBER_COMPACTION_SETTINGS_SCHEMA,
  worker: WORKER_SETTINGS_SCHEMA,
  webhook: WEBHOOK_SETTINGS_SCHEMA,
  sidebarOrder: SIDEBAR_ORDER_SETTINGS_SCHEMA,
})

/** Every field the row stores, in the order a migration writes them. */
export const HOST_ROW_FIELDS = ['name', 'avatarRef', 'wakeRecycle', 'memberCompaction', 'worker', 'webhook', 'sidebarOrder'] as const

export type HostRowField = typeof HOST_ROW_FIELDS[number]

/** The values one migration writes into the current namespace; a field is present only when it must be written. */
export type HostRowWrite = {
  readonly [K in HostRowField]?: K extends 'name' ? string
    : K extends 'avatarRef' ? string | null
    : K extends 'wakeRecycle' ? WakeRecycleConfig
      : K extends 'memberCompaction' ? MemberCompactionConfig
        : K extends 'worker' ? WorkerConfig
        : K extends 'webhook' ? WebhookConfig : SidebarOrderConfig
}

/**
 * Decides what a migration may write into the Host row: the pre-rename values
 * of the fields the current namespace stores nothing for, validated against the
 * same schema the settings service will validate them with.
 *
 * `stored` is that namespace's own USER layer, never a resolved config: it
 * carries exactly the fields the Human wrote, so a field they set — even to a
 * value equal to the schema default — is not a gap and is never overwritten.
 * Both pre-rename sources go through here, so the two migrations cannot
 * disagree about precedence.
 *
 * A field that fails its schema, or a display name that is the shipped default
 * (the row says nothing a fresh row would not), is left behind.
 */
export function planHostRowWrite(
  stored: Readonly<Record<string, unknown>>,
  carried: Readonly<Record<string, unknown>>,
): HostRowWrite | undefined {
  const write: Record<string, unknown> = {}
  for (const field of HOST_ROW_FIELDS) {
    if (stored[field] !== undefined) continue
    const value = carriedField(field, carried[field])
    if (value !== undefined) write[field] = value
  }
  return Object.keys(write).length === 0 ? undefined : write as HostRowWrite
}

/** Validate one carried value, or `undefined` when it cannot be written as it stands. */
function carriedField(field: HostRowField, raw: unknown): unknown {
  if (raw === undefined) return undefined
  if (field === 'name') {
    if (typeof raw !== 'string') return undefined
    try {
      const name = assertValidHumanName(raw)
      return name === HUMAN_PROFILE_DEFAULT_NAME ? undefined : name
    } catch {
      return undefined
    }
  }
  if (field === 'avatarRef') {
    if (raw === HUMAN_AVATAR_NONE) return HUMAN_AVATAR_NONE
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
  }
  const schema = field === 'wakeRecycle' ? WAKE_RECYCLE_VALUE
    : field === 'memberCompaction' ? MEMBER_COMPACTION_VALUE
      : field === 'webhook' ? WEBHOOK_VALUE : SIDEBAR_ORDER_VALUE_SCHEMA
  try {
    // The group schema fills the fields an older row never stored, so a partial
    // group arrives complete instead of silently keeping a stale default.
    return schema(raw as never)
  } catch {
    return undefined
  }
}
