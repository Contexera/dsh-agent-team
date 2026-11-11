/**
 * Team settings' profile-wide extra tool-name editor.
 *
 * The Host settings document is the durable authority. This controller owns
 * only the browser draft, the discovered-name catalog, and the UI's distinction
 * between a stale revision and a rejected write.
 * @module @contexera/dsh-agent-team/client/extra-tool-grants
 */

import { useSyncExternalStore } from 'react'
import type {
  SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamToolCatalogResult } from '@contexera/dsh-agent-team/types'
import {
  EXTRA_TOOL_GRANTS_FIELD, extraToolGrantsFrom, sanitizeExtraToolGrants,
} from '@contexera/dsh-agent-team/member-tool-grants'

/** The settings Remote methods this editor uses directly, without ConfigForm's lossy boolean. */
export interface ExtraToolGrantsSettings {
  describe(): Promise<RemoteResult<SettingsDescribeValue>>
  mutate(
    namespace: string,
    ops: readonly SettingsPathOpView[],
    expectedRevision: number | undefined,
  ): Promise<RemoteResult<SettingsNamespaceView>>
}

/** The public Host discovery read; it is not a per-Member filtered view. */
export interface ExtraToolCatalog {
  load(): Promise<RemoteResult<AgentTeamToolCatalogResult>>
}

export interface ExtraToolGrantsDeps {
  readonly namespace: string
  readonly settings: ExtraToolGrantsSettings
  readonly catalog: ExtraToolCatalog
}

export type ExtraToolListStatus = 'loading' | 'ready' | 'error'
export type ExtraToolCatalogStatus = 'loading' | 'ready' | 'error'

export type ExtraToolNotice =
  | { readonly kind: 'saved' }
  | { readonly kind: 'rejected'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string }
  | {
    readonly kind: 'conflict'
    readonly message: string
    readonly expected: number
    readonly actual: number
    readonly latestCommitted?: readonly string[] | undefined
    readonly reloadFailure?: string | undefined
  }

export interface ExtraToolGrantsState {
  readonly listStatus: ExtraToolListStatus
  readonly listError?: string | undefined
  readonly catalogStatus: ExtraToolCatalogStatus
  readonly catalogError?: string | undefined
  readonly catalog: readonly string[]
  readonly committed: readonly string[]
  readonly draft: readonly string[]
  readonly missing: readonly string[]
  readonly writable: boolean
  readonly revision?: number | undefined
  readonly search: string
  readonly dirty: boolean
  readonly canSave: boolean
  readonly canDiscard: boolean
  readonly saving: boolean
  readonly awaitingReview: boolean
  readonly notice?: ExtraToolNotice | undefined
}

export interface ExtraToolGrantsFace {
  getSnapshot(): ExtraToolGrantsState
  subscribe(listener: () => void): () => void
  load(): void
  loadCatalog(): void
  setSearch(text: string): void
  toggle(name: string): void
  clear(): void
  discard(): void
  save(): void
  acknowledgeConflict(): void
}

type MutableState = { -readonly [K in keyof ExtraToolGrantsState]: ExtraToolGrantsState[K] }

const INITIAL: ExtraToolGrantsState = Object.freeze({
  listStatus: 'loading',
  catalogStatus: 'loading',
  catalog: Object.freeze([]),
  committed: Object.freeze([]),
  draft: Object.freeze([]),
  missing: Object.freeze([]),
  writable: false,
  search: '',
  dirty: false,
  canSave: false,
  canDiscard: false,
  saving: false,
  awaitingReview: false,
})

interface AcceptedList {
  readonly writable: boolean
  readonly revision: number
  readonly names: readonly string[]
}

/** Read one plain record without accepting arrays as a settings section. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failureCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((name, index) => name === right[index])
}

function missingNames(draft: readonly string[], catalog: readonly string[]): readonly string[] {
  const known = new Set(catalog)
  return Object.freeze(draft.filter(name => !known.has(name)))
}

function decodedNames(view: SettingsNamespaceView): readonly string[] | undefined {
  return extraToolGrantsFrom(recordOf(view.value)?.[EXTRA_TOOL_GRANTS_FIELD])
}

function derived(state: ExtraToolGrantsState): ExtraToolGrantsState {
  const draft = [...state.draft].sort()
  const committed = [...state.committed].sort()
  const dirty = !sameNames(draft, committed)
  return {
    ...state,
    draft: Object.freeze(draft),
    committed: Object.freeze(committed),
    missing: missingNames(draft, state.catalog),
    dirty,
    canSave: state.listStatus === 'ready'
      && state.writable
      && state.revision !== undefined
      && !state.saving
      && !state.awaitingReview
      && dirty,
    canDiscard: state.listStatus === 'ready'
      && !state.saving
      && dirty
      && (!state.awaitingReview || (state.notice?.kind === 'conflict' && state.notice.latestCommitted !== undefined)),
  }
}

/**
 * Stage the draft independently from the accepted list. A failed list read is
 * never materialized as an empty saved value, and a conflict keeps both sides
 * visible until the Human explicitly acknowledges the latest revision.
 */
