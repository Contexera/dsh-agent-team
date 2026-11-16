export declare const LANE_ALIASES: ReadonlyMap<string, string>

export interface ParsedRunnerArgs {
  readonly list: boolean
  readonly fileFilters: string[]
  readonly vitestFlags: string[]
  readonly narrowed: boolean
}

export interface SelectedLane {
  readonly name: string
  readonly file: string
  readonly contract: string
}

export interface BrowserRunSummary {
  readonly status: 'passed' | 'failed'
  readonly mode: 'targeted' | 'full'
  readonly lane: string[]
  readonly contract: Array<{ readonly lane: string; readonly contract: string }>
  readonly tests: { readonly total: number; readonly passed: number; readonly failed: number } | null
  readonly phase: { readonly failed: string | null; readonly scenario: string | null }
  readonly duration: { readonly totalMs: number; readonly phases: Record<string, number> }
  readonly screenshots: number
  readonly artifactPath: string
  readonly environmentBlocker: string | null
  readonly needsFullAcceptance: boolean
  readonly nextAction: string
  readonly error?: string
}

export function parseRunnerArgs(rawArgs: readonly string[]): ParsedRunnerArgs
export function laneNameFromFile(fileName: string): string
export function parseLaneContracts(catalogMarkdown: string): Map<string, string>
export function resolveLanes(options: {
  readonly allE2eFiles: readonly string[]
  readonly fileFilters: readonly string[]
  readonly aliases?: ReadonlyMap<string, string>
  readonly contracts?: ReadonlyMap<string, string>
}): { readonly matchedE2eFiles: string[]; readonly selectedLanes: SelectedLane[] }
export function formatLaneList(
  allE2eFiles: readonly string[],
  contracts?: ReadonlyMap<string, string>,
  aliases?: ReadonlyMap<string, string>,
): string
export function buildSummary(options: {
  readonly status: 'passed' | 'failed'
  readonly mode: 'targeted' | 'full'
  readonly selectedLanes: readonly SelectedLane[]
  readonly phases: Record<string, number>
  readonly failedPhase?: string | null
  readonly scenarioPhase?: string | null
  readonly tests?: { readonly total: number; readonly passed: number; readonly failed: number } | null
  readonly screenshots?: number
  readonly artifactPath: string
  readonly environmentBlocker?: string | null
  readonly error?: string | null
}): BrowserRunSummary
export function formatSummaryText(summary: BrowserRunSummary): string
