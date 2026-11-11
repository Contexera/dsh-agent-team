/**
 * The Team settings page's configuration groups: the Host row's compaction
 * threshold and its experimental Worker delegation settings.
 *
 * The shared settings form addresses top-level section fields only, while both
 * groups live inside the row as objects. Each scope below flattens one group for
 * the form and maps its edits back onto child paths, so a save never restates a
 * sibling field beside the one it means.
 */

import { useSyncExternalStore } from 'react'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  SettingsFormModel,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormPathOp,
  type SettingsFormScope, type SettingsFormScopeSnapshot, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { WORKER_ENGINES } from '@contexera/dsh-agent-team/worker-settings'
import { formatCapacity, parseCapacity } from './capacity.ts'

/** One engine's Worker settings as the row stores them; the Host schema owns what each field means. */
export interface WorkerEngineSection {
  enabled?: boolean | undefined
  executable?: string | undefined
  sandbox?: string | undefined
}

/** The row's Worker group: the experimental switch, the default engine, and each engine's own settings. */
export interface WorkerSection {
  enabled?: boolean | undefined
  defaultEngine?: string | undefined
  engines?: {
    codex?: WorkerEngineSection | undefined
    claude?: WorkerEngineSection | undefined
  } | undefined
}

/** The Host row fields this form reads. */
export interface TeamConfigSection {
  memberCompaction?: { tokens?: number | undefined } | undefined
  worker?: WorkerSection | undefined
}

/** The group flattened to the one field the form edits. */
export interface TeamConfigValues {
  tokens?: number | undefined
}

/** Staged state and actions the settings page renders. */
export interface TeamConfigState extends SettingsFormShell {
  tokens: SettingsFieldState
}

/** The configuration group's whole outward face. */
export interface TeamConfigFace extends SettingsFormActions {
  getSnapshot(): TeamConfigState
  subscribe(listener: () => void): () => void
}

/** Read one plain-object layer, leaving every other shape absent. */
function recordOf(layer: unknown): Record<string, unknown> | undefined {
  return typeof layer === 'object' && layer !== null && !Array.isArray(layer)
    ? layer as Record<string, unknown>
    : undefined
}

/** Follow one path through plain objects; undefined when any step is not one. */
function leafAt(layer: unknown, path: readonly string[]): unknown {
  let node: unknown = layer
  for (const step of path) {
    const record = recordOf(node)
    if (record === undefined) return undefined
    node = record[step]
  }
  return node
}

/** Whether the layer itself carries the path's last key, which is what marks a field overridden. */
function ownAt(layer: unknown, path: readonly string[]): boolean {
  const key = path.at(-1)
  const parent = recordOf(leafAt(layer, path.slice(0, -1)))
  return parent !== undefined && key !== undefined && Object.hasOwn(parent, key)
}

/** Project one Host snapshot onto the flattened form shape. */
function flatten(snapshot: ConfigFormSnapshot<TeamConfigSection>): SettingsFormScopeSnapshot<TeamConfigValues> {
  const base = recordOf(recordOf(snapshot.base)?.memberCompaction)
  const user = recordOf(recordOf(snapshot.user)?.memberCompaction)
  return {
    status: snapshot.status,
    value: snapshot.value === undefined
      ? undefined
      : { tokens: snapshot.value.memberCompaction?.tokens },
    base: { tokens: base?.tokens },
    // Presence, not equality, marks the field overridden: only an own `tokens`
    // key in the user layer counts.
    user: user !== undefined && Object.hasOwn(user, 'tokens') ? { tokens: user.tokens } : {},
    writable: snapshot.writable,
    revision: snapshot.revision,
  }
}

/** Translate one flattened field edit into the Host group's child path. */
function sectionOp(op: SettingsFormPathOp): SettingsPathOpView {
  const path = ['memberCompaction', ...op.path]
  return op.op === 'set'
    ? { op: 'set', path, value: op.value as JsonValue }
    : { op: 'unset', path }
}

/**
 * Wrap the Host row's shared form as the flattened scope the staged model
 * reads and writes.
 * @param form - the Host row's configuration form.
 * @returns the same document seen as the group's single field.
 */
export function teamConfigScope(form: ConfigForm<TeamConfigSection>, onSaved?: () => void): SettingsFormScope<TeamConfigValues> {
  return {
    getSnapshot: () => flatten(form.getSnapshot()),
    subscribe: listener => form.subscribe(listener),
    mutate: async (ops, expectedRevision) => {
      const accepted = await form.mutate(ops.map(sectionOp), expectedRevision)
      if (accepted) onSaved?.()
      return accepted
    },
  }
}