export class ExtraToolGrantsController implements ExtraToolGrantsFace {
  private readonly store: SnapshotStore<MutableState>
  private loadGeneration = 0
  private catalogGeneration = 0

  constructor(private readonly deps: ExtraToolGrantsDeps) {
    this.store = createSnapshotStore(INITIAL as MutableState, { flush: 'sync' })
  }

  readonly getSnapshot = (): ExtraToolGrantsState => this.store.getSnapshot()

  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /** Read the accepted list. Called once at mount and explicitly on retry. */
  readonly load = (): void => {
    const state = this.getSnapshot()
    if (state.saving) return
    const generation = ++this.loadGeneration
    this.store.set(derived({
      ...state,
      listStatus: 'loading',
      listError: undefined,
      notice: state.awaitingReview ? state.notice : undefined,
    }))
    void this.readAccepted().then(
      accepted => {
        if (generation !== this.loadGeneration) return
        this.acceptList(accepted)
      },
      (error: unknown) => {
        if (generation !== this.loadGeneration) return
        this.store.set(derived({
          ...this.getSnapshot(),
          listStatus: 'error',
          listError: messageOf(error),
          writable: false,
          revision: undefined,
        }))
      },
    )
  }

  /** Read the discovery names independently of settings and Human identity. */
  readonly loadCatalog = (): void => {
    const generation = ++this.catalogGeneration
    this.store.update((draft) => {
      draft.catalogStatus = 'loading'
      draft.catalogError = undefined
    })
    void this.deps.catalog.load().then(
      (response) => {
        if (generation !== this.catalogGeneration) return
        if (!response.ok) {
          this.store.update((draft) => {
            draft.catalogStatus = 'error'
            draft.catalogError = response.error.message
          })
          return
        }
        const catalog = Object.freeze([...new Set(response.value.names)].sort())
        this.store.set(derived({
          ...this.getSnapshot(),
          catalogStatus: 'ready',
          catalogError: undefined,
          catalog,
        }))
      },
      (error: unknown) => {
        if (generation !== this.catalogGeneration) return
        this.store.update((draft) => {
          draft.catalogStatus = 'error'
          draft.catalogError = messageOf(error)
        })
      },
    )
  }

  readonly setSearch = (text: string): void => {
    this.store.update((draft) => { draft.search = text })
  }

  readonly toggle = (name: string): void => {
    const state = this.getSnapshot()
    if (state.listStatus !== 'ready' || !state.writable || state.saving || state.awaitingReview) return
    const selected = new Set(state.draft)
    if (selected.has(name)) selected.delete(name)
    else selected.add(name)
    this.store.set(derived({
      ...state,
      draft: Object.freeze([...selected].sort()),
      notice: undefined,
    }))
  }

  readonly clear = (): void => {
    const state = this.getSnapshot()
    if (state.listStatus !== 'ready' || !state.writable || state.saving || state.awaitingReview) return
    this.store.set(derived({ ...state, draft: Object.freeze([]), notice: undefined }))
  }

  readonly discard = (): void => {
    const state = this.getSnapshot()
    if (!state.canDiscard) return
    this.store.set(derived({
      ...state,
      draft: Object.freeze([...state.committed]),
      awaitingReview: false,
      notice: undefined,
    }))
  }

  readonly acknowledgeConflict = (): void => {
    const state = this.getSnapshot()
    if (!state.awaitingReview || state.revision === undefined || state.listStatus !== 'ready'
      || state.notice?.kind !== 'conflict' || state.notice.latestCommitted === undefined) return
    this.store.set(derived({
      ...state,
      awaitingReview: false,
      notice: undefined,
    }))
  }

