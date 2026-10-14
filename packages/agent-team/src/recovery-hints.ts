/**
 * Every model-facing recovery line the Team renders, from one registry.
 *
 * A rejection that names only the fault leaves the model to guess the next
 * move, and the guess is what turns one friction into a loop. This module owns
 * the words for every way out: one entry per situation, built from the values
 * the rejection actually holds, so the line can name the refused value instead
 * of describing it.
 *
 * It lives beside the Host, not beside the tools, because the faults that
 * reach a model come from both layers: the tools refuse a parameter shape they
 * can see, and the ledger refuses a state transition it owns. One registry in
 * the Host is the only way a sentence stays reachable from every site — the
 * package boundary runs one way (tools import the Host, never the reverse), so
 * the registry cannot sit in the tool package and serve the ledger.
 *
 * Two properties make it more than a constant file:
 *
 * 1. **Reachability is asserted.** `assertRecoveryCoverage` refuses a registry
 *    entry no produced situation reaches — dead coverage is worse than none,
 *    because it reads as protection.
 * 2. **Hand-written lines are refused.** `forbidHandWrittenRecovery` scans the
 *    sources that reach a model for a sentence that spells a route outside the
 *    registry, so the next rejection added cannot quietly write its own way out
 *    and drift from the rest of the set.
 */

/** What a rejection hands the registry: the values the sentence should name. */
export interface RecoveryContext {
  /** The value the model passed that was refused, echoed so the line is concrete. */
  readonly refused?: string | undefined
  /** The Thread the rejected action was aimed at, when there is one. */
  readonly threadRef?: string | undefined
  /** The Task the rejected action was aimed at, when there is one. */
  readonly taskRef?: string | undefined
  /** The tool action whose parameter shape was wrong, when the fault is a shape. */
  readonly action?: string | undefined
  /** The parameter that belongs to another action, when the fault is that one. */
  readonly parameter?: string | undefined
  /** The action that parameter does belong to, when the fault is that one. */
  readonly owner?: string | undefined
}

/** One registered way out: a stable id, the situations it answers, and its words. */
export interface RecoveryEntry {
  /** Stable id cited by tests and by the rejection that selects this entry. */
  readonly id: string
  /** The rejection kinds this entry answers, exactly as the rejecting code spells them. */
  readonly kinds: readonly string[]
  /** The sentence, built from the context so it can name real values. */
  readonly sentence: (context: RecoveryContext) => string
}

/**
 * The registry: one entry per model-facing fault, each naming the next action
 * and the value that action takes. Lookup is by exact kind, never by substring,
 * so a new kind cannot inherit a neighbouring entry's sentence by accident.
 */
