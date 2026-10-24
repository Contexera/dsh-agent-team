/**
 * Registry of every model-facing recovery line the Team renders: one entry per situation, built from the values the rejection holds so the line names the refused value. It lives in the Host because both tools and the ledger reject, and tools import the Host, never the reverse. `assertRecoveryCoverage` refuses entries no situation reaches; `forbidHandWrittenRecovery` scans model-facing sources for route sentences outside the registry.
 */

/** What a rejection hands the registry: the values the sentence should name. */
export interface RecoveryContext {
  /** The value the model passed that was refused, echoed so the line is concrete. */
  readonly refused?: string | undefined
  /** The Thread the rejected action was aimed at, when there is one. */
  readonly threadRef?: string | undefined
  /** The Task the rejected action was aimed at, when there is one. */
  readonly taskRef?: string | undefined
  /** The Project the rejected action was aimed at, when there is one. */
  readonly projectRef?: string | undefined
  /** The tool action whose parameter shape was wrong, when the fault is a shape. */
  readonly action?: string | undefined
  /** The parameter that belongs to another action, when the fault is that one. */
  readonly parameter?: string | undefined
  /** The action that parameter does belong to, when the fault is that one. */
  readonly owner?: string | undefined
}

/** One registered way out: the situation it answers, and its words. */
export interface RecoveryEntry {
  /** The rejection kind this entry answers, exactly as the rejecting code spells it. */
  readonly kind: string
  /** The sentence, built from the context so it can name real values. */
  readonly sentence: (context: RecoveryContext) => string
}

