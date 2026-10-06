// Mechanical gate for the certified-version consistency rule.
//
// The certified DSH baseline is written in many places: the CI tag, the setup
// script tag, the development guide, the READMEs, the architecture doc, the
// compatibility doc, and the bug-report placeholder — each in both languages
// where a pair exists. Humans advance those spots one by one and forget one
// silently; this script reads them all back and refuses a split baseline.
//
// It asserts two lane-agnostic facts, never a hardcoded version, so both the
// blocking lane and the alpha lane pass unchanged:
// (a) every named spot states the same certified version (the `dsh-v` prefix
//     the machine files carry is normalized away), and
// (b) that version is the lower bound of every `@deepseek-ai/dsh-*`
//     peer range in the root manifest — the line we certify is the
//     line users can install.
// The bug-report placeholder also names our own plugin version, which must
// equal the root manifest version. Both READMEs must name the released plugin
// version in the install command (c), and both languages of the compatibility
// doc must restate the declared peer line as the manifest declares it (d) — a
// sentence that drifted silently until it was gated.
//
// Deliberately excluded: CHANGELOG (history), `.scratch/` (work history), the
// history paragraphs inside the compatibility doc (only its baseline sentence
// is read), and the vendored sqlite fork pin (intentionally off-baseline).
//
// It deliberately runs standalone — no Harness checkout, no Vitest config — so
// a version-touching change can be checked in a second:
// `npm run check:versions`, which is also part of `npm test`.
// `--root <dir>` points the same checks at another tree (used to run the gate
// against the extracted alpha lane without switching branches).
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argvRoot = argvValue('--root')
const root = argvRoot ? resolve(argvRoot) : repositoryRoot

function argvValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

function extract(relativePath, pattern) {
  const text = read(relativePath)
  const match = text.match(pattern)
  return match ? match[1] : undefined
}

const failures = []
// The tag spots carry the `dsh-v` prefix the prose spots omit.
const normalize = (version) => version.replace(/^dsh-v/u, '')

