import { useState } from 'react'

/** `initial` means fall back to the name's initial: no URL, or the bytes failed to decode. */
export type AvatarImage =
  | { readonly kind: 'image'; readonly src: string }
  | { readonly kind: 'initial' }

export interface AvatarImageSeat {
  readonly image: AvatarImage
  readonly failed: () => void
}

/**
 * Whether one avatar URL actually draws. The Host accepts an avatar by declared media type only, so undecodable bytes (HEIC,
 * damaged payloads) come back as a data URL that renders nothing; testing for `undefined` cannot tell that from a picture.
 * The record is keyed by URL, so a new upload retries on its own.
 */
export function useAvatarImage(url: string | undefined): AvatarImageSeat {
  const [broken, setBroken] = useState<string | undefined>(undefined)
  return {
    image: url === undefined || url === broken ? { kind: 'initial' } : { kind: 'image', src: url },
    failed: () => { if (url !== undefined) setBroken(url) },
  }
}
