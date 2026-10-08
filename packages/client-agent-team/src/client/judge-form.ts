import {
  SettingsFormModel, settingsTextField, type SettingsFieldSpec,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormPathOp, type SettingsFormScope,
  type SettingsFormScopeSnapshot, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamContextJudgeCheck } from './context-judge.ts'

/**
 * The Team settings page's staged form over the judge's endpoint.
 *
 * The page edits one group of the Team row's settings section: the `jev`
 * endpoint the relatedness judge is mounted from. The identity fields that
 * share that section belong to the Human profile rows and are never rendered
 * here, so this form reaches its values through a projection — the shared form
 * model addresses one flat section, and the adapter below maps each control to
 * the path it really lives at.
 *
 * The key literal is the one control that is not read back: the Host redacts
 * it, so its draft starts blank on every load, a blank draft writes nothing,
 * and removing a stored literal is an explicit clear rather than an empty
 * string.
 */

/** The group inside the Team row's settings section that this form edits. */
const JUDGE_GROUP = 'jev'

/** Where each control's value lives inside the Team row's settings section. */
const FIELD_PATHS = {
  apiBase: [JUDGE_GROUP, 'apiBase'],
  model: [JUDGE_GROUP, 'model'],
  apiKey: [JUDGE_GROUP, 'apiKey'],
  // The reply switch is a row-level setting, not part of the judge's group:
  // it decides a collaboration affordance, not an endpoint.
  replyEnabled: ['replyEnabled'],
} as const

/**
 * The reply switch as the staged form sees it. The stored value is a boolean
 * while the model stages text, so this maps between the two; an absent value
 * means the Host default, which is on.
 */
const REPLY_ENABLED_FIELD: SettingsFieldSpec = {
  field: 'replyEnabled',
  format: value => value === false ? 'off' : 'on',
  parse: text => ({ kind: 'set', value: text === 'on' }),
}

/** One control this page owns. */
export type TeamJudgeField = keyof typeof FIELD_PATHS

/** The group this form edits, as it sits inside the Team row's section. */
export interface TeamJudgeSection {
  /** The judge's endpoint configuration. */
  readonly jev?: unknown
}