// (a) Every named spot states the same certified version. Each pattern anchors
// on the sentence that declares the current baseline — a marker word, then the
// backticked token, tolerating prose between them on the same line but never
// across another inline-code span, and never requiring prose after the token.
// An adjacency-only pattern reads a sentence rewrite as a version change (the
// 2026-10-06 Chinese rewrite did exactly that), while dropping the marker would
// let history paragraphs that mention older versions participate.
const spots = [
  { file: '.github/workflows/ci.yml', pattern: /DSH_HARNESS_TAG:\s*dsh-v(\S+)/u },
  { file: '.hoplite/settings.json', pattern: /HARNESS_TAG=\\"dsh-v([^\\]+)\\"/u },
  { file: 'docs/development/environments-and-install.md', pattern: /currently[^\n`]*`dsh-v([^`]+)`/u },
  { file: 'docs/development/environments-and-install.md', pattern: /minimum compatible DSH version is[^\n`]*`([^`]+)`/u },
  { file: 'docs/development/environments-and-install.zh.md', pattern: /当前[^\n`]*`dsh-v([^`]+)`/u },
  { file: 'docs/development/environments-and-install.zh.md', pattern: /最低兼容版本是 DSH[^\n`]*`([^`]+)`/u },
  { file: 'README.md', pattern: /certified against DSH[^\n`]*`([^`]+)`/u },
  { file: 'README.zh.md', pattern: /针对 DSH[^\n`]*`([^`]+)`/u },
  // Quick start starts the host itself, and must start the certified line: an
  // unversioned `npx @deepseek-ai/dsh web` resolves `latest`, which would hand
  // the reader a host this bundle's peers refuse.
  { file: 'README.md', pattern: /npx @deepseek-ai\/dsh@([0-9][^ ]*) web/u },
  { file: 'README.zh.md', pattern: /npx @deepseek-ai\/dsh@([0-9][^ ]*) web/u },
  // The global install named right after it is a second way to get the same
  // host line, and `extract` reads one match per spot, so it needs its own.
  { file: 'README.md', pattern: /npm i -g @deepseek-ai\/dsh@([0-9][^` ]*)/u },
  { file: 'README.zh.md', pattern: /npm i -g @deepseek-ai\/dsh@([0-9][^` ]*)/u },
  { file: 'docs/architecture/host-authority.md', pattern: /targets DSH[^\n`]*`([^`]+)`/u },
  { file: 'docs/architecture/host-authority.zh.md', pattern: /目标为 DSH[^\n`]*`([^`]+)`/u },
  { file: 'docs/dsh-release-compatibility.md', pattern: /current certified baseline is DSH[^\n`]*`([^`]+)`/u },
  { file: 'docs/dsh-release-compatibility.zh.md', pattern: /已认证基线是 DSH[^\n`]*`([^`]+)`/u },
]

// One file can own two spots (the development guide states both the setup
// tag and the minimum compatible version), so findings are a list, not a
// file-keyed map.
const stated = []
for (const { file, pattern } of spots) {
  const found = extract(file, pattern)
  if (found === undefined) {
    failures.push(`${file}: baseline declaration not found (pattern stopped matching — update the pattern with the prose)`)
  } else {
    stated.push({ file, version: normalize(found) })
  }
}

// The CI tag is the machine source: it is what the setup script checks out.
const reference = stated.find((entry) => entry.file === '.github/workflows/ci.yml')?.version
if (reference !== undefined) {
  for (const { file, version } of stated) {
    if (version !== reference) {
      failures.push(`${file} states ${version} but the certified baseline is ${reference} (from .github/workflows/ci.yml)`)
    }
  }
}

// The bug-report placeholder names both versions: the DSH line under test and
// our own plugin version, which must equal the root manifest version.
const manifest = JSON.parse(read('package.json'))
const placeholderMatch = read('.github/ISSUE_TEMPLATE/bug_report.yml')
  .match(/placeholder:\s*"DSH ([^·]+) · plugin ([^"]+)"/u)
if (placeholderMatch === null) {
  failures.push('.github/ISSUE_TEMPLATE/bug_report.yml: version placeholder not found (pattern stopped matching — update the pattern with the prose)')
} else {
  const [, placeholderDsh, placeholderPlugin] = placeholderMatch
  if (normalize(placeholderDsh.trim()) !== reference) {
    failures.push(`.github/ISSUE_TEMPLATE/bug_report.yml states DSH ${placeholderDsh.trim()} but the certified baseline is ${reference} (from .github/workflows/ci.yml)`)
  }
  if (placeholderPlugin.trim() !== manifest.version) {
    failures.push(`.github/ISSUE_TEMPLATE/bug_report.yml states plugin ${placeholderPlugin.trim()} but package.json is ${manifest.version}`)
  }
}

// (b) The certified version is the lower bound of every DSH peer range:
// the line we certify is the line users can install. (The vendored sqlite
// fork lives in devDependencies as an exact off-baseline pin on purpose and
// never enters peerDependencies, so there is nothing to exclude here.)
const peerRanges = Object.entries(manifest.peerDependencies ?? {})
  .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
if (peerRanges.length === 0) {
  failures.push('package.json: no @deepseek-ai/dsh-* peerDependencies found (the lower-bound check would pass vacuously)')
}
for (const [name, range] of peerRanges) {
  const lower = typeof range === 'string' ? range.match(/^>=(\S+)\s+</u)?.[1] : undefined
  if (lower === undefined) {
    failures.push(`package.json peer ${name} has range ${range}, expected >=<certified> <...`)
  } else if (lower !== reference) {
    failures.push(`package.json peer ${name} admits from ${lower} but the certified baseline is ${reference} (from .github/workflows/ci.yml)`)
  }
}

// (c) Both READMEs name the released version in the install command. The pin is
// deliberate — pnpm skips releases younger than a day, so an unpinned `@latest`
// resolves to the previous release on release day — which means the line moves
// with every release. This gate is what makes forgetting it fail loudly.
const installSpots = [
  { file: 'README.md', pattern: /dsh plugin --profile web add @wowyuarm\/dsh-agent-team@(\d+\.\d+\.\d+)/u },
  { file: 'README.zh.md', pattern: /dsh plugin --profile web add @wowyuarm\/dsh-agent-team@(\d+\.\d+\.\d+)/u },
]
for (const { file, pattern } of installSpots) {
  const installVersion = extract(file, pattern)
  if (installVersion === undefined) {
    failures.push(`${file}: install command names no version (the pinned release must stay visible — update the pattern with the command)`)
  } else if (installVersion !== manifest.version) {
    failures.push(`${file} installs ${installVersion} but package.json publishes ${manifest.version}`)
  }
}

// (d) Both languages of the compatibility doc restate the declared peer line in
// prose, in the "Current baseline" section. Nothing else reads that sentence:
// the baseline spot above it anchors the certified version, not the range an
// installer meets. The peers are declared to state one line, so the prose must
// equal it; a range that legitimately differs is a decision to make here, not a
// silent drift.
const proseRanges = [
  { file: 'docs/dsh-release-compatibility.md', pattern: /The DSH peers state exactly that certified line, `([^`]+)`/u },
  { file: 'docs/dsh-release-compatibility.zh.md', pattern: /DSH peers 正好声明这条已认证线：`([^`]+)`/u },
]
const declaredRanges = [...new Set(peerRanges.map(([, range]) => range))]
for (const { file, pattern } of proseRanges) {
  const proseRange = extract(file, pattern)
  if (proseRange === undefined) {
    failures.push(`${file}: declared peer range not found (pattern stopped matching — update the pattern with the prose)`)
  } else if (declaredRanges.length !== 1 || proseRange !== declaredRanges[0]) {
    failures.push(`${file} states the peers declare \`${proseRange}\` but package.json declares ${declaredRanges.map((range) => `\`${range}\``).join(', ')}`)
  }
}

if (failures.length > 0) {
  console.error(`Version consistency check failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(
  `Version consistency check OK: ${stated.length + 1} version spots agree on ${reference}, `
    + `${peerRanges.length} DSH ranges admit from it, plugin ${manifest.version} `
    + `(named by ${installSpots.length} install commands, restated by ${proseRanges.length} prose spots).`,
)