/** The threshold field: the accepted spelling decides, never a silent rewrite. */
const TOKENS_FIELD: SettingsFieldSpec = {
  field: 'tokens',
  format: value => typeof value === 'number' ? formatCapacity(value) : '',
  parse: (text) => {
    const parsed = parseCapacity(text)
    if (parsed === undefined) return { kind: 'clear' }
    return Number.isSafeInteger(parsed) && parsed > 0 && !Object.is(parsed, -0)
      ? { kind: 'set', value: parsed }
      : undefined
  },
}

/** Stage the threshold over the Host row and publish what the page renders. */
export class TeamConfigController implements TeamConfigFace {
  private readonly form: SettingsFormModel<TeamConfigValues>
  private readonly store: SnapshotStore<TeamConfigState>
  private readonly actions: SettingsFormActions

  /** @param scope - the Host row seen through {@link teamConfigScope}. */
  constructor(scope: SettingsFormScope<TeamConfigValues>) {
    this.form = new SettingsFormModel(scope, [TOKENS_FIELD])
    this.actions = this.form.actions()
    this.store = this.form.bind(() => ({ ...this.form.shell(), tokens: this.form.field('tokens') }))
  }

  readonly getSnapshot = (): TeamConfigState => this.store.getSnapshot()

  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  readonly edit = (field: string, text: string): void => { this.actions.edit(field, text) }

  readonly resetField = (field: string): void => { this.actions.resetField(field) }

  readonly save = (): void => { this.actions.save() }

  readonly discard = (): void => { this.actions.discard() }

  /** Release the form's accepted-value subscription. */
  dispose(): void { this.form.dispose() }
}

/** Subscribe one rendered settings page to the staged configuration. */
export function useTeamConfig(face: TeamConfigFace): TeamConfigState {
  return useSyncExternalStore(face.subscribe, face.getSnapshot, face.getSnapshot)
}

/** The Worker group flattened to the fields the form stages. */
export interface WorkerConfigValues {
  enabled?: boolean | undefined
  defaultEngine?: string | undefined
  codexEnabled?: boolean | undefined
  codexExecutable?: string | undefined
  claudeEnabled?: boolean | undefined
  claudeExecutable?: string | undefined
}

/** One staged field of the Worker group. */
type WorkerField = keyof WorkerConfigValues

/** The Host path each staged field writes: a leaf, never a sibling. */
const WORKER_PATHS: Readonly<Record<WorkerField, readonly string[]>> = {
  enabled: ['worker', 'enabled'],
  defaultEngine: ['worker', 'defaultEngine'],
  codexEnabled: ['worker', 'engines', 'codex', 'enabled'],
  codexExecutable: ['worker', 'engines', 'codex', 'executable'],
  claudeEnabled: ['worker', 'engines', 'claude', 'enabled'],
  claudeExecutable: ['worker', 'engines', 'claude', 'executable'],
}

/** Every staged field, in the order the page reads them. */
const WORKER_FIELDS = Object.keys(WORKER_PATHS) as readonly WorkerField[]

function booleanOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** One field's effective value in a layer, or undefined where the layer stops. */
function workerValuesOf(layer: unknown): WorkerConfigValues {
  return {
    enabled: booleanOf(leafAt(layer, WORKER_PATHS.enabled)),
    defaultEngine: stringOf(leafAt(layer, WORKER_PATHS.defaultEngine)),
    codexEnabled: booleanOf(leafAt(layer, WORKER_PATHS.codexEnabled)),
    codexExecutable: stringOf(leafAt(layer, WORKER_PATHS.codexExecutable)),
    claudeEnabled: booleanOf(leafAt(layer, WORKER_PATHS.claudeEnabled)),
    claudeExecutable: stringOf(leafAt(layer, WORKER_PATHS.claudeExecutable)),
  }
}

/** Only the fields the user layer itself carries; presence is what the form reports as overridden. */
function storedWorkerValues(layer: unknown): WorkerConfigValues {
  const stored: Partial<Record<WorkerField, unknown>> = {}
  for (const field of WORKER_FIELDS) if (ownAt(layer, WORKER_PATHS[field])) stored[field] = leafAt(layer, WORKER_PATHS[field])
  return stored as WorkerConfigValues
}

/** Translate one flattened Worker field edit into the Host group's child path. */
function workerOp(op: SettingsFormPathOp): SettingsPathOpView {
  const field = op.path[0] as WorkerField | undefined
  const path = field === undefined ? undefined : WORKER_PATHS[field]
  if (path === undefined) throw new TypeError(`the Worker group stages no field ${String(field)}`)
  return op.op === 'set'
    ? { op: 'set', path: [...path], value: op.value as JsonValue }
    : { op: 'unset', path: [...path] }
}

