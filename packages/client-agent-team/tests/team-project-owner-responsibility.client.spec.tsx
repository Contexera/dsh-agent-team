// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

async function openOwners() {
  const b = await runtimeWithTeam({ initialProjects: true })
  fireEvent.click(b.view.getByRole('button', { name: '团队' }))
  expect(await b.view.findByText('# engineering')).toBeTruthy()
  fireEvent.click(b.view.getByRole('button', { name: 'engineering 的操作' }))
  fireEvent.click(await b.view.findByRole('menuitem', { name: '编辑项目' }))
  const editor = b.view.getByRole('dialog', { name: '编辑项目' })
  return { b, editor, owners: await within(editor).findByRole('group', { name: '负责人' }) }
}

/** Grant an Agent owner through the UI, with the text typed beside the add control when one is given. */
async function grant(b: Awaited<ReturnType<typeof runtimeWithTeam>>, owners: HTMLElement, responsibility?: string): Promise<void> {
  if (responsibility !== undefined) {
    fireEvent.change(within(owners).getByLabelText('新负责人的责任（可留空）'), { target: { value: responsibility } })
  }
  fireEvent.click(within(owners).getByRole('button', { name: '添加负责人 @builder' }))
  await within(owners).findByRole('button', { name: '移除负责人 @builder' })
}

