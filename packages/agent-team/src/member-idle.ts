import type { AgentTeamMemberId } from './types/entities.ts'

/** Process-local presence observations; intentionally empty after a Host restart. */
export class MemberIdleTracker {
  private readonly idleSince = new Map<AgentTeamMemberId, number>()

  status(memberId: AgentTeamMemberId, status: 'running' | 'idle' | 'error', nowMs: number): void {
    if (status === 'idle') {
      if (!this.idleSince.has(memberId)) this.idleSince.set(memberId, nowMs)
    } else {
      this.idleSince.delete(memberId)
    }
  }

  idleMs(memberId: AgentTeamMemberId, nowMs: number): number | undefined {
    const since = this.idleSince.get(memberId)
    return since === undefined ? undefined : Math.max(0, nowMs - since)
  }

  forget(memberId: AgentTeamMemberId): void {
    this.idleSince.delete(memberId)
  }
}