/**
 * Wrap the Host row's shared form as the Worker group's flattened scope. The
 * group nests two levels below the row, so both the value and the presence of
 * every leaf are read along its own path.
 * @param form - the Host row's configuration form.
 * @returns the same document seen as the Worker group's fields.
 */
export function workerConfigScope(form: ConfigForm<TeamConfigSection>, onSaved?: () => void): SettingsFormScope<WorkerConfigValues> {
  return {
    getSnapshot: () => {
      const snapshot = form.getSnapshot()
      return {
        status: snapshot.status,
        value: snapshot.value === undefined ? undefined : workerValuesOf(snapshot.value),
        base: workerValuesOf(snapshot.base),
        user: storedWorkerValues(snapshot.user),
        writable: snapshot.writable,
        revision: snapshot.revision,
      }
    },
    subscribe: listener => form.subscribe(listener),
    mutate: async (ops, expectedRevision) => {
      const accepted = await form.mutate(ops.map(workerOp), expectedRevision)
      if (accepted) onSaved?.()
      return accepted
    },
  }
}

/** A boolean staged as text, the only shape a form field's draft has. */
function switchField(field: WorkerField): SettingsFieldSpec {
  return {
    field,
    format: value => value === true ? 'true' : 'false',
    parse: text => text === 'true'
      ? { kind: 'set', value: true }
      : text === 'false' ? { kind: 'set', value: false } : undefined,
  }
}

/** One of a fixed set of spellings; a stored value outside it renders as the fallback rather than as an empty control. */
function choiceField(field: WorkerField, choices: readonly string[], fallback: string): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' && choices.includes(value) ? value : fallback,
    parse: text => choices.includes(text) ? { kind: 'set', value: text } : undefined,
  }
}

/** An executable path staged as typed; a blank draft clears it so the engine falls back to its own discovery. */
function pathField(field: WorkerField): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  }
}

/** The Worker group's staged state as the page renders it. */
export interface WorkerConfigState extends SettingsFormShell {
  enabled: SettingsFieldState
  defaultEngine: SettingsFieldState
  codexEnabled: SettingsFieldState
  codexExecutable: SettingsFieldState
  claudeEnabled: SettingsFieldState
  claudeExecutable: SettingsFieldState
}

/** The Worker group's whole outward face. */
export interface WorkerConfigFace extends SettingsFormActions {
  getSnapshot(): WorkerConfigState
  subscribe(listener: () => void): () => void
  /** Stage one switch from the control's boolean, so the page never spells the field's text. */
  setSwitch(field: WorkerSwitchField, next: boolean): void
}

/** The switches the page renders; the pickers and paths stage their own text. */
export type WorkerSwitchField = 'enabled' | 'codexEnabled' | 'claudeEnabled'

/** Stage the Worker group over the Host row and publish what the page renders. */
export class WorkerConfigController implements WorkerConfigFace {
  private readonly form: SettingsFormModel<WorkerConfigValues>
  private readonly store: SnapshotStore<WorkerConfigState>
  private readonly actions: SettingsFormActions

  /** @param scope - the Host row seen through {@link workerConfigScope}. */
  constructor(scope: SettingsFormScope<WorkerConfigValues>) {
    this.form = new SettingsFormModel(scope, [
      switchField('enabled'),
      choiceField('defaultEngine', WORKER_ENGINES, WORKER_ENGINES[0]),
      switchField('codexEnabled'),
      pathField('codexExecutable'),
      switchField('claudeEnabled'),
      pathField('claudeExecutable'),
    ])
    this.actions = this.form.actions()
    this.store = this.form.bind(() => ({
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      defaultEngine: this.form.field('defaultEngine'),
      codexEnabled: this.form.field('codexEnabled'),
      codexExecutable: this.form.field('codexExecutable'),
      claudeEnabled: this.form.field('claudeEnabled'),
      claudeExecutable: this.form.field('claudeExecutable'),
    }))
  }

  readonly getSnapshot = (): WorkerConfigState => this.store.getSnapshot()

  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  readonly edit = (field: string, text: string): void => { this.actions.edit(field, text) }

  readonly resetField = (field: string): void => { this.actions.resetField(field) }

  readonly setSwitch = (field: WorkerSwitchField, next: boolean): void => {
    this.actions.edit(field, next ? 'true' : 'false')
  }

  readonly save = (): void => { this.actions.save() }

  readonly discard = (): void => { this.actions.discard() }

  /** Release the form's accepted-value subscription. */
  dispose(): void { this.form.dispose() }
}

/** Subscribe one rendered settings page to the staged Worker group. */
export function useWorkerConfig(face: WorkerConfigFace): WorkerConfigState {
  return useSyncExternalStore(face.subscribe, face.getSnapshot, face.getSnapshot)
}
