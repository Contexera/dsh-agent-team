import { useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

export function useEditDialogSave<Request>({ save, onCommitted, onClose }: {
  readonly save: (request: Request) => Promise<RemoteResult<unknown>>
  readonly onCommitted: () => Promise<void> | void
  readonly onClose: () => void
}): {
  readonly saving: boolean
  readonly error: string | undefined
  readonly pendingRequest: MutableRefObject<Request | undefined>
  readonly save: (request: Request) => Promise<void>
} {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const pendingRequest = useRef<Request>()
  const submit = async (request: Request): Promise<void> => {
    pendingRequest.current = request
    setSaving(true)
    setError(undefined)
    try {
      const result = await save(request)
      if (result.ok) {
        pendingRequest.current = undefined
        await onCommitted()
        onClose()
      } else {
        setError(result.error.message)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  return { saving, error, pendingRequest, save: submit }
}
