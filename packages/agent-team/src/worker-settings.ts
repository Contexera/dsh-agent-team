/**
 * Spellings the Worker settings page and the Host must agree on: which engines a
 * delegation can name, the Codex sandbox modes it can ask for, and the policy
 * this bundle configures. Dependency-free because the Client bundle imports it.
 * @module @contexera/dsh-agent-team/worker-settings
 */

/** The engines a delegation may name, in the order the settings page offers them; the first version ships Codex and Claude Code only. */
export const WORKER_ENGINES = ['codex', 'claude'] as const

/** One engine a Worker can run on. */
export type WorkerEngine = typeof WORKER_ENGINES[number]

/** Codex's native permission modes, spelled as its CLI spells them; `inherit` leaves the operator's own Codex configuration in charge. */
export const WORKER_SANDBOX_MODES = ['workspace-write', 'read-only', 'danger-full-access', 'inherit'] as const

/** The policy this bundle configures rather than inheriting Codex's own: writes inside the Worker's working directory, nothing wider. */
export const DEFAULT_WORKER_SANDBOX = 'workspace-write'
