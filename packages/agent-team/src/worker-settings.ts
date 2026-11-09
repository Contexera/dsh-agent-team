/**
 * The facts the Worker settings page, the Host, and the ledger must agree on:
 * which engines a delegation can name, the Codex sandbox modes it can ask for,
 * the policy this bundle configures, and how much of a run's text survives.
 * Dependency-free because the Client bundle imports it.
 * @module @contexera/dsh-agent-team/worker-settings
 */

/** The engines a delegation may name, in the order the settings page offers them; the first version ships Codex and Claude Code only. */
export const WORKER_ENGINES = ['codex', 'claude'] as const

/** One engine a Worker can run on. */
export type WorkerEngine = typeof WORKER_ENGINES[number]

/** Codex's native permission modes, spelled as its CLI spells them; `inherit` leaves the operator's own Codex configuration in charge. */
export const WORKER_SANDBOX_MODES = ['workspace-write', 'read-only', 'danger-full-access', 'inherit'] as const

/**
 * The permission policy a Worker runs under when nobody has chosen one: full
 * access. A Worker is work the operator already handed to an engine with its own
 * tools and login, and OAR runs both engines gate-free by default — nobody sits at
 * an approval prompt in embedded use, where a gate is a hang rather than safety.
 * The row can still narrow this, which is the only reason the field exists.
 */
export const DEFAULT_WORKER_SANDBOX = 'danger-full-access'

/** How much of an engine's answer one execution record keeps, in code points; the notice carrying it is smaller. */
export const WORKER_OUTPUT_MAX_CHARACTERS = 64 * 1024

/** How much of a failure summary one record keeps; the Harness provider caps the diagnostic it hands over in bytes. */
export const WORKER_DIAGNOSTIC_MAX_CHARACTERS = 4 * 1024

/** How much of a failure or stop reason a public Thread fact carries, in code points. */
export const WORKER_REASON_MAX_CHARACTERS = 2000

/** How much of a run's task the Human's run list previews; the full text stays in the private execution record. */
export const WORKER_TASK_PREVIEW_MAX_CHARACTERS = 240
