import { useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, SettingsForm, SettingsSecretField, SettingsValueField, type SettingsFieldState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentTeamContextJudgeResult } from '@wowyuarm/dsh-agent-team/types'
import { useContextJudge, type TeamContextJudgeSource } from './context-judge.ts'
import type { TeamContextGateForm, TeamGateField } from './context-gate-form.ts'
import css from './context-judge.module.css'

/**
 * The context gate's settings page: whether the judge is reachable right now,
 * and the row configuration that decides when it is asked.
 *
 * The status is read rather than derived — a deployment may mount the judge
 * from configuration this page cannot see — so the page states what the Host
 * answered and never predicts it. The form stages every edit and writes them on
 * one save; the key literal is write-only, so its control starts blank on every
 * load, and removing a stored one is an explicit clear.
 */

/** The status projection, the staged form, and the one fact neither carries. */
export interface ContextJudgeSettingsInjected {
  /** The judge's live status: whether one is reachable, and the thresholds in force. */
  judge: TeamContextJudgeSource
  /** The staged form over the row configuration that mounts the judge. */
  form: TeamContextGateForm
  /** Whether the settings document holds a key literal for the judge. */
  keyConfigured: () => boolean
}

export type ContextJudgeSettingsProps =
  & PropsRuntime<'settings.section'>
  & PropsLocale<'team'>
  & ContextJudgeSettingsInjected

/** The three glyphs, drawn at the 16px seat the settings page uses for state marks. */
const ICONS = {
  ok: <path d="M3 8.5 6.5 12 13 4.5" />,
  off: <><circle cx="8" cy="8" r="6" /><path d="M5.6 8h4.8" /></>,
  warn: <><path d="M8 2.5 14.6 13.6H1.4z" /><path d="M8 6.6v3.2" /><path d="M8 11.9h.01" /></>,
} as const

function StatusIcon({ glyph }: { readonly glyph: keyof typeof ICONS }) {
  return <svg
    className={css.statusIcon}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >{ICONS[glyph]}</svg>
}

/** One staged control, wired to the shared form's state for its field. */
function GateField(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly help?: { readonly label: string; readonly content: ReactNode } | undefined
  readonly numeric?: boolean
  readonly state: SettingsFieldState
  readonly labels: { readonly overridden: string; readonly reset: string; readonly invalid: string }
  readonly disabled: boolean
  readonly onEdit: (text: string) => void
  readonly onReset: () => void
}) {
  return <SettingsValueField
    id={props.id}
    label={props.label}
    hint={props.hint}
    {...props.help === undefined ? {} : { help: props.help }}
    {...props.numeric === true ? { numeric: true } : {}}
    text={props.state.text}
    overridden={props.state.overridden}
    invalid={props.state.invalid}
    overriddenLabel={props.labels.overridden}
    resetLabel={props.labels.reset}
    invalidLabel={props.labels.invalid}
    disabled={props.disabled}
    onEdit={props.onEdit}
    onReset={props.onReset}
  />
}

