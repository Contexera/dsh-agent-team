import { useId, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input, SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import { HUMAN_AVATAR_MAX_BYTES } from '@contexera/dsh-agent-team/human-settings'
import { useHumanIdentity, type TeamHumanIdentityFace } from './human-identity.ts'
import { EnvironmentCheck } from './EnvironmentCheck.tsx'
import type { TeamEnvironmentSource } from './environment-check.ts'
import { formLabels } from './locales.ts'
import { useTeamConfig, type TeamConfigFace } from './team-config.ts'
import { useAvatarImage } from './avatar-image.ts'
import css from './team-settings.module.css'

/** The Team's settings page: identity, the Host row's compaction threshold, the local environment check, and the version footnote. It owns no durable fact and no copy of one — identity writes through the Team Remote, the threshold through the shared configuration form — and a failed write keeps the typed value and reports the Host's reason. */

export interface TeamSettingsInjected {
  /** The shared Human identity projection: profile facts plus post-write refresh. */
  identity: TeamHumanIdentityFace
  /** Persist one renamed display name; the failure message when the Host refuses it. */
  saveName: (name: string) => Promise<string | undefined>
  /** Upload one image file, persist its reference; the failure message when it does not stick. */
  uploadAvatar: (file: File) => Promise<string | undefined>
  removeAvatar: () => Promise<string | undefined>
  environment: TeamEnvironmentSource
  /** The Host row's compaction threshold; absent when the settings service is. */
  teamConfig?: TeamConfigFace | undefined
}

export type TeamSettingsProps =
  & PropsRuntime<'settings.section'>
  & PropsLocale<'team'>
  & TeamSettingsInjected

/** A rejected Remote call (a dropped carrier) is a failure like any other; otherwise the field would sit on "saving" forever. */
async function failureOf(action: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await action()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function avatarInitial(name: string | undefined): string {
  const trimmed = (name ?? '').replace(/^@/, '').trim()
  return trimmed === '' ? 'H' : trimmed.slice(0, 1).toUpperCase()
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

export function TeamSettingsSection(props: TeamSettingsProps) {
  const { t, identity } = props
  const profile = useHumanIdentity(identity)
  const [draft, setDraft] = useState<NameDraft>({ kind: 'follow' })
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const filePicker = useRef<HTMLInputElement | null>(null)

  const name = draft.kind === 'editing' ? draft.text : profile.name ?? ''
  const dirty = draft.kind === 'editing' && draft.text.trim() !== (profile.name ?? '')
  const emptyName = draft.kind === 'editing' && draft.text.trim() === ''
  const hasAvatar = profile.avatarRef !== undefined
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
    setDraft({ kind: 'follow' })
  }

  const pickAvatar = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    setNotice(null)
    if (!file.type.startsWith('image/')) {
      setNotice(t('humanSettingsAvatarNotImage'))
      return
    }
    if (file.size > HUMAN_AVATAR_MAX_BYTES) {
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
            disabled={saving}
            onChange={(event) => { setDraft({ kind: 'editing', text: event.target.value }) }}
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
            disabled={uploading}
            onClick={() => { filePicker.current?.click() }}
          >
            {uploading ? t('humanSettingsUploading') : hasAvatar ? t('humanSettingsReplace') : t('humanSettingsUpload')}
          </Button>
          {hasAvatar && <Button disabled={uploading} onClick={() => { void removeAvatar() }}>{t('humanSettingsRemoveAvatar')}</Button>}
        </div>
      </div>
    </div>
    {props.teamConfig === undefined ? null : <ContextSettings t={t} face={props.teamConfig} />}
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
    {emptyName && <p className={css.notice}>{t('humanSettingsNameEmpty')}</p>}
    {notice === null ? null : <p className={css.notice} role="alert">{notice}</p>}
  </div>
}
