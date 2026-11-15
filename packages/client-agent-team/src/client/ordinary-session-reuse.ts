import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'

/**
 * Keep the shipped blank-reuse flow away from this Host's Team-owned Sessions.
 * The public Controller boundary preserves its Workspace choice, draft,
 * navigation cancellation, default preset, and failure notification. The Host's
 * durable ownership, not an id prefix or a label, excludes a Team candidate.
 */
export function protectOrdinarySessionReuse(ctx: ClientContext): () => void {
  const sessions = ctx.sessions as unknown as ISessions
  const original = sessions.create.bind(sessions)
  let disposed = false
  const guarded: ISessions['create'] = async options => {
    const candidate = options?.sessionId
    // A caller that already pinned a preset keeps the shipped filtering and
    // Host refusal semantics; only an implicit default is ambiguous here.
    if (candidate === undefined || options?.agentPreset !== undefined
      || sessions.list.getSnapshot().byId[candidate]?.blank !== true) return original(options)
    const interrupted = ctx.locale.bind('team')('sessionCreationInterrupted')
    const response = await ctx.remote.agentTeam.sessionOwnership({ sessionIds: [candidate] })
    // Settle the caller without creating a Session after teardown. Its owner
    // still controls navigation cancellation and failure presentation.
    if (disposed) throw new Error(interrupted)
    if (!response.ok) throw new Error(response.error.message)
    if (!response.value.some(entry => entry.sessionId === candidate)) return original(options)
    const { sessionId: _teamOwned, ...withoutCandidate } = options ?? {}
    return original(withoutCandidate)
  }
  sessions.create = guarded
  return () => {
    disposed = true
    if (sessions.create === guarded) sessions.create = original
  }
}
