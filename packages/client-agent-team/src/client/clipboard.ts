import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Copy text on the browser's terms, then on the document's.
 *
 * The shipped helper falls back to `execCommand('copy')` only when a host omits the async API; a host that carries the
 * API but refuses the write (a clipboard policy, an unfocused document, a remote browser) leaves the reader with
 * nothing and no word about it. That refusal is the one refusal this page can still answer itself, so the legacy path
 * gets one turn before the card reports failure.
 * @param text - The exact text to place on the clipboard.
 * @returns Whether any path placed it there.
 */
export async function copyText(text: string): Promise<boolean> {
  if (await writeClipboard(text)) return true
  return legacyCopy(text)
}

/** `execCommand('copy')` still lands where the async API is refused; it is the deprecated path, deliberately kept. */
function legacyCopy(text: string): boolean {
  /* oxlint-disable typescript/no-deprecated */
  if (typeof document.execCommand !== 'function') return false
  const selection = document.createElement('textarea')
  selection.value = text
  selection.setAttribute('readonly', '')
  selection.style.position = 'fixed'
  selection.style.left = '-9999px'
  document.body.appendChild(selection)
  selection.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    selection.remove()
  }
  /* oxlint-enable typescript/no-deprecated */
}