/** Read the judge group of a section layer as a plain record. */
function groupOf(layer: unknown): Record<string, unknown> | undefined {
  if (layer === null || typeof layer !== 'object') return undefined
  const value = (layer as Record<string, unknown>)[JUDGE_GROUP]
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

/**
 * Project one section layer onto the controls this page renders. A control the
 * layer does not carry stays absent rather than becoming an empty string, which
 * is what the model reads to decide whether a field is overridden and what a
 * reset reverts to.
 * @param layer - a section, or one of its composition layers.
 * @returns the flat control values, or undefined when the layer carries none.
 */
function flatten(layer: unknown): Record<string, unknown> | undefined {
  if (layer === null || typeof layer !== 'object') return undefined
  const group = groupOf(layer)
  const flat: Record<string, unknown> = {}
  for (const [field, path] of Object.entries(FIELD_PATHS) as [TeamJudgeField, readonly string[]][]) {
    if (group !== undefined && Object.hasOwn(group, path[1]!)) flat[field] = group[path[1]!]
  }
  return flat
}

/** Address one control's edit at the path it really lives at. */
function locate(op: SettingsFormPathOp): SettingsFormPathOp {
  const path = FIELD_PATHS[op.path[0] as TeamJudgeField]
  return op.op === 'set'
    ? { op: 'set', path: [...path], value: op.value }
    : { op: 'unset', path: [...path] }
}

/** The shared form model's view of this page's controls, over the real section. */
class TeamJudgeScope implements SettingsFormScope<Record<string, unknown>> {
  constructor(private readonly section: SettingsFormScope<TeamJudgeSection>) {}

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
export interface TeamJudgeFormSnapshot {
  /** Availability, writability, and what a save would do. */
  readonly shell: SettingsFormShell
  /** One state per control this page owns. */
  readonly fields: Readonly<Record<TeamJudgeField, SettingsFieldState>>
}

/** The model's change subscription, which the page reads through `useSyncExternalStore`. */
interface TeamJudgeStore {
  getSnapshot(): TeamJudgeFormSnapshot
  subscribe(listener: () => void): () => void
}

export class TeamJudgeForm {
  private readonly model: SettingsFormModel<Record<string, unknown>>
  private readonly scope: TeamJudgeScope
  private readonly store: TeamJudgeStore

  /**
   * @param section - the Team row's configuration form, as the settings provider serves it.
   * @param judge - the status projection a landed write re-reads.
   */
  constructor(
    private readonly section: SettingsFormScope<TeamJudgeSection>,
    private readonly judge: TeamContextJudgeCheck,
  ) {
    this.scope = new TeamJudgeScope(section)
    this.model = new SettingsFormModel<Record<string, unknown>>(this.scope, [
      settingsTextField('apiBase'),
      settingsTextField('model'),
      REPLY_ENABLED_FIELD,
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
  readonly getSnapshot = (): TeamJudgeFormSnapshot => this.store.getSnapshot()

  /** Observe the form state. */
  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /** Stage a draft, reset a field, save every staged edit, or discard them. */
  actions(): SettingsFormActions {
    return { ...this.model.actions(), save: () => { void this.save() } }
  }

  /**
   * Turn quote-replies on or off.
   *
   * Written at once rather than staged, for the same reason `clearKey` is: a
   * switch that waits for a Save reads as broken, and the reply affordance is
   * gated on the Host's answer, which this write moves immediately.
   * @param enabled - whether the Team offers quote-replies.
   * @returns whether the Host accepted the write.
   */
  async setReplyEnabled(enabled: boolean): Promise<boolean> {
    try {
      return await this.section.mutate([{ op: 'set', path: [...FIELD_PATHS.replyEnabled], value: enabled }])
    } catch {
      return false
    }
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
  private project(): TeamJudgeFormSnapshot {
    const fields = {} as Record<TeamJudgeField, SettingsFieldState>
    for (const field of Object.keys(FIELD_PATHS) as TeamJudgeField[]) fields[field] = this.model.field(field)
    return { shell: this.model.shell(), fields }
  }

  /** Write every staged edit, then re-read the status the Host now serves. */
  async save(): Promise<void> {
    await this.model.save()
    if (!this.model.shell().failed) await this.judge.refresh()
  }
}

/** Read-side face the settings page binds for the endpoint form. */
export interface TeamJudgeFormSource {
  getSnapshot(): TeamJudgeForm | undefined
  subscribe(listener: () => void): () => void
}

/**
 * The form's seat on the page, as an observable rather than a value.
 *
 * The form exists only while this deployment serves a settings document, and
 * that service may arrive after the page's first render. A slot entry's
 * injected props are computed once and cached for the entry's lifetime, so a
 * value handed over at that moment would freeze the answer: the group would
 * never appear until a reload. The page therefore observes this seat, which
 * the service's arrival and departure both publish through.
 */
export class TeamJudgeFormSeat implements TeamJudgeFormSource {
  private form: TeamJudgeForm | undefined
  private readonly listeners = new Set<() => void>()

  readonly getSnapshot = (): TeamJudgeForm | undefined => this.form

  /**
   * Observe the form, without reading anything on subscribe: the seat carries
   * no remote state of its own, so a subscriber renders whatever is held now.
   * @param listener - invoked after every hold or release.
   * @returns the disposer removing this listener.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Publish the form the settings service answers with.
   * @param form - the form built over that service's section scope.
   */
  hold(form: TeamJudgeForm): void {
    this.form = form
    this.publish()
  }

  /**
   * Withdraw the form when its service goes away. Only the holder of the form
   * in place can withdraw it, so a replacement is never cleared by the
   * departure of the one it replaced.
   * @param form - the form this caller holds.
   */
  release(form: TeamJudgeForm): void {
    if (this.form !== form) return
    this.form = undefined
    this.publish()
  }

  dispose(): void {
    this.listeners.clear()
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
