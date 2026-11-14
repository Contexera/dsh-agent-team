import { fireEvent, type RenderResult } from '@testing-library/react'

export type TeamView = Pick<RenderResult, 'getByRole' | 'findByRole'>

/** Opens the composer's thread-start mode; the next send creates a Thread instead of a Main stream message. */
export function pressStartThread(view: Pick<RenderResult, 'getByRole'>): void {
  fireEvent.click(view.getByRole('button', { name: '讨论/任务' }))
}

/** Thread-start mode with the Task box checked: the next send creates a Task. */
export function pressStartTask(view: Pick<RenderResult, 'getByRole'>): void {
  pressStartThread(view)
  fireEvent.click(view.getByRole('checkbox', { name: '作为任务' }))
}

/** Opens the Team mode toggle in the sidebar. */
export async function openTeam(view: TeamView): Promise<void> {
  fireEvent.click(await view.findByRole('button', { name: 'Team' }))
}

/** Opens a Project row in the Team sidebar by name. */
export async function openProject(view: TeamView, name = 'engineering'): Promise<void> {
  fireEvent.click(await view.findByRole('button', { name: new RegExp(`^#?\\s*${name}$`) }))
}

/** Opens a Task card by task number or accessible button name. */
export async function openTask(view: TeamView, target: number | string = 1): Promise<void> {
  const name = typeof target === 'number' ? `打开 Task #${target}` : target
  fireEvent.click(await view.findByRole('button', { name }))
}
