/**
 * The screenshots one browser run leaves behind for review.
 *
 * The run owns this directory, not a scenario: `run-browser-test.mjs` clears it
 * once, before the first screenshot exists, and calls this module afterwards to
 * decide whether the evidence a reviewer is promised is still there. A scenario
 * that cleared the batch would delete screenshots an earlier scenario already
 * produced — and vitest, not the file list, decides which scenario runs last —
 * so a green run could otherwise end with an empty directory.
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** PNG's 8-byte signature; anything else is not an image a reviewer can open. */
const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')

/**
 * The pixel size of a complete PNG, or why the file cannot be read as one.
 * Only the header and the closing chunk are inspected: those are the two ends a
 * truncated write or a stray non-image file breaks, and full-page screenshots
 * are taller than their viewport, so height is reported but never expected.
 */
function pngSize(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(SIGNATURE)) return 'missing PNG signature'
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return 'missing IHDR header'
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width === 0 || height === 0) return 'empty image'
  if (bytes.toString('latin1', bytes.length - 8, bytes.length - 4) !== 'IEND') return 'truncated PNG (no IEND chunk)'
  return { width, height }
}

/** Every file under `directory`, depth first. */
async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}

/** Every PNG under `directory` with the size from its own header, or the reason it is unreadable. */
export async function readScreenshots(directory) {
  const screenshots = []
  for await (const path of walk(directory)) {
    if (!path.endsWith('.png')) continue
    const size = pngSize(await readFile(path))
    screenshots.push(typeof size === 'string' ? { path, problem: size } : { path, ...size })
  }
  return screenshots
}

/**
 * Refuse a run whose evidence a reviewer can no longer open: a missing or
 * unreadable screenshot, an artifact directory left empty, or no readable
 * screenshot at each of the viewport widths the lane promises. Returns the
 * number of screenshots it accepted.
 */
export async function assertScreenshotEvidence(directory, viewportWidths) {
  const screenshots = await readScreenshots(directory)
  const problems = screenshots.length === 0 ? [`${directory} holds no screenshot`] : []
  for (const screenshot of screenshots) if (screenshot.problem !== undefined) problems.push(`${screenshot.path}: ${screenshot.problem}`)
  if (problems.length === 0) {
    for (const width of viewportWidths) {
      if (!screenshots.some(screenshot => screenshot.width === width)) problems.push(`no readable ${width}px-wide screenshot`)
    }
    // A surviving directory with no evidence is what a mid-run clear leaves
    // behind: it removed the batch and the next staging re-created the folders.
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !screenshots.some(screenshot => dirname(screenshot.path) === join(directory, entry.name))) {
        problems.push(`screenshot directory ${entry.name} is empty`)
      }
    }
  }
  if (problems.length > 0) throw new Error(`browser evidence is incomplete:\n  - ${problems.join('\n  - ')}`)
  return screenshots.length
}
