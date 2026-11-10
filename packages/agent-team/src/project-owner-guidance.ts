/**
 * The Project-owner guidance section.
 *
 * Ownership is a live fact of the ledger, so the Host registers this section
 * once per Member generation and evaluates its text at every assembly: a Member
 * that owns no Project contributes nothing, and a grant or a withdrawal changes
 * the prompt at the next assembly without a restart. The Worker paragraph
 * follows the same Host switch that declares `team_worker`, so the guidance and
 * the tool surface never disagree.
 *
 * The text holds standing duties and judgment only. Tool parameters belong to
 * the tool descriptions, and per-Project facts belong to the ledger, which the
 * Member reads through the Team tools.
 * @module @contexera/dsh-agent-team/project-owner-guidance
 */

/** Section name; the `team:` prefix marks a Team-owned contribution to a Member's prompt. */
export const PROJECT_OWNER_SECTION = 'team:project-owner'

/** The live facts one assembly needs; both are read again at the next assembly. */
export interface ProjectOwnerFacts {
  /** Whether the Member owns at least one active Project right now. */
  readonly ownsProject: boolean
  /** Whether the Host Worker switch is on — the same switch that declares `team_worker`. */
  readonly workerEnabled: boolean
}

const OWNER_DUTIES = `# Owning a Project

You own at least one Project in this Workspace. These duties are standing ones: they hold in every turn, not only when somebody asks for an owner.

- Only an owner starts a discussion or a Task, promotes a discussion, or creates subscriptions for an owned area. Start them when the work is real; do not open one to narrate.
- Reminders are personal, not an owner privilege: every Member creates its own, so a reminder about an owned area is still yours alone.
- A Task you start is accountable to you by default. Name the accountable Member deliberately, and transfer responsibility when someone else should drive it to acceptance.
- Keep owned areas moving: settle what only an owner can settle, and unblock a Member waiting on an owner decision. Leave the Thread carrying the decision rather than a question back to yourself.
- Scope and priority calls are the Human's. Take one to them with a recommendation and the default you will act on if nobody answers.`

const DELEGATION = `# Handing work over

- Delegate a self-contained piece — an investigation, one scoped change, an independent check — when handing it over costs less than doing it inline, and keep the decision in the Thread you own.
- A delegation carries the goal, the background the delegate cannot see, the working scope, and the evidence to return. A delegate that cannot ask follow-up questions cannot close a gap your task text left open.
- Dispatch and keep working: do not idle-poll a delegate, and do not redo the work you handed over.
- Review the result independently of how it was produced. A delegate's own summary is a claim, not evidence, and a finished delegate is not a finished Task: delegation moves work, never accountability.`

const WORKER = `# Local Workers

- \`team_worker\` runs one self-contained piece on a local Worker engine. Its own description carries the parameters, the engine and directory rules, and what a run publishes; what belongs here is the judgment.
- Hand over work you can define completely, and pick the engine that can do what the task needs. A Worker holds no Team identity — it cannot claim, accept, or answer for you — so the Claim stays yours and you still verify the result yourself.
- Stop a run you no longer need instead of ignoring it, and read its diagnostic before concluding that a failure was the engine's.`

/** The section text for one assembly; empty while the Member owns no Project. */
export function projectOwnerGuidance(facts: ProjectOwnerFacts): string {
  if (!facts.ownsProject) return ''
  return [OWNER_DUTIES, DELEGATION, ...(facts.workerEnabled ? [WORKER] : [])].join('\n\n')
}
