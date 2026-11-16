export const LANE_ALIASES = new Map([
  ['team-settings-nav-icon', 'team-settings-and-tools'],
])

/** These lanes hold the largest stateful journeys and stay out of the parallel batch. */
export const SERIAL_LANES = new Set(['team-journey', 'team-manager'])

const VALUE_FLAGS = new Set([
  '-t',
  '--testNamePattern',
  '--test-name-pattern',
  '--reporter',
  '-r',
  '--config',
  '-c',
  '--bail',
  '--testTimeout',
])

export function parseRunnerArgs(rawArgs) {
  const fileFilters = []
  const vitestFlags = []
  let list = false
  for (let index = 0; index < rawArgs.length; index += 1) {
    const argument = rawArgs[index]
    if (argument === '--list') {
      list = true
      continue
    }
    if (argument.startsWith('-')) {
      vitestFlags.push(argument)
      if (VALUE_FLAGS.has(argument) && !argument.includes('=') && index + 1 < rawArgs.length) {
        index += 1
        vitestFlags.push(rawArgs[index])
      }
    } else {
      fileFilters.push(argument)
    }
  }
  const narrowed = fileFilters.length > 0
    || vitestFlags.some(argument => /^--?(t|testNamePattern|test-name-pattern)(=|$)/.test(argument))
  return { list, fileFilters, vitestFlags, narrowed }
}

export function laneNameFromFile(fileName) {
  return fileName.endsWith('.e2e.ts') ? fileName.slice(0, -'.e2e.ts'.length) : fileName
}