  readonly save = (): void => {
    const state = this.getSnapshot()
    if (!state.canSave || state.revision === undefined) return
    const expectedRevision = state.revision
    const names = sanitizeExtraToolGrants(state.draft)
    this.store.set(derived({ ...state, saving: true, notice: undefined }))
    void this.deps.settings.mutate(
      this.deps.namespace,
      [{ op: 'set', path: [EXTRA_TOOL_GRANTS_FIELD], value: [...names] }],
      expectedRevision,
    ).then(
      (response) => {
        if (!response.ok) {
          if (response.error.code === 'settings/conflict') {
            void this.recoverConflict(response.error.message, expectedRevision, response.error.details)
            return
          }
          this.store.set(derived({
            ...this.getSnapshot(),
            saving: false,
            notice: response.error.code === 'settings/rejected'
              ? { kind: 'rejected', message: response.error.message }
              : { kind: 'failed', message: response.error.message },
          }))
          return
        }
        const accepted = decodedNames(response.value)
        if (accepted === undefined) {
          this.store.set(derived({
            ...this.getSnapshot(),
            listStatus: 'error',
            listError: `the saved profile setting '${EXTRA_TOOL_GRANTS_FIELD}' is not a readable tool-name list`,
            revision: undefined,
            saving: false,
          }))
          return
        }
        this.store.set(derived({
          ...this.getSnapshot(),
          listStatus: 'ready',
          listError: undefined,
          writable: this.getSnapshot().writable,
          revision: response.value.revision,
          committed: accepted,
          draft: accepted,
          saving: false,
          awaitingReview: false,
          notice: { kind: 'saved' },
        }))
      },
      (error: unknown) => {
        this.store.set(derived({
          ...this.getSnapshot(),
          saving: false,
          notice: {
            kind: failureCodeOf(error) === 'settings/rejected' ? 'rejected' : 'failed',
            message: messageOf(error),
          },
        }))
      },
    )
  }

  private async recoverConflict(
    message: string,
    expected: number,
    details: unknown,
  ): Promise<void> {
    const generation = ++this.loadGeneration
    const actual = typeof details === 'object' && details !== null && typeof Reflect.get(details, 'actual') === 'number'
      ? Reflect.get(details, 'actual') as number
      : expected
    this.store.set(derived({
      ...this.getSnapshot(),
      saving: false,
      awaitingReview: true,
      notice: { kind: 'conflict', message, expected, actual },
    }))
    try {
      const accepted = await this.readAccepted()
      if (generation !== this.loadGeneration) return
      this.store.set(derived({
        ...this.getSnapshot(),
        listStatus: 'ready',
        listError: undefined,
        writable: accepted.writable,
        revision: accepted.revision,
        committed: accepted.names,
        notice: {
          kind: 'conflict',
          message,
          expected,
          actual: accepted.revision,
          latestCommitted: accepted.names,
        },
      }))
    } catch (error) {
      if (generation !== this.loadGeneration) return
      this.store.set(derived({
        ...this.getSnapshot(),
        listStatus: 'error',
        listError: messageOf(error),
        revision: undefined,
        notice: {
          kind: 'conflict',
          message,
          expected,
          actual,
          reloadFailure: messageOf(error),
        },
      }))
    }
  }

  private async readAccepted(): Promise<AcceptedList> {
    const response = await this.deps.settings.describe()
    if (!response.ok) throw new Error(response.error.message)
    const view = response.value.namespaces.find(candidate => candidate.ns === this.deps.namespace)
    if (view === undefined) throw new Error(`the profile settings namespace '${this.deps.namespace}' is absent`)
    const names = decodedNames(view)
    if (names === undefined) {
      throw new Error(`the profile setting '${EXTRA_TOOL_GRANTS_FIELD}' is not a readable tool-name list`)
    }
    return Object.freeze({
      writable: response.value.writable,
      revision: view.revision,
      names: Object.freeze([...names].sort()),
    })
  }

  private acceptList(accepted: AcceptedList): void {
    const state = this.getSnapshot()
    const conflict = state.awaitingReview && state.notice?.kind === 'conflict' ? state.notice : undefined
    this.store.set(derived({
      ...state,
      listStatus: 'ready',
      listError: undefined,
      writable: accepted.writable,
      revision: accepted.revision,
      committed: accepted.names,
      // A conflict retry re-reads the committed side only. The Human's draft is
      // still the thing they must compare, so never replace it with the winner.
      draft: conflict === undefined ? accepted.names : state.draft,
      saving: false,
      awaitingReview: conflict !== undefined,
      notice: conflict === undefined ? undefined : {
        kind: 'conflict',
        message: conflict.message,
        expected: conflict.expected,
        actual: accepted.revision,
        latestCommitted: accepted.names,
      },
    }))
  }
}

/** Subscribe one settings section to the editor's draft and results. */
export function useExtraToolGrants(face: ExtraToolGrantsFace): ExtraToolGrantsState {
  return useSyncExternalStore(face.subscribe, face.getSnapshot, face.getSnapshot)
}
