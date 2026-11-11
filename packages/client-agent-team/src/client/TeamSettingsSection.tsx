import { useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconChevronDownOutlineRegular, Input, SettingsForm, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { HUMAN_AVATAR_MAX_BYTES } from '@contexera/dsh-agent-team/human-settings'
import {
  useHumanIdentity,
  type TeamHumanIdentityFace,
  type TeamHumanProfileActionOutcome,
} from './human-identity.ts'
import { EnvironmentCheck } from './EnvironmentCheck.tsx'
import type { TeamEnvironmentSource } from './environment-check.ts'
import { formLabels } from './locales.ts'
import { WORKER_ENGINES } from '@contexera/dsh-agent-team/worker-settings'
import { useTeamConfig, useWorkerConfig, type TeamConfigFace, type WorkerConfigFace } from './team-config.ts'
import { useAvatarImage } from './avatar-image.ts'
import { identityInitial } from './team-formatters.ts'
import { WORKER_ENGINE_COPY, workerEngineName } from './worker-copy.ts'
import css from './team-settings.module.css'

/** The Team's settings page: identity, the Host row's two configuration groups, the local environment check, and the version footnote. It owns no durable fact and no copy of one — identity writes through the Team Remote, both groups through the shared configuration form — and a failed write keeps the typed value and reports the Host's reason. */

export interface TeamSettingsInjected {
  /** The shared Human identity projection: profile facts plus post-write refresh. */
  identity: TeamHumanIdentityFace
  /** Persist one renamed display name; the failure message when the Host refuses it. */
  saveName: (name: string) => Promise<TeamHumanProfileActionOutcome>
  /** Upload one image file, persist its reference; the failure message when it does not stick. */
  uploadAvatar: (file: File) => Promise<TeamHumanProfileActionOutcome>
  removeAvatar: () => Promise<TeamHumanProfileActionOutcome>
  environment: TeamEnvironmentSource
  /** The Host row's compaction threshold; absent when the settings service is. */
  teamConfig?: TeamConfigFace | undefined
  /** The Host row's Worker delegation group; absent when the settings service is. */
  workerConfig?: WorkerConfigFace | undefined
}

export type TeamSettingsProps =
  & PropsRuntime<'settings.section'>
  & PropsLocale<'team'>
  & TeamSettingsInjected

/** A local file-read failure is a refusal; Remote uncertainty is classified by the shared writer. */
async function outcomeOf(action: () => Promise<TeamHumanProfileActionOutcome>): Promise<TeamHumanProfileActionOutcome> {
  try {
    return await action()
  } catch (error) {
    return { kind: 'rejected', message: error instanceof Error ? error.message : String(error) }
  }
}

interface SettingsNotice {
  readonly message: string
  readonly tone: 'error' | 'saved'
  readonly reread: boolean
}

function avatarInitial(name: string | undefined): string {
  return identityInitial((name ?? '').trim()) || 'H'
}

/** `follow` re-syncs the field when the profile changes underneath, without clobbering an in-progress edit. */
type NameDraft =
  | { readonly kind: 'follow' }
  | { readonly kind: 'editing'; readonly text: string }

/**
 * The Host row's compaction group, staged by the shared settings form.
 *
 * It is a group of its own rather than a row in the identity list: its save is
 * a settings-document write with its own revision fence, while the rows above
 * write through the Team Remote. Two saves in one form would make one button
 * two different transactions.
 * @param props - the page's locale reader and the configuration group's face.
 * @returns the group's heading, its one field, and its save.
 */
function ContextSettings(props: { t: TeamSettingsProps['t']; face: TeamConfigFace }) {
  const { t, face } = props
  const state = useTeamConfig(face)
  const headingId = useId()
  return <section className={css.context} aria-labelledby={headingId}>
    <h3 className={css.groupHeading} id={headingId}>{t('memberCompactionTitle')}</h3>
    <SettingsForm labels={formLabels(t)} state={state} onSave={face.save} onDiscard={face.discard}>
      <div className={css.fieldStack}>
        <SettingsValueField
          id="plugin-config-team-member-compaction-tokens"
          label={t('memberCompactionTokens')}
          hint={t('memberCompactionTokenHint')}
          placeholder="256K"
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('memberCompactionTokenInvalid')}
          numeric
          disabled={!state.writable || state.saving}
          {...state.tokens}
          onEdit={(text) => { face.edit('tokens', text) }}
          onReset={() => { face.resetField('tokens') }}
        />
      </div>
    </SettingsForm>
  </section>
}

