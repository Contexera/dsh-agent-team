// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 30_000 })
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

type Runtime = Awaited<ReturnType<typeof runtimeWithTeam>>

/**
 * Whether an element carries one CSS-module class token, matched by substring
 * because the build hashes the names.
 */
function hasClass(element: Element | null, token: string): boolean {
  return element !== null && [...element.classList].some(name => name.includes(token))
}

/**
 * Hold one Remote read open so a surface's loading frame stands still long
 * enough to be read. A real load answers in milliseconds — far too short to
 * query — so without a gate this frame would be a race rather than a fact.
 * Releasing it lets the read finish and the surface settle.
 */
function gate(b: Runtime, name: 'inbox' | 'loadTaskBoard' | 'readMainStream'): { readonly release: () => void } {
  type Read = (...args: unknown[]) => Promise<unknown>
  // The Read is already a spy, so its current implementation is the readable
  // one to fall through to; holding the spy itself would call the patch again.
  const mock = b[name] as unknown as { getMockImplementation: () => Read | undefined; mockImplementation: (fn: Read) => void }
  const original = mock.getMockImplementation()
  if (original === undefined) throw new Error(`${name} has no implementation to defer`)
  let open = true
  let releaseAll = (): void => {}
  const held = new Promise<void>(resolve => { releaseAll = resolve })
  mock.mockImplementation(async (...args: unknown[]) => {
    if (open) await held
    return await original(...args)
  })
  return { release: () => { open = false; releaseAll() } }
}

/** The shared loading box and its line, found by the words the face says. */
async function loadingBox(container: HTMLElement, text: string): Promise<{ box: HTMLElement; line: HTMLElement }> {
  const line = await waitFor(() => {
    const found = [...container.querySelectorAll('p')].find(node => node.textContent?.includes(text))
    expect(found, `no loading line reading “${text}”`).toBeTruthy()
    return found as HTMLElement
  })
  const box = line.closest('div')
  expect(box).toBeTruthy()
  return { box: box as HTMLElement, line }
}

describe('the whole-surface loading state', () => {
  // Every surface with nothing to show yet speaks through one shape: the same
  // box, the same pulse mark, and a sentence in the same 「正在加载…」 family. A
  // state drawn in another shape reads as a different kind of fact — which is
  // how the board's loading frame came to read like an already-empty board.

  it('renders the Inbox in the shared box with a pulse mark', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true })
    await b.view.findByRole('button', { name: '收件箱' })
    const held = gate(b, 'inbox')
    fireEvent.click(b.view.getByRole('button', { name: '收件箱' }))
    const { box, line } = await loadingBox(b.view.container, '正在加载收件箱…')
    expect(hasClass(box, 'emptySurface')).toBe(true)
    expect(hasClass(line, 'loadingState')).toBe(true)
    // The mark decorates a line that already says the words, so it must not be
    // announced a second time.
    expect(line.querySelector('span')?.getAttribute('aria-hidden')).toBe('true')
    held.release()
  })

  it('renders the global Task board in the shared box, with a pulse mark and the load verb', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true })
    await b.view.findByRole('button', { name: '任务看板' })
    const held = gate(b, 'loadTaskBoard')
    fireEvent.click(b.view.getByRole('button', { name: '任务看板' }))
    const surface = await waitFor(() => {
      const element = b.view.container.querySelector('[data-team-task-board]')
      expect(element).toBeTruthy()
      return element as HTMLElement
    })
    const { box, line } = await loadingBox(surface, '正在加载看板…')
    expect(hasClass(box, 'emptySurface')).toBe(true)
    expect(hasClass(line, 'loadingState')).toBe(true)
    // The board borrowed the empty state's own class, which is why its loading
    // frame read as 「this board is empty」 rather than 「still reading」.
    expect(hasClass(line, 'emptyState')).toBe(false)
    expect(line.querySelector('span')?.getAttribute('aria-hidden')).toBe('true')
    held.release()
  })

  it('renders the Project board tab in the shared box, not the empty one', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true })
    await b.view.findByRole('button', { name: '# engineering' })
    const held = gate(b, 'loadTaskBoard')
    fireEvent.click(b.view.getByRole('button', { name: '# engineering' }))
    await b.view.findByRole('tab', { name: '主对话' })
    fireEvent.click(b.view.getByRole('tab', { name: '看板' }))
    const { box, line } = await loadingBox(b.view.container, '正在加载看板…')
    expect(hasClass(box, 'emptySurface')).toBe(true)
    expect(hasClass(line, 'loadingState')).toBe(true)
    expect(hasClass(line, 'emptyState')).toBe(false)
    held.release()
  })

  it('names its own subject in the Main stream instead of borrowing the Projects sentence', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true })
    await b.view.findByRole('button', { name: '# engineering' })
    const held = gate(b, 'readMainStream')
    fireEvent.click(b.view.getByRole('button', { name: '# engineering' }))
    const { box, line } = await loadingBox(b.view.container, '正在加载主对话…')
    expect(hasClass(box, 'emptySurface')).toBe(true)
    expect(hasClass(line, 'loadingState')).toBe(true)
    // The defect: this feed loaded under 「正在加载项目…」, the Projects sentence,
    // because it had no key of its own. A reader waiting on one thing was told
    // a different one was loading.
    expect(within(b.view.container).queryByText('正在加载项目…')).toBeNull()
    held.release()
  })
})