describe('Project owner responsibility', () => {
  it('carries the text typed beside the add control into the grant', async () => {
    const { b, owners } = await openOwners()
    await grant(b, owners, '负责 Host 与账本')
    expect(b.addProjectOwner).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'w1', projectRef: 'project:engineering', memberId: 'member:builder', responsibility: '负责 Host 与账本',
    }))
    // The text comes back from the refreshed projection, not from the draft that was typed.
    const row = await within(owners).findByText('负责 Host 与账本')
    expect(row).toBeTruthy()
    // The grant consumed the draft, so the next one starts blank instead of inheriting this text.
    expect((within(owners).getByLabelText('新负责人的责任（可留空）') as HTMLInputElement).value).toBe('')
    fireEvent.keyDown(document, { key: 'Escape' })
    await b.runtime.dispose()
  })

  it('reads a grant recorded without text as unspecified instead of a fault to repair', async () => {
    const { b, owners } = await openOwners()
    await grant(b, owners)
    expect(b.addProjectOwner).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'member:builder' }))
    expect(b.addProjectOwner.mock.calls[0]![0].responsibility).toBe('')
    const line = await within(owners).findByText('未说明')
    // Unspecified is the ordinary reading of a grant that carries no text, so it is stated plainly and the seat
    // still offers the way to record one.
    expect(line.closest('[data-team-project-owner-responsibility="member:builder"]')).toBeTruthy()
    expect(within(owners).getByRole('button', { name: '编辑 @builder 的责任' })).toBeTruthy()
    // The Human owns every Project and has no responsibility to describe, so that seat carries no such control.
    expect(within(owners).queryByRole('button', { name: '编辑 @human 的责任' })).toBeNull()
    expect(owners.querySelector('[data-team-project-owner-responsibility="member:human"]')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await b.runtime.dispose()
  })

  it('records the text through the edit form and shows what the Host stored', async () => {
    const { b, owners } = await openOwners()
    await grant(b, owners)
    fireEvent.click(within(owners).getByRole('button', { name: '编辑 @builder 的责任' }))
    const field = within(owners).getByLabelText('@builder 的责任') as HTMLTextAreaElement
    // The form opens on what is recorded, which here is nothing.
    expect(field.value).toBe('')
    fireEvent.change(field, { target: { value: '负责 Host 与账本' } })
    fireEvent.click(within(owners).getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(b.updateProjectOwner).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'w1', projectRef: 'project:engineering', memberId: 'member:builder',
      responsibility: '负责 Host 与账本', requestId: expect.any(String),
    })) })
    // A committed edit rides the projection refresh: the form closes and the stored text stands in its place.
    expect(await within(owners).findByText('负责 Host 与账本')).toBeTruthy()
    expect(within(owners).queryByLabelText('@builder 的责任')).toBeNull()
    // Replacing the text never re-grants: the seat stays an owner throughout.
    expect(b.addProjectOwner).toHaveBeenCalledTimes(1)
    expect(b.removeProjectOwner).not.toHaveBeenCalled()
    expect(within(owners).getByRole('button', { name: '移除负责人 @builder' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await b.runtime.dispose()
  })

  it('cancels an edit without writing to the Host', async () => {
    const { b, owners } = await openOwners()
    await grant(b, owners, '负责 Host 与账本')
    fireEvent.click(within(owners).getByRole('button', { name: '编辑 @builder 的责任' }))
    const field = within(owners).getByLabelText('@builder 的责任') as HTMLTextAreaElement
    expect(field.value).toBe('负责 Host 与账本')
    fireEvent.change(field, { target: { value: '丢掉的草稿' } })
    fireEvent.click(within(owners).getByRole('button', { name: '取消' }))
    expect(within(owners).queryByLabelText('@builder 的责任')).toBeNull()
    expect(within(owners).getByText('负责 Host 与账本')).toBeTruthy()
    expect(b.updateProjectOwner).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    await b.runtime.dispose()
  })

  it('clears a recorded responsibility by submitting blank text', async () => {
    const { b, owners } = await openOwners()
    await grant(b, owners, '负责 Host 与账本')
    fireEvent.click(within(owners).getByRole('button', { name: '编辑 @builder 的责任' }))
    fireEvent.change(within(owners).getByLabelText('@builder 的责任'), { target: { value: '   ' } })
    fireEvent.click(within(owners).getByRole('button', { name: '保存' }))
    // Blank is a real instruction — clear the text — so it goes to the Host as an empty value rather than a no-op.
    await waitFor(() => { expect(b.updateProjectOwner).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'member:builder', responsibility: '   ' })) })
    expect(await within(owners).findByText('未说明')).toBeTruthy()
    expect(within(owners).getByRole('button', { name: '移除负责人 @builder' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await b.runtime.dispose()
  })

  it('keeps a refused write visible and leaves the recorded text standing', async () => {
    const { b, owners } = await openOwners()
    await grant(b, owners, '负责 Host 与账本')
    b.failProjectOwnerWrite('Project owner responsibility write refused')
    fireEvent.click(within(owners).getByRole('button', { name: '编辑 @builder 的责任' }))
    fireEvent.change(within(owners).getByLabelText('@builder 的责任'), { target: { value: '没写进去' } })
    fireEvent.click(within(owners).getByRole('button', { name: '保存' }))
    expect((await within(owners).findByRole('alert')).textContent).toBe('Project owner responsibility write refused')
    // The form stays open on the draft so the Human can retry, and the projection still holds the old text.
    expect((within(owners).getByLabelText('@builder 的责任') as HTMLTextAreaElement).value).toBe('没写进去')
    expect((within(owners).getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.keyDown(document, { key: 'Escape' })
    await b.runtime.dispose()
  })

  it('moves focus into the field on open and back to the row control on close', async () => {
    const { b, owners } = await openOwners()
    await grant(b, owners, '负责 Host 与账本')
    const edit = within(owners).getByRole('button', { name: '编辑 @builder 的责任' })
    edit.focus()
    fireEvent.click(edit)
    // The form replaced the control that opened it, so the field holds the focus instead of the body.
    expect(document.activeElement).toBe(within(owners).getByLabelText('@builder 的责任'))
    fireEvent.click(within(owners).getByRole('button', { name: '取消' }))
    expect(document.activeElement).toBe(within(owners).getByRole('button', { name: '编辑 @builder 的责任' }))

    // A committed edit returns it the same way, once the refresh leaves the row interactive again.
    fireEvent.click(within(owners).getByRole('button', { name: '编辑 @builder 的责任' }))
    expect(document.activeElement).toBe(within(owners).getByLabelText('@builder 的责任'))
    fireEvent.change(within(owners).getByLabelText('@builder 的责任'), { target: { value: '负责 Host、账本与验收' } })
    fireEvent.click(within(owners).getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(document.activeElement).toBe(within(owners).getByRole('button', { name: '编辑 @builder 的责任' }))
    })
    expect(await within(owners).findByText('负责 Host、账本与验收')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await b.runtime.dispose()
  })
})
