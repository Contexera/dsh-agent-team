import type { WorkerEngine } from '@contexera/dsh-agent-team/worker-settings'
import type { TeamKey } from './locales.ts'

/**
 * One Worker engine's copy — the name the settings page and the Thread's
 * activity rows both show, and the CLI its path falls back to. It lives beside
 * neither surface: two faces spelling one engine differently is what it prevents.
 */
export const WORKER_ENGINE_COPY = {
  codex: { name: 'workerEngineCodex', command: 'codex' },
  claude: { name: 'workerEngineClaude', command: 'claude' },
} as const satisfies Record<WorkerEngine, { readonly name: TeamKey, readonly command: string }>

/**
 * One engine's display name, read from the page's dictionary.
 * @param t - the page's locale reader.
 * @param engine - the engine the row or the activity names.
 * @returns the engine's name in the reader's language.
 */
export function workerEngineName(t: (key: TeamKey) => string, engine: WorkerEngine): string {
  return t(WORKER_ENGINE_COPY[engine].name)
}