/**
 * One labelled control in a settings group, in the shipped field's rhythm, for
 * what that field does not cover: a native select and a typed path. The hint is
 * the control's description, so the guidance is read with the field.
 * @param props - the field's copy, the control's id, and the control itself.
 * @returns the labelled field.
 */
function Field(props: {
  id: string
  label: string
  hint: ReactNode
  render: (describedBy: string) => ReactNode
}) {
  const hintId = `${props.id}-hint`
  return <div className={css.field}>
    <label className={css.fieldLabel} htmlFor={props.id}>{props.label}</label>
    {props.render(hintId)}
    <p className={css.fieldHint} id={hintId}>{props.hint}</p>
  </div>
}

/**
 * The Host row's Worker group. It is a disclosure rather than an open block: the
 * group is opt-in, so a closed row states what it is set to in one phrase and
 * costs one line of the page. Open, the hierarchy is the panel inside it — the
 * switch, then the engines as one nested surface — so no rule is needed to
 * separate a level from the level it contains.
 * @param props - the page's locale reader and the Worker group's face.
 * @returns the group's summary row and, open, its switches and fields.
 */
function WorkerSettings(props: { t: TeamSettingsProps['t']; face: WorkerConfigFace }) {
  const { t, face } = props
  const state = useWorkerConfig(face)
  const headingId = useId()
  const bodyId = useId()
  const prefix = useId()
  const [open, setOpen] = useState(false)
  const on = state.enabled.text === 'true'
  const locked = !state.writable || state.saving
  const engineLocked = locked || !on
  const defaultEngine = state.defaultEngine.text
  // A row whose default engine is off refuses every delegation that names none.
  const defaultEngineOff = (defaultEngine === 'codex' ? state.codexEnabled : state.claudeEnabled).text !== 'true'
  const enabled = WORKER_ENGINES.filter(engine => (engine === 'codex' ? state.codexEnabled : state.claudeEnabled).text === 'true')
  const summary = !on
    ? t('workerCollapsedOff')
    : enabled.length === 0
      ? t('workerCollapsedOnNoEngine')
      : t('workerCollapsedOnEngines', { engines: enabled.map(engine => workerEngineName(t, engine)).join(' · ') })
  return <section className={css.worker} aria-labelledby={headingId} data-worker-settings>
    <button type="button" className={css.workerToggle} aria-expanded={open} aria-controls={bodyId}
      onClick={() => { setOpen(value => !value) }}>
      <span className={css.groupHeading} id={headingId}>{t('workerTitle')}</span>
      <span className={css.workerToggleSummary}>{summary}</span>
      <span className={`${css.chevron} ${open ? css.chevronOpen : ''}`} aria-hidden><IconChevronDownOutlineRegular /></span>
    </button>
    <div id={bodyId} hidden={!open} className={css.workerBody}>
      <p className={css.groupIntro}>{t('workerIntro')}</p>
      <SettingsForm labels={formLabels(t)} state={state} onSave={face.save} onDiscard={face.discard}>
        <div className={css.workerFields}>
          <div className={css.row}>
            <div className={css.rowText}>
              <div className={css.title}>{t('workerEnabled')}</div>
              <div className={css.desc}>{t('workerEnabledHint')}</div>
            </div>
            <div className={css.controls}>
              <Switch
                checked={on}
                label={t('workerEnabled')}
                disabled={locked}
                onChange={(next) => { face.setSwitch('enabled', next) }}
              />
            </div>
          </div>
          <div className={css.enginePanel}>
            <div className={css.defaultEngine}>
              <label className={css.fieldLabel} htmlFor={`${prefix}-default-engine`}>{t('workerDefaultEngine')}</label>
              <select
                id={`${prefix}-default-engine`}
                className={`${css.control} ${css.select}`}
                value={defaultEngine}
                aria-describedby={defaultEngineOff ? `${prefix}-default-engine-note` : undefined}
                disabled={engineLocked}
                onChange={(event) => { face.edit('defaultEngine', event.target.value) }}
              >
                {WORKER_ENGINES.map(engine => <option key={engine} value={engine}>{workerEngineName(t, engine)}</option>)}
              </select>
              {!defaultEngineOff ? null : <p className={css.defaultEngineNote} id={`${prefix}-default-engine-note`}>
                {t('workerDefaultEngineUnavailable')}
              </p>}
            </div>
            {WORKER_ENGINES.map((engine) => {
              const name = workerEngineName(t, engine)
              const pathId = `${prefix}-${engine}-path`
              const isCodex = engine === 'codex'
              return <div className={css.engine} key={engine} data-worker-engine={engine}>
                <div className={css.engineHead}>
                  <span className={css.engineName}>{name}</span>
                  <Switch
                    checked={(isCodex ? state.codexEnabled : state.claudeEnabled).text === 'true'}
                    label={t('workerEngineSwitch', { engine: name })}
                    disabled={engineLocked}
                    onChange={(next) => { face.setSwitch(isCodex ? 'codexEnabled' : 'claudeEnabled', next) }}
                  />
                </div>
                <Field
                  id={pathId}
                  label={t('workerExecutable')}
                  hint={t('workerExecutableHint', { command: WORKER_ENGINE_COPY[engine].command })}
                  render={describedBy => <input
                    id={pathId}
                    className={css.control}
                    value={(isCodex ? state.codexExecutable : state.claudeExecutable).text}
                    // Both engines label this field the same way, so the engine is
                    // what tells a screen reader which path it is on.
                    aria-label={t('workerExecutableFor', { engine: name })}
                    aria-describedby={describedBy}
                    placeholder={t('workerExecutablePlaceholder', { command: WORKER_ENGINE_COPY[engine].command })}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={engineLocked}
                    onChange={(event) => { face.edit(isCodex ? 'codexExecutable' : 'claudeExecutable', event.target.value) }}
                  />}
                />
              </div>
            })}
          </div>
        </div>
      </SettingsForm>
    </div>
  </section>
}

