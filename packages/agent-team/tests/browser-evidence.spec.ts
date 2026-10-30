import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertScreenshotEvidence, readScreenshots } from '../../../scripts/browser-evidence.mjs'

/**
 * One real 1×1 PNG. The guard reads the file itself, so a fixture has to be an
 * image it can decode rather than arbitrary bytes, and the cases below scale
 * the promised viewport widths down to this fixture's single pixel instead of
 * shipping 1440px and 390px fixtures.
 */
const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4Oo/7PwAGyAKe4yFCTgAAAABJRU5ErkJggg==', 'base64')

const roots: string[] = []
async function artifacts(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-team-evidence-'))
  roots.push(root)
  return root
}

async function shot(directory: string, name: string, bytes = ONE_PIXEL_PNG): Promise<void> {
  const path = join(directory, name)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, bytes)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('browser run evidence', () => {
  it('reads the size each screenshot reports', async () => {
    const directory = await artifacts()
    await shot(directory, 'ui-01/desktop.png')
    expect(await readScreenshots(directory)).toMatchObject([{ width: 1, height: 1 }])
  })

  it('accepts a run that left readable screenshots in its directories', async () => {
    const directory = await artifacts()
    await shot(directory, 'ui-01/desktop.png')
    await shot(directory, 'main-stream/stream-desktop.png')
    expect(await assertScreenshotEvidence(directory, [1])).toBe(2)
  })

  it('refuses the empty directory a cleared run leaves behind', async () => {
    // The release run reported 10/10 passing while this directory held no PNG:
    // the gate must fail on exactly that state, not pass on the suite's verdict.
    const directory = await artifacts()
    await expect(assertScreenshotEvidence(directory, [1440, 390])).rejects.toThrow(/holds no screenshot/)
  })

  it('refuses a directory a mid-run clear emptied and the next staging re-created', async () => {
    const directory = await artifacts()
    await shot(directory, 'ui-01/desktop.png')
    await mkdir(join(directory, 'ui-04'), { recursive: true })
    await expect(assertScreenshotEvidence(directory, [1])).rejects.toThrow(/ui-04 is empty/)
  })

  it('refuses a screenshot it cannot read back as a PNG', async () => {
    const directory = await artifacts()
    await shot(directory, 'ui-02/truncated.png', ONE_PIXEL_PNG.subarray(0, 30))
    await shot(directory, 'ui-05/not-an-image.png', Buffer.from('interrupted write'))
    await expect(assertScreenshotEvidence(directory, [1])).rejects.toThrow(/truncated PNG \(no IEND chunk\)[\s\S]*missing PNG signature/)
  })

  it('refuses a promised viewport width with no readable screenshot', async () => {
    const directory = await artifacts()
    await shot(directory, 'ui-01/desktop.png')
    await expect(assertScreenshotEvidence(directory, [1, 390])).rejects.toThrow(/no readable 390px-wide screenshot/)
  })
})
