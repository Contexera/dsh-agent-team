import { useState } from 'react'

/**
 * What one avatar seat should draw.
 *
 * `image` carries decoded-looking bytes to paint; `initial` means the seat must
 * fall back to the name's initial, which is the case both when there is no URL
 * at all and when the bytes failed to decode.
 */
export type AvatarImage =
  | { readonly kind: 'image'; readonly src: string }
  | { readonly kind: 'initial' }

/** The seat's avatar decision plus the `<img>` fail signal that revises it. */
export interface AvatarImageSeat {
  readonly image: AvatarImage
  /** Attach to the `<img>`'s `onError`: these bytes do not decode. */
  readonly failed: () => void
}

/**
 * Whether one avatar URL actually draws.
 *
 * The Host accepts an avatar by declared media type — `sanitizeMediaType` only
 * checks the shape of `image/…` — so bytes the browser cannot decode are stored
 * and handed back as a data URL that renders nothing: a phone photo in HEIC, or
 * a payload damaged on the way in. The settings copy promises the initial back
 * in that case, so both avatar seats ask this hook instead of testing the URL
 * for `undefined`, which cannot tell a picture from a blank circle.
 *
 * The record is keyed by URL: bytes that already failed keep the fallback, and
 * a new upload retries on its own because its data URL differs.
 */
export function useAvatarImage(url: string | undefined): AvatarImageSeat {
  const [broken, setBroken] = useState<string | undefined>(undefined)
  return {
    image: url === undefined || url === broken ? { kind: 'initial' } : { kind: 'image', src: url },
    failed: () => { if (url !== undefined) setBroken(url) },
  }
}
