// Mechanical gate for the skills shipped in the bundle: the Member core skills
// (`packages/agent-team/core-skills/**/*`, product content a Member loads by
// copying a skill directory into its own skills directory) and the manager's
// read-only skills (`packages/agent-team/manager-skills/**/*`, mounted for the
// Team manager Session alone). It enforces:
//   1. the front matter names the skill exactly as its directory does;
//   2. the description is a real index entry, not a stub;
//   3. the text a skill puts in front of a model stays inside a reviewed prompt budget;
//   4. every relative link stays inside the skill directory (the installer copies only that directory),
//      and every file under references/ is reachable from SKILL.md.
// Runs standalone: `npm run check:core-skills` (also part of `npm test`); `--root <dir>` checks another tree.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Both roots ship in the package, so both are gated. The manager root ships the
// six guide skills; it stays optional because its content is a delivery rather
// than a build dependency. The Member root may never be empty — a Member with no
// core skills has no catalog at all.
const SKILL_ROOTS = [
  { directory: 'packages/agent-team/core-skills', label: 'core', required: true },
  { directory: 'packages/agent-team/manager-skills', label: 'manager', required: false },
]
const SKILL_FILE = 'SKILL.md'
const REFERENCES_DIRECTORY = 'references'

// The reviewed ceiling for the text one skill puts in front of a model:
// dsh-developer's 8000-character active-set limit minus its 150-character margin.
// It counts the skill's Markdown — `SKILL.md` plus everything under `references/` —
// because that is what a model reads and pays for. A shipped script is executed,
// never prompted, so it is reported in the summary and reviewed, not budgeted here.
// Raising this number is a deliberate act in the same change that adds the text,
// not a reaction to a red check. Counted in UTF-16 code units like the other
// character budgets; nothing slices with it.
const SKILL_CHARACTER_BUDGET = 7850
// The description is the skill's only index entry; below this it names no
// trigger and the catalog cannot route to it.
const DESCRIPTION_MIN_CHARACTERS = 40

const args = process.argv.slice(2)
const rootFlag = args.indexOf('--root')
const root = rootFlag === -1 ? repositoryRoot : resolve(args[rootFlag + 1] ?? '.')
const skillsRoots = SKILL_ROOTS.map(entry => ({ ...entry, path: join(root, entry.directory) }))

const failures = []
const fail = (file, message) => failures.push(`${relative(root, file).replaceAll('\\', '/')}: ${message}`)

const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g

function relativeTargets(text) {
  const targets = []
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1].trim().replace(/^<|>$/g, '')
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue
    const path = target.split('#', 1)[0].split('?', 1)[0]
    if (path) targets.push(path)
  }
  return targets
}

function filesUnder(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(path))
    else files.push(path)
  }
  return files
}

// The skill loader reads front matter as YAML, so this gate must too: a folded
// or block-scalar value is part of the description the catalog routes by, and
// reading only its first line would pass a skill the loader then indexes under
// a truncated entry. Anything the loader would not accept as a mapping is a
// failure here, never a silently empty field.
function frontMatter(text, fail) {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  if (lines[0] !== '---') return null
  const end = lines.indexOf('---', 1)
  if (end === -1) return null
  let data
  try {
    data = parseYaml(lines.slice(1, end).join('\n'))
  } catch (error) {
    fail(`front matter is not valid YAML: ${error.message}`)
    return null
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    fail('front matter is not a YAML mapping')
    return null
  }
  const fields = new Map()
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') fields.set(key, value.trim())
    else fail(`front matter field "${key}" must be a string`)
  }
  return fields
}

const normalizedLength = text => text.replaceAll('\r\n', '\n').length

let referenceCount = 0
let linkCount = 0
const sizes = []
const scripts = []
const totals = []

