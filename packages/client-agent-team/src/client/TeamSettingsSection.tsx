import { Fragment, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, Checkbox, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, Input,
  SettingsForm, SettingsSecretField, SettingsValueField, type SettingsFieldState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentTeamContextJudgeResult } from '@contexera/dsh-agent-team/types'
import { useHumanIdentity, type TeamHumanIdentityFace } from './human-identity.ts'
import type { TeamReplyCapabilitiesFace } from './reply-capabilities.ts'
import { EnvironmentCheck } from './EnvironmentCheck.tsx'
import type { TeamEnvironmentSource } from './environment-check.ts'
import { useAvatarImage } from './avatar-image.ts'
import { useContextJudge, type TeamContextJudgeSource } from './context-judge.ts'
import type { TeamJudgeField, TeamJudgeForm, TeamJudgeFormSource } from './judge-form.ts'
import css from './team-settings.module.css'

/**
 * The Team's settings page: the Human's display name and avatar, the endpoint
 * the relatedness judge calls, the local environment check, and the version
 * footnote.
 *
 * The page owns no durable fact and no copy of one, and it holds its two
 * writable groups apart because they are two different documents: identity
 * arrives from the shared identity projection and writes through the Team
 * Remote, while the judge's endpoint is one group of the Team row's settings
 * section and writes through the settings provider. Neither group renders the
 * other's fields, and a failed write in either keeps the typed value and
 * reports the reason it was refused.
 */

/** Host-side avatar ceiling (`ATTACHMENT_MAX_BYTES`): the settings page refuses larger files before the round trip. */
const AVATAR_MAX_BYTES = 10 * 1024 * 1024

export interface TeamSettingsInjected {
  /** The shared Human identity projection: profile facts plus post-write refresh. */
  identity: TeamHumanIdentityFace
  /** Persist one renamed display name; the failure message when the Host refuses it. */
  saveName: (name: string) => Promise<string | undefined>
  /** Upload one image file, persist its reference; the failure message when it does not stick. */
  uploadAvatar: (file: File) => Promise<string | undefined>
  /** Clear the avatar; the identity falls back to the initial. */
  removeAvatar: () => Promise<string | undefined>
  /** The local environment check, a read-only projection of the installation. */
  environment: TeamEnvironmentSource
  /** The judge's live status: whether one is reachable right now. */
  judge: TeamContextJudgeSource
  /** The staged form over the judge's endpoint; it holds nothing while this deployment serves no settings document. */
  judgeForm: TeamJudgeFormSource
  /** Whether the settings document holds a key literal for the judge. */
  keyConfigured: () => boolean
  /** The reply switch's projection; a landed write republishes it so every surface moves at once. */
  replyCapabilities: TeamReplyCapabilitiesFace
}

export type TeamSettingsProps =
  & PropsRuntime<'settings.section'>
  & PropsLocale<'team'>
  & TeamSettingsInjected

/**
 * Run one durable write and reduce every failure to the message the page
 * reports. A rejected Remote call (a dropped carrier, a refused write) is a
 * failure like any other: without this the field would sit on "saving" forever
 * and report nothing.
 */