export function TeamSettingsSection(props: TeamSettingsProps) {
  const { t, identity } = props
  const profile = useHumanIdentity(identity)
  const [draft, setDraft] = useState<NameDraft>({ kind: 'follow' })
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [rereading, setRereading] = useState(false)
  const [notice, setNotice] = useState<SettingsNotice | null>(null)
  const filePicker = useRef<HTMLInputElement | null>(null)

  const name = draft.kind === 'editing' ? draft.text : profile.name ?? ''
  const dirty = draft.kind === 'editing' && draft.text.trim() !== (profile.name ?? '')
  const emptyName = draft.kind === 'editing' && draft.text.trim() === ''
  const hasAvatar = profile.avatarRef !== undefined
  const avatar = useAvatarImage(profile.avatarUrl)
  const writesAvailable = profile.settingsFence !== undefined
  const writesBlocked = notice?.reread === true

  const report = (outcome: TeamHumanProfileActionOutcome, rejected: (message: string) => string): void => {
    if (outcome === undefined) {
      setNotice(null)
      return
    }
    if (outcome.kind === 'saved') {
      setNotice({ message: t('humanSettingsSavedRefreshFailed', { message: outcome.warning }), tone: 'saved', reread: true })
      return
    }
    if (outcome.kind === 'conflict') {
      setNotice({ message: t('humanSettingsProfileConflict'), tone: 'error', reread: true })
      return
    }
    if (outcome.kind === 'uncertain') {
      setNotice({ message: t('humanSettingsResultUnconfirmed', { message: outcome.message }), tone: 'error', reread: true })
      return
    }
    setNotice({ message: rejected(outcome.message), tone: 'error', reread: false })
  }

  const rereadProfile = async (): Promise<void> => {
    setRereading(true)
    await identity.refreshAfterWrite()
    setRereading(false)
    const error = identity.getSnapshot().error
    setNotice(error === undefined ? null : {
      message: t('humanSettingsRereadFailed', { message: error }), tone: 'error', reread: true,
    })
  }

  const submitName = async (): Promise<void> => {
    if (!dirty || emptyName || saving || writesBlocked || !writesAvailable) return
    setSaving(true)
    setNotice(null)
    const outcome = await outcomeOf(() => props.saveName(name.trim()))
    setSaving(false)
    report(outcome, message => t('humanSettingsNameFailed', { message }))
    if (outcome === undefined) setDraft({ kind: 'follow' })
  }

  const pickAvatar = async (file: File | undefined): Promise<void> => {
    if (file === undefined || writesBlocked || !writesAvailable) return
    setNotice(null)
    if (!file.type.startsWith('image/')) {
      setNotice({ message: t('humanSettingsAvatarNotImage'), tone: 'error', reread: false })
      return
    }
    if (file.size > HUMAN_AVATAR_MAX_BYTES) {
      setNotice({ message: t('humanSettingsAvatarTooLarge'), tone: 'error', reread: false })
      return
    }
    setUploading(true)
    const outcome = await outcomeOf(() => props.uploadAvatar(file))
    setUploading(false)
    report(outcome, message => t('humanSettingsAvatarFailed', { message }))
  }

  const removeAvatar = async (): Promise<void> => {
    if (removing || writesBlocked || !writesAvailable) return
    setNotice(null)
    setRemoving(true)
    const outcome = await outcomeOf(() => props.removeAvatar())
    setRemoving(false)
    report(outcome, message => t('humanSettingsAvatarFailed', { message }))
  }

  // Every state, including a failed read, must say whose Team this is and where a change applies.
  const pageHeader = <>
    <h2 className={css.heading}>{t('teamSettingsTitle')}</h2>
    <p className={css.intro}>{t('teamSettingsIntro')}</p>
  </>

  if (profile.status === 'loading' && profile.name === undefined) {
    return <div className={css.section}>
      {pageHeader}
      <p className={css.state} role="status">{t('humanSettingsLoading')}</p>
    </div>
  }

  if (profile.name === undefined) {
    return <div className={css.section}>
      {pageHeader}
      <p className={css.state} role="alert">{t('humanSettingsUnavailable', { message: profile.error ?? '' })}</p>
      <div className={css.stateAction}>
        <Button variant="outline" onClick={() => { void identity.refresh() }}>{t('retry')}</Button>
      </div>
    </div>
  }

  return <div className={css.section}>
    {pageHeader}
    <div className={css.rows}>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.title}>{t('humanSettingsName')}</div>
          <div className={css.desc}>{t('humanSettingsNameHint')}</div>
        </div>
        <form
          className={css.controls}
          onSubmit={(event) => {
            event.preventDefault()
            void submitName()
          }}
        >
          <Input
            className={css.nameInput!}
            aria-label={t('humanSettingsName')}
            aria-invalid={emptyName || undefined}
            value={name}
            disabled={saving || rereading || writesBlocked}
            onChange={(event) => { setDraft({ kind: 'editing', text: event.target.value }) }}
          />
          <Button type="submit" variant="primary" disabled={saving || rereading || writesBlocked || !writesAvailable || !dirty || emptyName}>
            {saving ? t('humanSettingsSaving') : t('humanSettingsSave')}
          </Button>
        </form>
      </div>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.title}>{t('humanSettingsAvatar')}</div>
          <div className={css.desc}>{t('humanSettingsAvatarHint')}</div>
        </div>
        <div className={css.controls}>
          {avatar.image.kind === 'initial'
            ? <span className={`${css.identity} ${css.identityFallback}`} data-avatar="initial" aria-hidden="true">{avatarInitial(profile.name)}</span>
            : <img className={`${css.identity} ${css.identityImage}`} data-avatar="image" src={avatar.image.src} alt="" onError={avatar.failed} />}
          <input
            ref={filePicker}
            type="file"
            accept="image/*"
            tabIndex={-1}
            aria-hidden="true"
            hidden
            onChange={(event) => {
              void pickAvatar(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <Button
            variant="outline"
            disabled={uploading || removing || rereading || writesBlocked || !writesAvailable}
            onClick={() => { filePicker.current?.click() }}
          >
            {uploading ? t('humanSettingsUploading') : hasAvatar ? t('humanSettingsReplace') : t('humanSettingsUpload')}
          </Button>
          {hasAvatar && <Button disabled={uploading || removing || rereading || writesBlocked || !writesAvailable} onClick={() => { void removeAvatar() }}>{removing ? t('humanSettingsRemovingAvatar') : t('humanSettingsRemoveAvatar')}</Button>}
        </div>
      </div>
    </div>
    {emptyName && <p className={css.notice}>{t('humanSettingsNameEmpty')}</p>}
    {notice === null ? null : <div className={`${css.notice} ${notice.tone === 'saved' ? css.noticeSaved : ''}`} role={notice.tone === 'saved' ? 'status' : 'alert'}>
      <span>{notice.message}</span>
      {notice.reread && <Button variant="outline" disabled={rereading} onClick={() => { void rereadProfile() }}>
        {rereading ? t('humanSettingsRereading') : t('humanSettingsReread')}
      </Button>}
    </div>}
    {props.teamConfig === undefined ? null : <ContextSettings t={t} face={props.teamConfig} />}
    {props.workerConfig === undefined ? null : <WorkerSettings t={t} face={props.workerConfig} />}
    <div className={css.environment}>
      <EnvironmentCheck t={t} environment={props.environment} />
    </div>
    <div className={css.footnote}>
      <span>{t('humanSettingsVersion', { version: profile.version ?? '' })}</span>
      <span aria-hidden="true">·</span>
      <a className={css.link} href={profile.repoUrl ?? ''} target="_blank" rel="noreferrer">GitHub</a>
      {profile.latestVersion !== undefined
        ? <a
            className={css.link}
            href={`${profile.repoUrl ?? ''}/releases`}
            target="_blank"
            rel="noreferrer"
          >{t('humanSettingsUpdateAvailable', { version: profile.latestVersion })}</a>
        : null}
    </div>
  </div>
}