export function parseLaneContracts(catalogMarkdown) {
  const contracts = new Map()
  let currentLane
  for (const line of catalogMarkdown.split(/\r?\n/)) {
    const headingMatch = line.match(/^### `([a-z0-9-]+)`\s*$/)
    if (headingMatch) {
      currentLane = headingMatch[1]
      continue
    }
    if (currentLane !== undefined) {
      const contractMatch = line.match(/^- \*\*Real Web\/Harness contract:\*\*\s*(.+)$/)
      if (contractMatch) {
        contracts.set(currentLane, contractMatch[1].trim())
        currentLane = undefined
      }
    }
  }
  return contracts
}

export function resolveLanes({ allE2eFiles, fileFilters, aliases = LANE_ALIASES, contracts = new Map() }) {
  const resolvedTokens = fileFilters.flatMap(token => {
    const aliasTarget = aliases.get(token)
    return aliasTarget === undefined ? [token] : [token, aliasTarget]
  })
  const matchedE2eFiles = fileFilters.length === 0
    ? [...allE2eFiles]
    : allE2eFiles.filter(name => resolvedTokens.some(token => name.includes(token)))
  if (matchedE2eFiles.length === 0) {
    const available = allE2eFiles.map(laneNameFromFile).join(', ')
    throw new Error(`No E2E lane matched filter [${fileFilters.join(', ')}]. Available: ${available}`)
  }
  const selectedLanes = matchedE2eFiles.map(file => {
    const name = laneNameFromFile(file)
    return {
      name,
      file,
      contract: contracts.get(name) ?? '(contract not found in docs/development/e2e-lanes.md)',
    }
  })
  return { matchedE2eFiles, selectedLanes }
}

export function planLaneBatches(selectedLanes, { shard = false, maxWorkers = 2 } = {}) {
  if (!shard || selectedLanes.length < 2) {
    return [{ name: 'default', lanes: selectedLanes, vitestFlags: [] }]
  }
  const serial = selectedLanes.filter(lane => SERIAL_LANES.has(lane.name))
  const parallel = selectedLanes.filter(lane => !SERIAL_LANES.has(lane.name))
  if (serial.length === 0 || parallel.length === 0) {
    return [{ name: 'default', lanes: selectedLanes, vitestFlags: [] }]
  }
  return [
    { name: 'serial-heavy', lanes: serial, vitestFlags: [] },
    { name: 'parallel-light', lanes: parallel, vitestFlags: ['--fileParallelism', `--maxWorkers=${String(maxWorkers)}`] },
  ]
}

export function aggregateTestSummaries(summaries) {
  const valid = summaries.filter(summary => summary !== null)
  if (valid.length === 0) return null
  return valid.reduce((total, summary) => ({
    total: total.total + summary.total,
    passed: total.passed + summary.passed,
    failed: total.failed + summary.failed,
  }), { total: 0, passed: 0, failed: 0 })
}

export function formatLaneList(allE2eFiles, contracts = new Map(), aliases = LANE_ALIASES) {
  const reverseAliases = new Map()
  for (const [alias, target] of aliases.entries()) {
    const existing = reverseAliases.get(target) ?? []
    existing.push(alias)
    reverseAliases.set(target, existing)
  }
  const lines = [`Available E2E lanes (${allE2eFiles.length}):`]
  for (const file of allE2eFiles) {
    const name = laneNameFromFile(file)
    const contract = contracts.get(name) ?? '(no contract entry)'
    const aliasList = reverseAliases.get(name)
    const aliasSuffix = aliasList && aliasList.length > 0 ? ` [aliases: ${aliasList.join(', ')}]` : ''
    lines.push(`- ${name}${aliasSuffix}: ${contract}`)
  }
  return lines.join('\n')
}

export function buildSummary({
  status,
  mode,
  selectedLanes,
  phases,
  failedPhase = null,
  scenarioPhase = null,
  tests = null,
  batches = [],
  screenshots = 0,
  artifactPath,
  environmentBlocker = null,
  error = null,
  failedBatch = null,
}) {
  const totalMs = Object.values(phases).reduce((sum, ms) => sum + (typeof ms === 'number' ? ms : 0), 0)
  const needsFullAcceptance = mode === 'targeted'
  const laneNames = selectedLanes.map(lane => lane.name)
  const nextAction = status === 'passed'
    ? (needsFullAcceptance
      ? 'Targeted lane passed; run unfiltered `npm run test:browser` before concluding assembled-Web changes.'
      : 'Full browser acceptance passed.')
    : environmentBlocker !== null
      ? `Resolve environment blocker (${environmentBlocker}) and rerun ${mode === 'targeted' ? `npm run test:browser -- ${laneNames.join(' ')}` : 'npm run test:browser'}.`
      : `Inspect failure in phase '${failedPhase ?? 'unknown'}'${scenarioPhase ? ` (${scenarioPhase})` : ''} and rerun: npm run test:browser -- ${laneNames.join(' ')}`

  return {
    status,
    mode,
    lane: laneNames,
    contract: selectedLanes.map(lane => ({ lane: lane.name, contract: lane.contract })),
    tests,
    phase: {
      failed: failedPhase,
      scenario: scenarioPhase,
      batch: failedBatch,
    },
    duration: {
      totalMs,
      phases,
    },
    batches,
    screenshots,
    artifactPath,
    environmentBlocker,
    needsFullAcceptance,
    nextAction,
    ...(error ? { error } : {}),
  }
}

export function formatSummaryText(summary) {
  const lines = [
    `[test:browser] status=${summary.status} mode=${summary.mode} lanes=${summary.lane.join(',')}`,
    `[test:browser] duration=${summary.duration.totalMs}ms phases=${JSON.stringify(summary.duration.phases)}`,
    `[test:browser] screenshots=${summary.screenshots} artifacts=${summary.artifactPath}`,
  ]
  if (summary.tests) {
    lines.push(`[test:browser] tests=total:${summary.tests.total},passed:${summary.tests.passed},failed:${summary.tests.failed}`)
  }
  if (summary.phase.failed) {
    lines.push(`[test:browser] failedPhase=${summary.phase.failed}${summary.phase.scenario ? ` scenarioPhase=${summary.phase.scenario}` : ''}${summary.phase.batch ? ` batch=${summary.phase.batch}` : ''}`)
  }
  for (const batch of summary.batches ?? []) {
    lines.push(`[test:browser] batch=${batch.name} status=${batch.status} duration=${batch.durationMs}ms lanes=${batch.lanes.join(',')}`)
  }
  if (summary.environmentBlocker) {
    lines.push(`[test:browser] environmentBlocker=${summary.environmentBlocker}`)
  }
  lines.push(`[test:browser] needsFullAcceptance=${summary.needsFullAcceptance}`)
  lines.push(`[test:browser] next=${summary.nextAction}`)
  return lines.join('\n')
}