async function failureOf(action: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await action()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** First visible character of a display name, or the neutral `H` before one is known. */
function avatarInitial(name: string | undefined): string {
  const trimmed = (name ?? '').replace(/^@/, '').trim()
  return trimmed === '' ? 'H' : trimmed.slice(0, 1).toUpperCase()
}

export function TeamSettingsSection(props: TeamSettingsProps) {
  const { t, identity } = props
  const profile = useHumanIdentity(identity)
  // The endpoint form is observed rather than received: the settings service it
  // is built over can arrive after this entry's injected props were computed,
  // and those props are cached for the entry's lifetime, so a value handed over
  // once would never appear.
  const judgeForm = useSyncExternalStore(props.judgeForm.subscribe, props.judgeForm.getSnapshot)
  // Undefined means "follow the Host value": the field re-syncs whenever the
  // profile changes underneath, without a background read clobbering a name
  // the reader is still editing.
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const filePicker = useRef<HTMLInputElement | null>(null)

  const name = draft ?? profile.name ?? ''
  const dirty = draft !== undefined && draft.trim() !== (profile.name ?? '')
  const emptyName = draft !== undefined && draft.trim() === ''
  const hasAvatar = profile.avatarRef !== undefined
  // The circle answers to decoded bytes, not to a stored reference: the Host
  // accepts any `image/…` payload, so a file this browser cannot read has to
  // fall back to the initial exactly as a removed one does.
  const avatar = useAvatarImage(profile.avatarUrl)

  const submitName = async (): Promise<void> => {
    if (!dirty || emptyName || saving) return
    setSaving(true)
    setNotice(null)
    const failure = await failureOf(() => props.saveName(name.trim()))
    setSaving(false)
    if (failure !== undefined) {
      setNotice(t('humanSettingsNameFailed', { message: failure }))
      return
    }
    setDraft(undefined)
  }

  const pickAvatar = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    setNotice(null)
    if (!file.type.startsWith('image/')) {
      setNotice(t('humanSettingsAvatarNotImage'))
      return
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setNotice(t('humanSettingsAvatarTooLarge'))
      return
    }
    setUploading(true)
    const failure = await failureOf(() => props.uploadAvatar(file))
    setUploading(false)
    if (failure !== undefined) setNotice(t('humanSettingsAvatarFailed', { message: failure }))
  }

  const removeAvatar = async (): Promise<void> => {
    setNotice(null)
    const failure = await failureOf(() => props.removeAvatar())
    if (failure !== undefined) setNotice(t('humanSettingsAvatarFailed', { message: failure }))
  }

  // The page says what it is before it says what happened: the settings nav
  // lists it beside the Harness's own pages, so the title alone leaves "whose
  // Team is this, and where does a change apply?" unanswered — and every state,
  // including a failed read, has to answer it.
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
            disabled={saving}
            onChange={(event) => { setDraft(event.target.value) }}
          />
          <Button type="submit" variant="primary" disabled={saving || !dirty || emptyName}>
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
          {avatar.src === undefined
            ? <span className={`${css.identity} ${css.identityFallback}`} data-avatar="initial" aria-hidden="true">{avatarInitial(profile.name)}</span>
            : <img className={`${css.identity} ${css.identityImage}`} data-avatar="image" src={avatar.src} alt="" onError={avatar.failed} />}
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
            disabled={uploading}
            onClick={() => { filePicker.current?.click() }}
          >
            {uploading ? t('humanSettingsUploading') : hasAvatar ? t('humanSettingsReplace') : t('humanSettingsUpload')}
          </Button>
          {hasAvatar && <Button disabled={uploading} onClick={() => { void removeAvatar() }}>{t('humanSettingsRemoveAvatar')}</Button>}
        </div>
      </div>
    </div>
    {judgeForm === undefined
      ? null
      : <Fragment>
          <JudgeGroup
            t={t}
            form={judgeForm}
            judge={props.judge}
            keyConfigured={props.keyConfigured}
          />
          <ReplyGroup t={t} form={judgeForm} capabilities={props.replyCapabilities} />
        </Fragment>}
    <div className={css.environment}>
      <EnvironmentCheck t={t} environment={props.environment} />
    </div>
    <div className={css.footnote}>
      <span>{t('humanSettingsVersion', { version: profile.version ?? '' })}</span>
      <span aria-hidden="true">·</span>
      <a className={css.link} href={profile.repoUrl ?? ''} target="_blank" rel="noreferrer">GitHub</a>
      {profile.updateAvailable && profile.latestVersion !== undefined
        ? <a
            className={css.link}
            href={`${profile.repoUrl ?? ''}/releases`}
            target="_blank"
            rel="noreferrer"
          >{t('humanSettingsUpdateAvailable', { version: profile.latestVersion })}</a>
        : null}
    </div>
    {emptyName && <p className={css.notice}>{t('humanSettingsNameEmpty')}</p>}
    {notice === null ? null : <p className={css.notice} role="alert">{notice}</p>}
  </div>
}