for (const skillsRoot of skillsRoots) {
  if (!existsSync(skillsRoot.path) || !statSync(skillsRoot.path).isDirectory()) {
    if (skillsRoot.required) {
      console.error(`Skill check failed: no ${skillsRoot.label} skills directory at ${skillsRoot.path}`)
      process.exit(1)
    }
    totals.push(`${skillsRoot.label} 0 (absent)`)
    continue
  }

  const skills = readdirSync(skillsRoot.path, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  if (skills.length === 0) {
    if (skillsRoot.required) {
      console.error(`Skill check failed: no skill directories under ${skillsRoot.path}`)
      process.exit(1)
    }
    totals.push(`${skillsRoot.label} 0`)
    continue
  }
  totals.push(`${skillsRoot.label} ${skills.length}`)

  for (const name of skills) {
    const skillDirectory = join(skillsRoot.path, name)
    const skillFile = join(skillDirectory, SKILL_FILE)
    if (!existsSync(skillFile)) {
      fail(skillFile, 'skill directory has no SKILL.md')
      continue
    }

    const text = readFileSync(skillFile, 'utf8')
    const fields = frontMatter(text, message => fail(skillFile, message))
    if (fields === null) {
      fail(skillFile, 'SKILL.md has no front matter block')
    } else {
      const declared = fields.get('name')
      if (declared === undefined || declared === '') fail(skillFile, 'front matter has no "name" field')
      else if (declared !== name) fail(skillFile, `skill name "${declared}" does not match its directory "${name}"`)
      const description = fields.get('description')
      if (description === undefined || description === '') {
        fail(skillFile, 'front matter has no "description" field')
      } else if (description.length < DESCRIPTION_MIN_CHARACTERS) {
        fail(skillFile, `description is ${description.length} characters; it must name the real triggers (at least ${DESCRIPTION_MIN_CHARACTERS})`)
      }
    }

    const files = filesUnder(skillDirectory)
    const promptFiles = files.filter(file => file.endsWith('.md'))
    const scriptFiles = files.filter(file => !file.endsWith('.md'))
    const characters = promptFiles.reduce((total, file) => total + normalizedLength(readFileSync(file, 'utf8')), 0)
    sizes.push(`${name} ${characters}/${SKILL_CHARACTER_BUDGET}`)
    if (characters > SKILL_CHARACTER_BUDGET) {
      fail(skillFile, `the skill is ${characters} characters of prompt text; the reviewed budget is ${SKILL_CHARACTER_BUDGET}. `
        + 'Trim it, or raise SKILL_CHARACTER_BUDGET in scripts/check-core-skills.mjs deliberately.')
    }
    if (scriptFiles.length > 0) {
      // Executable payload is not prompt text, but it still ships inside the
      // skill directory, so the summary names it for the reviewer.
      const scriptCharacters = scriptFiles.reduce((total, file) => total + normalizedLength(readFileSync(file, 'utf8')), 0)
      scripts.push(`${name} ${scriptFiles.length} file(s)/${scriptCharacters} characters`)
    }

    // Links are resolved against the file that carries them and must land inside
    // this skill directory: the installer copies that directory alone.
    const linked = new Set()
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      for (const target of relativeTargets(readFileSync(file, 'utf8'))) {
        linkCount += 1
        let path
        try {
          path = decodeURIComponent(target)
        } catch {
          fail(file, `link target is not valid percent-encoding: ${target}`)
          continue
        }
        const resolved = resolve(dirname(file), path)
        const inside = relative(skillDirectory, resolved)
        if (inside.startsWith('..') || resolve(skillDirectory, inside) !== resolved) {
          fail(file, `link target escapes the skill directory: ${target}`)
        } else if (!existsSync(resolved)) {
          fail(file, `broken relative link: ${target}`)
        }
        if (file === skillFile) linked.add(resolved)
      }
    }

    const referencesDirectory = join(skillDirectory, REFERENCES_DIRECTORY)
    if (existsSync(referencesDirectory) && statSync(referencesDirectory).isDirectory()) {
      for (const reference of filesUnder(referencesDirectory).sort()) {
        referenceCount += 1
        if (!linked.has(reference)) {
          fail(skillFile, `reference is not linked here: ${relative(skillDirectory, reference).replaceAll('\\', '/')}`)
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`Skill check failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(
  `Skill check OK (${totals.join(', ')}): ${sizes.length} skill${sizes.length === 1 ? '' : 's'} `
  + `(${sizes.join(', ')} prompt characters), ${referenceCount} references linked, ${linkCount} relative links resolved`
  + `${scripts.length === 0 ? '' : `, shipped scripts: ${scripts.join(', ')}`}.`,
)
