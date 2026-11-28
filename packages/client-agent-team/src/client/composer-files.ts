import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent } from 'react'

export function useComposerFiles(pending: boolean, files: readonly File[] | undefined, onFilesChange: ((files: readonly File[]) => void) | undefined) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const [dropHover, setDropHover] = useState(false)

  const append = (added: readonly File[]): void => {
    if (files !== undefined && onFilesChange !== undefined && added.length > 0) onFilesChange([...files, ...added])
  }

  const onPickerChange = (event: ChangeEvent<HTMLInputElement>): void => {
    append([...event.target.files ?? []])
    event.target.value = ''
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (pending || onFilesChange === undefined || files === undefined) return
    const pasted = Array.from(event.clipboardData.items)
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null)
    // Only intercept a file paste; text still uses native caret insertion.
    if (pasted.length === 0) return
    event.preventDefault()
    append(pasted)
  }

  const acceptsDrop = (event: DragEvent<HTMLElement>): boolean =>
    onFilesChange !== undefined && files !== undefined && !pending && event.dataTransfer.types.includes('Files')

  const onDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    if (!acceptsDrop(event)) return
    event.preventDefault()
    // Child boundaries fire leave/enter too, although the drag is still inside the composer.
    dragDepth.current += 1
    setDropHover(true)
  }
  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!acceptsDrop(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (): void => {
    if (dragDepth.current === 0) return
    dragDepth.current -= 1
    if (dragDepth.current === 0) setDropHover(false)
  }
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!acceptsDrop(event)) return
    event.preventDefault()
    const dropped = [...event.dataTransfer.files]
    dragDepth.current = 0
    setDropHover(false)
    append(dropped)
  }

  // Drops beside the composer still need to cancel the browser's file navigation.
  useEffect(() => {
    if (onFilesChange === undefined || files === undefined) return undefined
    const guard = (event: globalThis.DragEvent): void => {
      if (event.dataTransfer?.types.includes('Files') === true) event.preventDefault()
    }
    document.addEventListener('dragover', guard)
    document.addEventListener('drop', guard)
    return () => {
      document.removeEventListener('dragover', guard)
      document.removeEventListener('drop', guard)
    }
  }, [onFilesChange, files])

  return { fileInputRef, dropHover, onPickerChange, onPaste, dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } }
}
