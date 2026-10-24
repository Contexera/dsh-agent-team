import { IconCheckOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import composerCss from './composer.module.css'
import css from './main-stream.module.css'

/** Rules version 2 composer controls: the owner turns the send into a new Thread, as a discussion or, checked, a Task. */
export function TeamThreadStartControls({ open, asTask, pending, onOpenChange, onAsTaskChange, t }: {
  readonly open: boolean
  readonly asTask: boolean
  readonly pending: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onAsTaskChange: (asTask: boolean) => void
  readonly t: TeamConversationProps['t']
}) {
  return <>
    <button
      type="button"
      className={open ? `${composerCss.asTaskPill} ${composerCss.asTaskPillOn}` : composerCss.asTaskPill}
      aria-pressed={open}
      disabled={pending}
      onClick={() => { onOpenChange(!open) }}
    >
      {open && <IconCheckOutlineMedium size={14} />}
      <span className={composerCss.asTaskLabel}>{t('startThread')}</span>
    </button>
    {open && <label className={css.startCheck}>
      <input type="checkbox" checked={asTask} disabled={pending} onChange={event => { onAsTaskChange(event.currentTarget.checked) }} />
      <span>{t('asTask')}</span>
    </label>}
  </>
}
