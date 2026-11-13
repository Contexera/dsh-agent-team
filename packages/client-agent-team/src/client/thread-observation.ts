import type { AgentTeamMemberId } from '@contexera/dsh-agent-team/types'

/** One Host follower-set answer, tagged so a reader can reject an answer that predates a newer write. */
export interface ThreadFollowerObservation {
  readonly ids: ReadonlySet<AgentTeamMemberId>
  /** Grows across reads in one Thread opening; zero is the unread placeholder. */
  readonly sequence: number
}
