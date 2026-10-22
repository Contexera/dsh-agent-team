/**
 * The Team settings page's configuration group: the Host row's compaction
 * threshold, staged as one text field.
 *
 * The shared settings form addresses top-level section fields only, while the
 * threshold lives inside the row's `memberCompaction` group. The scope below
 * flattens that group for the form and maps its single-field edits back onto
 * child paths, so a save never restates the sibling `enabled` switch.
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
import { formatCapacity, parseCapacity } from './capacity.ts'

/** The Host row fields this form reads. */
export interface TeamConfigSection {
  memberCompaction?: { tokens?: number | undefined } | undefined
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
export function teamConfigScope(form: ConfigForm<TeamConfigSection>): SettingsFormScope<TeamConfigValues> {
  return {
    getSnapshot: () => flatten(form.getSnapshot()),
    subscribe: listener => form.subscribe(listener),
    mutate: (ops, expectedRevision) => form.mutate(ops.map(sectionOp), expectedRevision),
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