/**
 * The judge's endpoint as one collapsed row: the state of jev on the line
 * itself, and the three controls that decide it behind a disclosure.
 *
 * Collapsed is the default because the endpoint is set once and then left
 * alone, while its state is worth seeing every time the page opens — so the
 * row carries the answer and the controls wait. The status is read rather than
 * derived, because a deployment may mount a judge from configuration this page
 * cannot see, and it states what the Host answered rather than predicting it.
 */
/**
 * The quote-reply switch.
 *
 * It rides the same settings document as the judge's endpoint — one section,
 * one revision — but writes on the click instead of on a Save, because a
 * switch that appears to do nothing until something else is pressed reads as
 * broken. The Host is what actually gates the feature; this control only asks.
 */
function ReplyGroup(props: {
  readonly t: PropsLocale<'team'>['t']
  readonly form: TeamJudgeForm
  readonly capabilities: TeamReplyCapabilitiesFace
}) {
  const { t, form, capabilities } = props
  const state = useSyncExternalStore(form.subscribe, form.getSnapshot, form.getSnapshot)
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(false)
  // An absent value is the Host's own default, which is on.
  const enabled = state.fields.replyEnabled.text !== 'off'

  const toggle = async (next: boolean): Promise<void> => {
    setPending(true)
    setFailed(false)
    const landed = await form.setReplyEnabled(next)
    // Publish the new answer before anything else reads it: the reply
    // affordance on every open surface follows this one store.
    if (landed) await capabilities.refresh()
    setPending(false)
    if (!landed) setFailed(true)
  }

  return <div className={css.group}>
    <div className={css.groupHeader}>
      <span className={css.groupTitle}>{t('teamReplyGroupTitle')}</span>
    </div>
    <div className={css.groupBody} role="group" aria-label={t('teamReplyGroupTitle')} data-team-reply>
      <Checkbox
        checked={enabled}
        disabled={!state.shell.writable || pending}
        label={t('teamReplyEnabled')}
        onChange={(next) => { void toggle(next) }}
      />
      <p className={css.groupHint}>{t('teamReplyGroupHint')}</p>
      {failed && <p className={css.groupNotice} role="alert">{t('teamReplyWriteFailed')}</p>}
    </div>
  </div>
}

