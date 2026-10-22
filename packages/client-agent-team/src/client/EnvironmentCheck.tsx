import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useEnvironmentCheck, type TeamEnvironmentSource } from './environment-check.ts'
import css from './environment-check.module.css'

/**
 * The local environment check: which DSH line this installation runs against and whether it is inside the declared range.
 * Three verdicts only; a fact the Host could not establish is `undetermined`, not a mismatch. Every verdict is text plus an
 * icon so it survives color blindness. The tested combination prints only when the Host derived both versions.
 */

export type EnvironmentCheckProps =
  & PropsLocale<'team'>
  & { readonly environment: TeamEnvironmentSource }

const ICONS = {
  ok: <path d="M3 8.5 6.5 12 13 4.5" />,
  warn: <><path d="M8 2.5 14.6 13.6H1.4z" /><path d="M8 6.6v3.2" /><path d="M8 11.9h.01" /></>,
  unknown: <><circle cx="8" cy="8" r="6" /><path d="M5.6 8h4.8" /></>,
} as const

function EnvironmentIcon({ glyph }: { readonly glyph: keyof typeof ICONS }) {
  return <svg
    className={css.icon}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >{ICONS[glyph]}</svg>
}

const RELEASE_NOTES_URL = 'https://github.com/Contexera/dsh-agent-team/releases'

export function EnvironmentCheck({ t, environment }: EnvironmentCheckProps) {
  const { report } = useEnvironmentCheck(environment)
  // Informational: absence before or without a read is not an error.
  if (report === undefined) return null

  const range = report.supportRange
  const running = report.dshVersion
  // Withhold the tested line unless both versions were derived (installed manifest version and the range's lower bound).
  const certified = report.certifiedDshVersion
  const bundleVersion = report.bundleVersion
  // `'unknown'` is the data layer's word for an unreadable version and never reaches the page.
  const tested = certified !== undefined && bundleVersion !== undefined && bundleVersion !== 'unknown'

  const title = report.verdict === 'ok'
    ? t('environmentOkTitle')
    : report.verdict === 'out-of-range'
      ? t('environmentOutOfRangeTitle')
      : t('environmentUndeterminedTitle')

  const lines: string[] = []
  if (report.verdict === 'ok') {
    if (running !== undefined) lines.push(t('environmentOkDetail', { version: running }))
  } else if (report.verdict === 'out-of-range') {
    if (running !== undefined) lines.push(t('environmentOutOfRangeDetail', { version: running }))
    if (range !== undefined) lines.push(t('environmentRange', { lower: range.lower, upper: range.upper }))
    if (tested && certified !== undefined && bundleVersion !== undefined) {
      lines.push(t('environmentTested', { bundle: bundleVersion, dsh: certified }))
    }
  } else {
    lines.push(t('environmentUndeterminedDetail'))
  }

  // Marks the verdict for assertions; nothing renders before a read lands, so a journey can wait on this attribute.
  return <div className={css.block} data-environment={report.verdict}>
    <EnvironmentIcon glyph={report.verdict === 'ok' ? 'ok' : report.verdict === 'out-of-range' ? 'warn' : 'unknown'} />
    <div className={css.body}>
      <p className={css.title}>{title}</p>
      {lines.map((line, index) => <p className={css.detail} key={index}>{line}</p>)}
      {report.verdict !== 'ok' && <p className={css.action}>
        <a className={css.link} href={RELEASE_NOTES_URL} target="_blank" rel="noreferrer">{t('environmentReleaseNotes')}</a>
      </p>}
    </div>
  </div>
}