/** One entry per model-facing fault, naming the next action and its value. Lookup is by exact kind so a new kind cannot inherit a neighbour's sentence. */
export const RECOVERY_REGISTRY: readonly RecoveryEntry[] = Object.freeze([
  {
    kind: 'unread_required',
    sentence: ({ threadRef, taskRef }: RecoveryContext) => [
      'Read the pending updates with team_thread read before reconsidering this write.',
      ...(threadRef === undefined ? [] : [threadRef]),
      ...(taskRef === undefined ? [] : [taskRef]),
    ].join(' '),
  },
  {
    kind: 'main_unread_required',
    sentence: ({ projectRef }: RecoveryContext) => `Read the pending Main stream updates with team_thread read and projectRef${projectRef === undefined ? '' : ` ${projectRef}`} before reconsidering this post.`,
  },
  {
    kind: 'project_owner_required',
    sentence: ({ projectRef }: RecoveryContext) => `Only a Project owner starts or promotes a Thread — use team_message post to speak in ${projectRef === undefined ? 'the Project' : projectRef}'s Main stream, and mention an owner when the work needs one.`,
  },
  {
    kind: 'not_project_member',
    sentence: ({ projectRef }: RecoveryContext) => `Only Project members take part in ${projectRef === undefined ? 'a Project' : projectRef} — choose a Project listed by team_view, or ask the Human or a Project owner to mention you there.`,
  },
  {
    kind: 'main_stream_addressing',
    sentence: ({ refused }: RecoveryContext) => `${refused ?? 'threadRef and projectRef'} address different things — pass threadRef to read a Thread, or projectRef to read a Project's Main stream, and retry with one of them.`,
  },
  {
    kind: 'unread_remaining',
    sentence: () => 'call team_thread read again.',
  },
  {
    kind: 'stale_revision',
    sentence: () => 'Read the Thread, reconsider the new facts, then retry with the token that read returns.',
  },
  {
    // Same refusal as `stale_revision` with a different cause: the token was never a revision this Thread reached. The race sentence would send the model hunting for a nonexistent insertion. A distinct kind keeps exact-kind lookup reachable.
    kind: 'stale_revision_token_unrecognized',
    sentence: ({ threadRef }: RecoveryContext) => [
      'That write token is not a revision this Thread reached — nobody inserted anything, so there is nothing to go and re-read.',
      `Take a current token from ${threadRef === undefined ? 'the Thread' : threadRef} with team_thread read, or reuse the one your own last committed mutation rendered.`,
    ].join(' '),
  },
  {
    kind: 'member_not_following',
    sentence: () => 'Only a Human can invite an unfollowed Agent — retry without mentioning them, or ask the Human.',
  },
  {
    kind: 'missing_thread_identity',
    sentence: () => 'Copy a threadRef (or a taskRef on a Taskful Thread) from team_inbox or team_view, then retry.',
  },
  {
    kind: 'missing_message_ref',
    sentence: ({ refused }: RecoveryContext) => `Copy the messageRef you were shown${refused === undefined ? '' : ` (${refused})`}, then retry.`,
  },
  {
    kind: 'history_only_arguments',
    sentence: ({ action }: RecoveryContext) => `${action ?? 'read'} drains unread and cannot page — drop beforeSequence and limit, or call action: history to page older facts.`,
  },
  {
    kind: 'action_only_arguments',
    // Named by parameter: `messageRef` belongs to `message` alone and would otherwise be dropped silently.
    sentence: ({ action, parameter, owner }: RecoveryContext) => `${action ?? 'read'} does not accept ${parameter ?? 'that parameter'} — drop it, or call action: ${owner ?? 'message'} where it belongs.`,
  },
  {
    kind: 'missing_write_token',
    sentence: () => 'Drain the Thread with team_thread read and copy the next-write token it renders, or reuse the one your own last committed mutation rendered.',
  },
  {
    kind: 'start_requires_project',
    sentence: () => 'start opens a new Thread: copy a projectRef from team_view, and use reply instead when you already hold a threadRef.',
  },
  {
    kind: 'post_requires_project',
    sentence: () => 'post speaks in a Project\'s Main stream: copy a projectRef from team_view, and use reply instead when you already hold a threadRef.',
  },
  {
    kind: 'dm_requires_member',
    sentence: () => 'Copy the memberRef of an enabled Agent from team_view; a DM is a private note, so shared work belongs in a Thread reply.',
  },
  {
    kind: 'claim_requires_direction',
    sentence: () => 'claim opens a new Claim with your one-sentence direction — drop claimRef, or use done/release to change an existing one.',
  },
  {
    kind: 'claim_close_requires_ref',
    sentence: ({ action }: RecoveryContext) => `Copy the claimRef of your own Claim from team_claim list or the Thread read; you can only ${action ?? 'close'} a Claim you own.`,
  },
  {
    kind: 'list_takes_task_only',
    sentence: () => 'Drop baseRevision, direction, and claimRef — list takes only taskRef.',
  },
  {
    kind: 'claim_owned_by_another',
    sentence: ({ refused }: RecoveryContext) => `Claim ${refused ?? ''} belongs to another Member or another Task — list this Task's Claims with team_claim list and close one of your own.`,
  },
  {
    kind: 'reply_target_unknown',
    sentence: ({ refused }: RecoveryContext) => `Reply target ${refused ?? ''} is not a recorded Message — copy a messageRef rendered by team_thread read, team_view, or an inbox notice.`,
  },
  {
    kind: 'attachment_path_rejected',
    sentence: ({ refused }: RecoveryContext) => `Attachment ${refused ?? ''} was refused — attachments are absolute paths to one existing non-empty file within the byte limit; fix the path or drop the attachment.`,
  },
  {
    kind: 'unknown_ref',
    sentence: ({ refused }: RecoveryContext) => `${refused ?? 'That ref'} does not name anything this workspace holds — reuse the full ref exactly as returned by Team tools, or list the candidates with team_view.`,
  },
  {
    kind: 'ambiguous_ref',
    sentence: ({ refused }: RecoveryContext) => `${refused ?? 'That ref'} matches several entries — reuse a longer prefix, or the full ref exactly as returned by Team tools.`,
  },
  {
    kind: 'workspace_required',
    sentence: ({ refused }: RecoveryContext) => `workspace is required when you participate in multiple Workspaces — choose one of: ${refused ?? ''}.`,
  },
  {
    kind: 'workspace_ambiguous',
    // `refused` already reads "workspace:X matches '…001', '…002'", so this
    // sentence supplies the verdict and the route and never a second verb.
    sentence: ({ refused }: RecoveryContext) => `${refused ?? ''} — that prefix is ambiguous: reuse a longer prefix, or the full Workspace id exactly as listed.`,
  },
  {
    kind: 'workspace_not_participating',
    sentence: ({ refused }: RecoveryContext) => `Not participating in Workspace ${refused ?? ''} — copy a full id from team_view, or a unique prefix of at least 6 hex characters.`,
  },
])

/** Every kind the registry answers, for the coverage check below. */
export const RECOVERY_KINDS: readonly string[] = Object.freeze(RECOVERY_REGISTRY.map(entry => entry.kind))

/** Look one entry up by exact kind; an unregistered kind is a bug, never a silent fallback. */
export function recoveryFor(kind: string): RecoveryEntry {
  const entry = RECOVERY_REGISTRY.find(candidate => candidate.kind === kind)
  if (entry === undefined) throw new Error(`no registered recovery for '${kind}'; add an entry to RECOVERY_REGISTRY`)
  return entry
}

/** Refuses a registry entry no produced situation reaches, and a produced situation with no entry. */
export function assertRecoveryCoverage(producedKinds: readonly string[]): void {
  const produced = new Set(producedKinds)
  for (const entry of RECOVERY_REGISTRY) {
    if (!produced.has(entry.kind)) {
      throw new Error(`recovery entry '${entry.kind}' matches no situation the Team produces`)
    }
  }
  for (const kind of produced) {
    if (!RECOVERY_KINDS.includes(kind)) throw new Error(`situation '${kind}' has no registered recovery`)
  }
}

/** Refuses a hand-written recovery sentence in model-facing source. Comments are stripped before the scan, so only what a model would read is checked. */
export function forbidHandWrittenRecovery(source: string, fileName: string): void {
  if (fileName.endsWith('recovery-hints.ts')) return
  const withoutComments = stripComments(source)
  // Imperative route shapes only: a bare `retry` also names variables and policies.
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