function JudgeGroup(props: {
  readonly t: PropsLocale<'team'>['t']
  readonly form: TeamJudgeForm
  readonly judge: TeamContextJudgeSource
  readonly keyConfigured: () => boolean
}) {
  const { t, form, judge, keyConfigured } = props
  const { report } = useContextJudge(judge)
  const state = useSyncExternalStore(form.subscribe, form.getSnapshot, form.getSnapshot)
  const actions = form.actions()
  const [open, setOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearFailed, setClearFailed] = useState(false)

  const configured = keyConfigured()
  // Every control answers to the document: a read-only document disables them
  // all rather than letting a save fail after the fact.
  const disabled = !state.shell.writable
  const labels = {
    overridden: t('teamSettingsOverridden'),
    reset: t('teamSettingsReset'),
    invalid: t('teamSettingsInvalid'),
  }
  const field = (name: TeamJudgeField): SettingsFieldState => state.fields[name]

  const clear = async (): Promise<void> => {
    setClearing(true)
    setClearFailed(false)
    const landed = await form.clearKey()
    setClearing(false)
    if (!landed) setClearFailed(true)
  }

  return <div className={css.group}>
    <button
      type="button"
      className={css.groupToggle}
      aria-expanded={open}
      onClick={() => { setOpen(value => !value) }}
    >
      <span className={css.groupChevron} aria-hidden="true">
        {open ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />}
      </span>
      <span className={css.groupTitle}>{t('teamJudgeGroupTitle')}</span>
      <JudgeStatus t={t} report={report} />
    </button>
    {open
      ? <div className={css.groupBody} role="group" aria-label={t('teamJudgeGroupTitle')} data-team-judge>
        <p className={css.groupHint}>{t('teamJudgeGroupHint')}</p>
        <SettingsForm
          labels={{
            unavailable: t('teamSettingsUnavailable'),
            readOnly: t('teamSettingsReadOnly'),
            saveFailed: t('teamSettingsSaveFailed'),
            save: t('teamSettingsSave'),
            saving: t('teamSettingsSaving'),
          }}
          state={state.shell}
          onSave={actions.save}
          onDiscard={actions.discard}
        >
          <SettingsValueField
            id="team-judge-api-base"
            label={t('teamJudgeApiBase')}
            text={field('apiBase').text}
            overridden={field('apiBase').overridden}
            invalid={field('apiBase').invalid}
            overriddenLabel={labels.overridden}
            resetLabel={labels.reset}
            invalidLabel={labels.invalid}
            disabled={disabled}
            onEdit={text => { actions.edit('apiBase', text) }}
            onReset={() => { actions.resetField('apiBase') }}
          />
          <SettingsValueField
            id="team-judge-model"
            label={t('teamJudgeModel')}
            text={field('model').text}
            overridden={field('model').overridden}
            invalid={field('model').invalid}
            overriddenLabel={labels.overridden}
            resetLabel={labels.reset}
            invalidLabel={labels.invalid}
            disabled={disabled}
            onEdit={text => { actions.edit('model', text) }}
            onReset={() => { actions.resetField('model') }}
          />
          <SettingsSecretField
            id="team-judge-api-key"
            label={t('teamJudgeKey')}
            hint={t('teamJudgeKeyHint')}
            text={field('apiKey').text}
            configured={configured}
            stateLabel={configured ? t('teamJudgeKeySet') : t('teamJudgeKeyUnset')}
            disabled={disabled}
            onEdit={text => { actions.edit('apiKey', text) }}
          />
          {configured
            ? <div className={css.clearRow}>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || state.shell.dirty || clearing}
                onClick={() => { void clear() }}
              >
                {t('teamJudgeClearKey')}
              </Button>
              <p className={css.clearHint}>
                {state.shell.dirty ? t('teamJudgeClearBlocked') : t('teamJudgeClearHint')}
              </p>
              {clearFailed ? <p className={css.notice} role="status">{t('teamJudgeClearFailed')}</p> : null}
            </div>
            : null}
        </SettingsForm>
      </div>
      : null}
  </div>
}

/** The three glyphs, drawn at the 16px seat the settings page uses for state marks. */
const ICONS = {
  ok: <path d="M3 8.5 6.5 12 13 4.5" />,
  off: <><circle cx="8" cy="8" r="6" /><path d="M5.6 8h4.8" /></>,
  warn: <><path d="M8 2.5 14.6 13.6H1.4z" /><path d="M8 6.6v3.2" /><path d="M8 11.9h.01" /></>,
} as const

/**
 * The judge's live status in one line, inside the row that carries it. The
 * verdict is stated as text and an icon, never by color alone, and nothing is
 * said before the first read settles: the row then stands as a bare title.
 */
function JudgeStatus({ t, report }: {
  readonly t: PropsLocale<'team'>['t']
  readonly report: AgentTeamContextJudgeResult | undefined
}) {
  if (report === undefined) return null
  const verdict = report.enabled ? 'enabled' : report.reason ?? 'unavailable'
  return <span className={css.status} data-context-judge={verdict}>
    <svg
      className={css.statusIcon}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >{ICONS[report.enabled ? 'ok' : report.reason === 'no-key' ? 'off' : 'warn']}</svg>
    <span>
      {report.enabled
        ? t('teamJudgeReady')
        : report.reason === 'no-key' ? t('teamJudgeNoKey') : t('teamJudgeUnavailable')}
    </span>
  </span>
}