export function ContextJudgeSettingsSection(props: ContextJudgeSettingsProps) {
  const { t, judge, form, keyConfigured } = props
  const { report } = useContextJudge(judge)
  const state = useSyncExternalStore(form.subscribe, form.getSnapshot, form.getSnapshot)
  const actions = form.actions()
  const [clearing, setClearing] = useState(false)
  const [clearFailed, setClearFailed] = useState(false)

  const configured = keyConfigured()
  // Every control answers to the document: a read-only document disables them
  // all rather than letting a save fail after the fact.
  const disabled = !state.shell.writable
  const labels = {
    overridden: t('contextGateOverridden'),
    reset: t('contextGateReset'),
    invalid: t('contextGateInvalid'),
  }
  const field = (name: TeamGateField): SettingsFieldState => state.fields[name]

  const clear = async (): Promise<void> => {
    setClearing(true)
    setClearFailed(false)
    const landed = await form.clearKey()
    setClearing(false)
    if (!landed) setClearFailed(true)
  }

  return <div className={css.section}>
    <h2 className={css.heading}>{t('contextGateTitle')}</h2>
    <p className={css.intro}>{t('contextGateIntro')}</p>
    <JudgeStatus t={t} report={report} />
    <SettingsForm
      labels={{
        unavailable: t('contextGateFormUnavailable'),
        readOnly: t('contextGateFormReadOnly'),
        saveFailed: t('contextGateSaveFailed'),
        save: t('contextGateSave'),
        saving: t('contextGateSaving'),
      }}
      state={state.shell}
      onSave={actions.save}
      onDiscard={actions.discard}
    >
      <div className={css.group}>
        <h3 className={css.groupTitle}>{t('contextGateEndpointTitle')}</h3>
        <GateField
          id="team-gate-api-base"
          label={t('contextGateApiBase')}
          hint={t('contextGateApiBaseHint')}
          help={{ label: t('contextGateApiBaseHelpLabel'), content: t('contextGateApiBaseHelp') }}
          state={field('apiBase')}
          labels={labels}
          disabled={disabled}
          onEdit={text => { actions.edit('apiBase', text) }}
          onReset={() => { actions.resetField('apiBase') }}
        />
        <GateField
          id="team-gate-model"
          label={t('contextGateModel')}
          hint={t('contextGateModelHint')}
          state={field('model')}
          labels={labels}
          disabled={disabled}
          onEdit={text => { actions.edit('model', text) }}
          onReset={() => { actions.resetField('model') }}
        />
        <GateField
          id="team-gate-key-env"
          label={t('contextGateKeyEnv')}
          hint={t('contextGateKeyEnvHint')}
          state={field('apiKeyEnv')}
          labels={labels}
          disabled={disabled}
          onEdit={text => { actions.edit('apiKeyEnv', text) }}
          onReset={() => { actions.resetField('apiKeyEnv') }}
        />
        <SettingsSecretField
          id="team-gate-api-key"
          label={t('contextGateApiKey')}
          hint={t('contextGateApiKeyHint')}
          text={field('apiKey').text}
          configured={configured}
          stateLabel={configured ? t('contextGateKeySet') : t('contextGateKeyUnset')}
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
              {t('contextGateClearKey')}
            </Button>
            <p className={css.clearHint}>
              {state.shell.dirty ? t('contextGateClearBlocked') : t('contextGateClearHint')}
            </p>
            {clearFailed ? <p className={css.notice} role="status">{t('contextGateClearFailed')}</p> : null}
          </div>
          : null}
      </div>
      <div className={css.group}>
        <h3 className={css.groupTitle}>{t('contextGateThresholdsTitle')}</h3>
        <p className={css.groupHint}>{t('contextGateThresholdsHint')}</p>
        <GateField
          id="team-gate-tokens"
          label={t('contextGateTokens')}
          hint={t('contextGateTokensHint')}
          numeric
          state={field('tokens')}
          labels={labels}
          disabled={disabled}
          onEdit={text => { actions.edit('tokens', text) }}
          onReset={() => { actions.resetField('tokens') }}
        />
        <GateField
          id="team-gate-idle-ms"
          label={t('contextGateIdleMs')}
          hint={t('contextGateIdleMsHint')}
          numeric
          state={field('idleMs')}
          labels={labels}
          disabled={disabled}
          onEdit={text => { actions.edit('idleMs', text) }}
          onReset={() => { actions.resetField('idleMs') }}
        />
        <GateField
          id="team-gate-judge-timeout"
          label={t('contextGateJudgeTimeoutMs')}
          hint={t('contextGateJudgeTimeoutMsHint')}
          help={{ label: t('contextGateJudgeTimeoutMsHelpLabel'), content: t('contextGateJudgeTimeoutMsHelp') }}
          numeric
          state={field('judgeTimeoutMs')}
          labels={labels}
          disabled={disabled}
          onEdit={text => { actions.edit('judgeTimeoutMs', text) }}
          onReset={() => { actions.resetField('judgeTimeoutMs') }}
        />
      </div>
    </SettingsForm>
  </div>
}

/**
 * The judge's live status: whether one is reachable, why not when it is not, and
 * the thresholds actually in force.
 *
 * The verdict is stated as text and an icon, never by color alone, and the
 * thresholds come from the Host rather than from the form's own values: a
 * deployment that set them outside the settings document, or a row whose write
 * has not taken effect, is exactly what this line exists to show.
 */
function JudgeStatus({ t, report }: {
  readonly t: PropsLocale<'team'>['t']
  readonly report: AgentTeamContextJudgeResult | undefined
}) {
  // Nothing to state before the first read settles, and nothing to state if it
  // never lands: the page's form stands on its own.
  if (report === undefined) return null

  const verdict = report.enabled ? 'enabled' : report.reason ?? 'unavailable'
  const thresholds = t('contextGateThresholds', {
    tokens: String(report.gate.tokens),
    idle: String(report.gate.idleMs),
    timeout: String(report.gate.judgeTimeoutMs),
  })
  return <div className={css.status} data-context-judge={verdict}>
    <StatusIcon glyph={report.enabled ? 'ok' : report.reason === 'no-key' ? 'off' : 'warn'} />
    <div className={css.statusBody}>
      <p className={css.statusTitle}>
        {report.enabled
          ? t('contextGateEnabled')
          : report.reason === 'no-key' ? t('contextGateNoKey') : t('contextGateUnavailable')}
      </p>
      <p className={css.statusDetail}>
        {report.enabled
          ? thresholds
          : report.reason === 'no-key' ? t('contextGateNoKeyDetail') : t('contextGateUnavailableDetail')}
      </p>
      {report.enabled ? null : <p className={css.statusDetail}>{thresholds}</p>}
      <p className={css.statusDetail}>{t('contextGateKeyEnvDetail', { name: report.keyEnv })}</p>
    </div>
  </div>
}