export const RECOVERY_REGISTRY: readonly RecoveryEntry[] = Object.freeze([
  {
    id: 'unread_required',
    kinds: ['unread_required'],
    sentence: ({ threadRef, taskRef }: RecoveryContext) => [
      'Read the pending updates with team_thread read before reconsidering this write.',
      ...(threadRef === undefined ? [] : [threadRef]),
      ...(taskRef === undefined ? [] : [taskRef]),
    ].join(' '),
  },
  {
    id: 'unread_remaining',
    kinds: ['unread_remaining'],
    sentence: () => 'call team_thread read again.',
  },
  {
    id: 'stale_revision',
    kinds: ['stale_revision'],
    sentence: () => 'Read the Thread, reconsider the new facts, then retry with the token that read returns.',
  },
  {
    id: 'member_not_following',
    kinds: ['member_not_following'],
    sentence: () => 'Only a Human can invite an unfollowed Agent — retry without mentioning them, or ask the Human.',
  },
  {
    id: 'missing_thread_identity',
    kinds: ['missing_thread_identity'],
    sentence: () => 'Copy a threadRef (or a taskRef on a Taskful Thread) from team_inbox or team_view, then retry.',
  },
  {
    id: 'missing_message_ref',
    kinds: ['missing_message_ref'],
    sentence: ({ refused }: RecoveryContext) => `Copy the messageRef you were shown${refused === undefined ? '' : ` (${refused})`}, then retry.`,
  },
  {
    id: 'history_only_arguments',
    kinds: ['history_only_arguments'],
    sentence: ({ action }: RecoveryContext) => `${action ?? 'read'} drains unread and cannot page — drop beforeSequence and limit, or call action: history to page older facts.`,
  },
  {
    id: 'action_only_arguments',
    kinds: ['action_only_arguments'],
    // The same fault class as `history_only_arguments`, named by the parameter
    // rather than hard-coded: `messageRef` belongs to `message` alone, and a
    // read that carried it would otherwise drop it in silence.
    sentence: ({ action, parameter, owner }: RecoveryContext) => `${action ?? 'read'} does not accept ${parameter ?? 'that parameter'} — drop it, or call action: ${owner ?? 'message'} where it belongs.`,
  },
  {
    id: 'missing_write_token',
    kinds: ['missing_write_token'],
    sentence: () => 'Drain the Thread with team_thread read and copy the next-write token it renders, or reuse the one your own last committed mutation rendered.',
  },
  {
    id: 'start_requires_channel',
    kinds: ['start_requires_channel'],
    sentence: () => 'start opens a new Thread: copy a channelRef from team_view, and use reply instead when you already hold a threadRef.',
  },
  {
    id: 'dm_requires_member',
    kinds: ['dm_requires_member'],
    sentence: () => 'Copy the memberRef of an enabled Agent from team_view; a DM is a private note, so shared work belongs in a Thread reply.',
  },
  {
    id: 'claim_requires_direction',
    kinds: ['claim_requires_direction'],
    sentence: () => 'claim opens a new Claim with your one-sentence direction — drop claimRef, or use done/release to change an existing one.',
  },
  {
    id: 'claim_close_requires_ref',
    kinds: ['claim_close_requires_ref'],
    sentence: ({ action }: RecoveryContext) => `Copy the claimRef of your own Claim from team_claim list or the Thread read; you can only ${action ?? 'close'} a Claim you own.`,
  },
  {
    id: 'list_takes_task_only',
    kinds: ['list_takes_task_only'],
    sentence: () => 'Drop baseRevision, direction, and claimRef — list takes only taskRef.',
  },
  {
    id: 'claim_owned_by_another',
    kinds: ['claim_owned_by_another'],
    sentence: ({ refused }: RecoveryContext) => `Claim ${refused ?? ''} belongs to another Member or another Task — list this Task's Claims with team_claim list and close one of your own.`,
  },
  {
    id: 'reply_target_unknown',
    kinds: ['reply_target_unknown'],
    sentence: ({ refused }: RecoveryContext) => `Reply target ${refused ?? ''} is not a recorded Message — copy a messageRef rendered by team_thread read, team_view, or an inbox notice.`,
  },
  {
    id: 'attachment_path_rejected',
    kinds: ['attachment_path_rejected'],
    sentence: ({ refused }: RecoveryContext) => `Attachment ${refused ?? ''} was refused — attachments are absolute paths to one existing non-empty file within the byte limit; fix the path or drop the attachment.`,
  },
  {
    id: 'unknown_ref',
    kinds: ['unknown_ref'],
    sentence: ({ refused }: RecoveryContext) => `${refused ?? 'That ref'} does not name anything this workspace holds — reuse the full ref exactly as returned by Team tools, or list the candidates with team_view.`,
  },
  {
    id: 'ambiguous_ref',
    kinds: ['ambiguous_ref'],
    sentence: ({ refused }: RecoveryContext) => `${refused ?? 'That ref'} matches several entries — reuse a longer prefix, or the full ref exactly as returned by Team tools.`,
  },
  {
    id: 'checkpoint_ref_malformed',
    kinds: ['checkpoint_ref_malformed'],
    sentence: () => 'Copy a checkpointRef exactly as returned by context_status — never derive, shorten, or rebuild one.',
  },
  {
    id: 'rollover_blocked_by_jobs',
    kinds: ['rollover_blocked_by_jobs'],
    sentence: ({ refused }: RecoveryContext) => `This rollover is refused while jobs survive it (${refused ?? ''}) — collect or stop them, then retry.`,
  },
  {
    id: 'workspace_required',
    kinds: ['workspace_required'],
    sentence: ({ refused }: RecoveryContext) => `workspace is required when you participate in multiple Workspaces — choose one of: ${refused ?? ''}.`,
  },
  {
    id: 'workspace_ambiguous',
    kinds: ['workspace_ambiguous'],
    // `refused` already reads "workspace:X matches '…001', '…002'", so this
    // sentence supplies the verdict and the route and never a second verb.
    sentence: ({ refused }: RecoveryContext) => `${refused ?? ''} — that prefix is ambiguous: reuse a longer prefix, or the full Workspace id exactly as listed.`,
  },
  {
    id: 'workspace_not_participating',
    kinds: ['workspace_not_participating'],
    sentence: ({ refused }: RecoveryContext) => `Not participating in Workspace ${refused ?? ''} — copy a full id from team_view, or a unique prefix of at least 6 hex characters.`,
  },
])

