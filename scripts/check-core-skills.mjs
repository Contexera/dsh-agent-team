// Mechanical gate for the core skills shipped in the bundle (`packages/agent-team/core-skills/**/*`, product
// content a Member loads by copying a skill directory into its own skills directory). It enforces:
//   1. the front matter names the skill exactly as its directory does;
//   2. the description is a real index entry, not a stub;
//   3. the whole skill stays inside a reviewed prompt budget, because a Member pays for the text it reads;
//   4. every relative link stays inside the skill directory (the installer copies only that directory),
//      and every file under references/ is reachable from SKILL.md.
// Runs standalone: `npm run check:core-skills` (also part of `npm test`); `--root <dir>` checks another tree.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SKILLS_DIRECTORY = 'packages/agent-team/core-skills'
const SKILL_FILE = 'SKILL.md'
const REFERENCES_DIRECTORY = 'references'

// The reviewed ceiling for one skill: dsh-developer's 8000-character active-set
// limit minus its 150-character margin. Raising this number is a deliberate act
// in the same change that adds the text, not a reaction to a red check.
const SKILL_CHARACTER_BUDGET = 7850
// The description is the skill's only index entry; below this it names no
// trigger and the catalog cannot route to it.
const DESCRIPTION_MIN_CHARACTERS = 40

const args = process.argv.slice(2)
const rootFlag = args.indexOf('--root')
const root = rootFlag === -1 ? repositoryRoot : resolve(args[rootFlag + 1] ?? '.')
const skillsRoot = join(root, SKILLS_DIRECTORY)

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

if (!existsSync(skillsRoot) || !statSync(skillsRoot).isDirectory()) {
  console.error(`Core skill check failed: no core skills directory at ${skillsRoot}`)
  process.exit(1)
}

const skills = readdirSync(skillsRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort()
if (skills.length === 0) {
  console.error(`Core skill check failed: no skill directories under ${skillsRoot}`)
  process.exit(1)
}

let referenceCount = 0
let linkCount = 0
const sizes = []
for (const name of skills) {
  const skillDirectory = join(skillsRoot, name)
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
  const characters = files.reduce((total, file) => total + normalizedLength(readFileSync(file, 'utf8')), 0)
  sizes.push(`${name} ${characters}/${SKILL_CHARACTER_BUDGET}`)
  if (characters > SKILL_CHARACTER_BUDGET) {
    fail(skillFile, `the skill is ${characters} characters; the reviewed budget is ${SKILL_CHARACTER_BUDGET}. `
      + 'Trim it, or raise SKILL_CHARACTER_BUDGET in scripts/check-core-skills.mjs deliberately.')
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

if (failures.length > 0) {
  console.error(`Core skill check failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(
  `Core skill check OK: ${skills.length} skill${skills.length === 1 ? '' : 's'} `
  + `(${sizes.join(', ')} characters), ${referenceCount} references linked, ${linkCount} relative links resolved.`,
)
