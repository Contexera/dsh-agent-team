import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useEnvironmentCheck, type TeamEnvironmentSource } from './environment-check.ts'
import css from './environment-check.module.css'

/**
 * The local environment check: which DSH line this installation runs against,
 * and whether that line is inside the range the bundle declares.
 *
 * Three verdicts, never a fourth, and never a guess: a fact the Host could not
 * establish is `undetermined`, not a mismatch. Every verdict is stated as text
 * plus an icon, so the state survives a reader who cannot tell the colors
 * apart. The support line is written in words rather than as a bare semver
 * range, and the tested combination is printed only when the Host could derive
 * both of its versions — the page never supplies a version of its own.
 */

export type EnvironmentCheckProps =
  & PropsLocale<'team'>
  & { readonly environment: TeamEnvironmentSource }

/** The three glyphs, drawn at the 16px seat the settings page uses for state marks. */
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

/** The release notes this bundle's own repository keeps, one click from the version footnote. */
const RELEASE_NOTES_URL = 'https://github.com/Contexera/dsh-agent-team/releases'

export function EnvironmentCheck({ t, environment }: EnvironmentCheckProps) {
  const { report } = useEnvironmentCheck(environment)
  // Nothing to state before the first read settles, and nothing to state if it
  // never lands: the block is informational and its absence is not an error.
  if (report === undefined) return null

  const range = report.supportRange
  const running = report.dshVersion
  // The tested combination appears only when both of its versions were derived:
  // the installed manifest's own version, and the range's lower bound, which is
  // the certified line. A missing one withholds the line rather than inviting a
  // hand-written version onto the page.
  const certified = report.certifiedDshVersion
  const bundleVersion = report.bundleVersion
  // Both sides of the line have to be derived: `'unknown'` is the data layer's
  // word for a version that could not be read, and it never reaches the page.
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

  // `data-environment` carries the verdict the way the rest of the Client marks
  // a state for assertions; the block also renders nothing at all before a read
  // lands, so a journey can wait on this attribute rather than on prose.
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