/** Every kind the registry answers, for the coverage check below. */
export const RECOVERY_KINDS: readonly string[] = Object.freeze(RECOVERY_REGISTRY.flatMap(entry => entry.kinds))

/** Look one entry up by exact kind; an unregistered kind is a bug, never a silent fallback. */
export function recoveryFor(kind: string): RecoveryEntry {
  const entry = RECOVERY_REGISTRY.find(candidate => candidate.kinds.includes(kind))
  if (entry === undefined) throw new Error(`no registered recovery for '${kind}'; add an entry to RECOVERY_REGISTRY`)
  return entry
}

/**
 * Refuse a registry entry no produced situation reaches, and a produced
 * situation with no entry: both directions are coverage holes, and the second
 * one is the failure this registry exists to prevent.
 */
export function assertRecoveryCoverage(producedKinds: readonly string[]): void {
  const produced = new Set(producedKinds)
  for (const entry of RECOVERY_REGISTRY) {
    if (!entry.kinds.some(kind => produced.has(kind))) {
      throw new Error(`recovery entry '${entry.id}' matches no situation the Team produces`)
    }
  }
  for (const kind of produced) {
    if (!RECOVERY_KINDS.includes(kind)) throw new Error(`situation '${kind}' has no registered recovery`)
  }
}

/**
 * Refuse a hand-written recovery sentence in model-facing source.
 *
 * The registry is only a registry while every line comes from it. A comment
 * describing a route is prose, not a route, so comments are stripped before the
 * scan; what remains is what a model would read, and a route sentence there
 * that is not the registry's is drift.
 */
export function forbidHandWrittenRecovery(source: string, fileName: string): void {
  if (fileName.endsWith('recovery-hints.ts')) return
  const withoutComments = stripComments(source)
  // Imperative route shapes only: a bare `retry` also names a variable, a
  // policy, and an engine's own decision, and matching it would refuse ordinary
  // code for a word rather than for a sentence.
  const routePatterns = [
    /\b(then )?retry (this|it|the|with|again|without|after|a)\b/i,
    /\bcopy (a|an|the) [a-zA-Z]+ (from|rendered by|you were shown)/i,
    /\buse (action|reply|done|release)\b/i,
    /\bcall (team_|action:)/i,
    /\bdrop (them|it|beforeSequence|baseRevision|claimRef|direction)\b/i,
  ]
  for (const pattern of routePatterns) {
    const match = pattern.exec(withoutComments)
    if (match !== null) {
      const line = withoutComments.slice(0, match.index).split('\n').length
      throw new Error(`${fileName}:${line} spells a recovery route by hand; register it in recovery-hints.ts instead`)
    }
  }
}

/** Drop comments and their contents, preserving line numbering so a hit points at real code. */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, match => match.replaceAll(/[^\n]/gu, ' '))
    .replaceAll(/(^|[^:])\/\/[^\n]*/gu, (match, lead: string) => `${lead}${' '.repeat(match.length - lead.length)}`)
}
