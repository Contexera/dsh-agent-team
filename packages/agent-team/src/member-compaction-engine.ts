import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type {} from './index.ts'

export default class MemberCompactionEngine extends BasicCompactionEngine {
  override compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    if (trigger === 'pressure' && this.ctx.get('agentTeam')?.config.memberCompaction.get().enabled === true) {
      return Promise.resolve(null)
    }
    return super.compactIfNeeded(agent, trigger, signal)
  }
}
