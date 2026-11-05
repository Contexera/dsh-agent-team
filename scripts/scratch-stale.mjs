/**
 * Active work items that stopped moving.
 *
 * WHY. The work-history rules require every open item's README to carry a
 * last-checked date, and closing an item moves its directory into the monthly
 * archive. Nothing measured either, so an item could sit in the active tree for
 * months with nobody noticing. This prints the ones past the threshold; it
 * decides nothing, and a missing date is reported rather than skipped, because
 * that absence is the drift the date exists to catch.
 *
 * `--days N` sets the threshold (default 30). `--json` prints one JSON object
 * per stale item and nothing else, so a subscription can publish it directly:
 * an unreadable line would reject the whole run, and staying silent when
 * nothing is stale is what keeps the subscription from becoming noise.
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const activeDirectory = join(root, '.scratch', 'active')

const args = process.argv.slice(2)
const json = args.includes('--json')
const daysIndex = args.indexOf('--days')
const threshold = daysIndex === -1 ? 30 : Number(args[daysIndex + 1])
if (!Number.isInteger(threshold) || threshold <= 0) {
  console.error('--days needs a positive whole number')
  process.exit(2)
}

const LAST_CHECKED = /最后核对(?:日期)?\*{0,2}\s*[：:]\s*(\d{4}-\d{2}-\d{2})/
const DAY = 86_400_000

let entries
try {
  entries = await readdir(activeDirectory, { withFileTypes: true })
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  // Silence would read as "nothing is stale", which is exactly how a broken
  // path looks healthy forever. A missing tree is a failure, not a clean bill.
  console.error(`the active work tree does not exist: ${activeDirectory}`)
  process.exit(1)
}

const works = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
const stale = []
const undated = []

for (const work of works) {
  let text
  try {
    text = await readFile(join(activeDirectory, work, 'README.md'), 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    undated.push({ work, reason: 'no README.md' })
    continue
  }
  const match = LAST_CHECKED.exec(text)
  if (!match) {
    undated.push({ work, reason: 'no last-checked date' })
    continue
  }
  const parsed = Date.parse(`${match[1]}T00:00:00Z`)
  if (Number.isNaN(parsed)) {
    undated.push({ work, reason: 'unreadable last-checked date' })
    continue
  }
  const age = Math.floor((Date.now() - parsed) / DAY)
  if (age > threshold) stale.push({ work, date: match[1], age })
}

if (json) {
  for (const item of stale.sort((a, b) => b.age - a.age)) {
    console.log(JSON.stringify({
      id: `scratch-stale:${item.work}:${item.date}`,
      title: `${item.work} 已 ${item.age} 天没核对`,
      detail: `最后核对 ${item.date}；是继续推还是归档，看一眼。`,
    }))
  }
  for (const item of undated) {
    console.log(JSON.stringify({
      id: `scratch-stale:${item.work}:no-date`,
      title: `${item.work} 缺最后核对日期`,
      detail: `README 的「最后核对日期」读不出来（${item.reason}）；补上或结案。`,
    }))
  }
  process.exit(0)
}

for (const item of stale.sort((a, b) => b.age - a.age)) {
  console.log(`${String(item.age).padStart(4)}d  ${item.date}  ${item.work}`)
}
for (const item of undated) {
  console.log(`    ?  ${item.reason}  ${item.work}`)
}

if (stale.length === 0 && undated.length === 0) {
  console.log(`No stale active work items: ${works.length} checked against ${threshold} days.`)
} else {
  console.log(`\n${stale.length} stale, ${undated.length} without a date, ${works.length} active (threshold ${threshold} days).`)
}
