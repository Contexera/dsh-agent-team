import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './state-dot.module.css'

export type TeamStateDotState = StateDotState | 'todo' | 'quiet'

/** Native StateDot states pass through; the quiet statuses mirror its geometry locally: todo a hollow ring, quiet a solid tertiary dot with the same 10% halo. */
export function TeamStateDot({ state, size = 10 }: {
  readonly state: TeamStateDotState
  readonly size?: number | undefined
}) {
  if (state === 'todo' || state === 'quiet') {
    return <span className={css.quiet} data-variant={state} style={{ width: size, height: size }} aria-hidden="true" />
  }
  return <StateDot state={state} size={size} />
}
