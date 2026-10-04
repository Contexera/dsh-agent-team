import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormPathOp, type SettingsFormScope,
  type SettingsFormScopeSnapshot, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamContextJudgeCheck } from './context-judge.ts'

/**
 * The Team settings page's staged form over the judge's row configuration.
 *
 * The page edits two groups of one settings section: the `jev` endpoint the
 * judge is mounted from, and the `gate` thresholds that decide when it is
 * asked. The profile fields that share the same namespace belong to the Human
 * profile page and are never rendered here, so this form reaches its values
 * through a projection: the shared form model addresses one flat section, and
 * the adapter below maps each control to the path it really lives at.
 *
 * The key literal is the one control that is not read back — the Host redacts
 * it, so its draft starts blank on every load, a blank draft writes nothing,
 * and removing a stored literal is an explicit clear rather than an empty
 * string.
 */

/** Where each control's value lives inside the Team row's settings section. */
const FIELD_PATHS = {
  apiBase: ['jev', 'apiBase'],
  model: ['jev', 'model'],
  apiKeyEnv: ['jev', 'apiKeyEnv'],
  apiKey: ['jev', 'apiKey'],
  tokens: ['gate', 'tokens'],
  idleMs: ['gate', 'idleMs'],
  judgeTimeoutMs: ['gate', 'judgeTimeoutMs'],
} as const

/** One control this page owns. */
export type TeamGateField = keyof typeof FIELD_PATHS

/** The two groups this page edits, as they sit inside the Team row's section. */
export interface TeamGateSection {
  /** The judge's endpoint configuration. */
  readonly jev?: unknown
  /** The long-gap gate's thresholds. */
  readonly gate?: unknown
}

/**
 * Read one group of a section layer as a plain record.
 * @param layer - a section, or one of its composition layers.
 * @param group - group name inside the section.
 * @returns the group's members, or undefined when the layer carries none.
 */
function groupOf(layer: unknown, group: string): Record<string, unknown> | undefined {
  if (layer === null || typeof layer !== 'object') return undefined
  const value = (layer as Record<string, unknown>)[group]
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

/**
 * Project one section layer onto the controls this page renders. A control
 * whose group or member the layer does not carry stays absent rather than
 * becoming an empty string, which is what the model reads to decide whether a
 * field is overridden and what a reset reverts to.
 * @param layer - a section, or one of its composition layers.
 * @returns the flat control values, or undefined when the layer carries none.
 */
function flatten(layer: unknown): Record<string, unknown> | undefined {
  if (layer === null || typeof layer !== 'object') return undefined
  const flat: Record<string, unknown> = {}
  for (const [field, path] of Object.entries(FIELD_PATHS) as [TeamGateField, readonly string[]][]) {
    const group = groupOf(layer, path[0]!)
    if (group !== undefined && Object.hasOwn(group, path[1]!)) flat[field] = group[path[1]!]
  }
  return flat
}

/** Address one control's edit at the path it really lives at. */
function locate(op: SettingsFormPathOp): SettingsFormPathOp {
  const path = FIELD_PATHS[op.path[0] as TeamGateField]
  return op.op === 'set'
    ? { op: 'set', path: [...path], value: op.value }
    : { op: 'unset', path: [...path] }
}

/** The shared form model's view of this page's controls, over the real section. */
class TeamGateScope implements SettingsFormScope<Record<string, unknown>> {
  constructor(private readonly section: SettingsFormScope<TeamGateSection>) {}

  getSnapshot(): SettingsFormScopeSnapshot<Record<string, unknown>> {
    const snapshot = this.section.getSnapshot()
    return {
      status: snapshot.status,
      value: flatten(snapshot.value),
      base: flatten(snapshot.base),
      user: flatten(snapshot.user),
      writable: snapshot.writable,
      revision: snapshot.revision,
    }
  }

  subscribe(listener: () => void): () => void {
    return this.section.subscribe(listener)
  }

  mutate(ops: readonly SettingsFormPathOp[], expectedRevision?: number): Promise<boolean> {
    return this.section.mutate(ops.map(op => locate(op)), expectedRevision)
  }
}

/** Everything the page renders about the form, in one replaceable value. */
export interface TeamContextGateSnapshot {
  /** Availability, writability, and what a save would do. */
  readonly shell: SettingsFormShell
  /** One state per control this page owns. */
  readonly fields: Readonly<Record<TeamGateField, SettingsFieldState>>
}

/** The model's change subscription, which the page reads through `useSyncExternalStore`. */
interface TeamGateStore {
  getSnapshot(): TeamContextGateSnapshot
  subscribe(listener: () => void): () => void
}

export class TeamContextGateForm {
  private readonly model: SettingsFormModel<Record<string, unknown>>
  private readonly scope: TeamGateScope
  private readonly store: TeamGateStore

  /**
   * @param section - the Team row's configuration form, as the settings provider serves it.
   * @param judge - the status projection a landed write re-reads.
   */
  constructor(
    private readonly section: SettingsFormScope<TeamGateSection>,
    private readonly judge: TeamContextJudgeCheck,
  ) {
    this.scope = new TeamGateScope(section)
    this.model = new SettingsFormModel<Record<string, unknown>>(this.scope, [
      settingsTextField('apiBase'),
      settingsTextField('model'),
      settingsTextField('apiKeyEnv'),
      settingsNumberField('tokens'),
      settingsNumberField('idleMs'),
      settingsNumberField('judgeTimeoutMs'),
    ], [{
      field: 'apiKey',
      // The literal never rides a response, so a draft is only ever what the
      // reader typed; the write addresses the real path directly.
      write: text => section.mutate([{ op: 'set', path: [...FIELD_PATHS.apiKey], value: text }]),
    }])
    // The model publishes a projection on every scope change or staged edit;
    // binding one is how this page observes it.
    this.store = this.model.bind(() => this.project())
  }

  /** The form state the page renders. */
  readonly getSnapshot = (): TeamContextGateSnapshot => this.store.getSnapshot()

  /** Observe the form state. */
  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /** Stage a draft, reset a field, save every staged edit, or discard them. */
  actions(): SettingsFormActions {
    return { ...this.model.actions(), save: () => { void this.save() } }
  }

  /**
   * Remove the stored key literal: the judge unmounts and the status re-reads.
   *
   * Deliberately its own write rather than a staged edit — the shared form
   * model has no clear for a write-only control, and an empty draft must keep
   * the stored literal instead of clearing it. The page only offers this while
   * no draft is staged, because a write moves the document revision the staged
   * save is fenced to.
   * @returns whether the Host accepted the clear.
   */
  async clearKey(): Promise<boolean> {
    let landed: boolean
    try {
      landed = await this.section.mutate([{ op: 'unset', path: [...FIELD_PATHS.apiKey] }])
    } catch {
      return false
    }
    if (!landed) return false
    await this.judge.refresh()
    return true
  }

  dispose(): void {
    this.model.dispose()
  }

  /** Build the page's state from the model's reads and drafts. */
  private project(): TeamContextGateSnapshot {
    const fields = {} as Record<TeamGateField, SettingsFieldState>
    for (const field of Object.keys(FIELD_PATHS) as TeamGateField[]) fields[field] = this.model.field(field)
    return { shell: this.model.shell(), fields }
  }

  /** Write every staged edit, then re-read the status the Host now serves. */
  async save(): Promise<void> {
    await this.model.save()
    if (!this.model.shell().failed) await this.judge.refresh()
  }
}
