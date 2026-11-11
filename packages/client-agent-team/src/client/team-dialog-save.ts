import { useRef, useState } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { isUncertainRemoteFailure } from './requests.ts'

export function useEditDialogSave<Request>({ save, onCommitted, onClose }: {
  readonly save: (request: Request) => Promise<RemoteResult<unknown>>
  readonly onCommitted: () => Promise<void> | void
  readonly onClose: () => void
}): {
  readonly saving: boolean
  readonly error: string | undefined
  /** `build` receives the request retained only after an uncertain write, so an unchanged retry preserves its ID. */
  readonly save: (build: (previous: Request | undefined) => Request) => Promise<void>
  readonly invalidate: () => void
} {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const pendingRequest = useRef<Request>()
  const submit = async (build: (previous: Request | undefined) => Request): Promise<void> => {
    const request = build(pendingRequest.current)
    pendingRequest.current = request
    setSaving(true)
    setError(undefined)
    try {
      const result = await save(request)
      if (result.ok) {
        pendingRequest.current = undefined
        onClose()
        // The list owner catches and renders its refresh failure; it must not turn a confirmed write back into a form error.
        void onCommitted()
      } else {
        if (!isUncertainRemoteFailure(result.error)) pendingRequest.current = undefined
        setError(result.error.message)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  return {
    saving,
    error,
    save: submit,
    invalidate: () => { pendingRequest.current = undefined },
  }
}
