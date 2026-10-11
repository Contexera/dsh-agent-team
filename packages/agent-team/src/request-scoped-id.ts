import { createHash } from 'node:crypto'

/**
 * A uuid-shaped id derived from one request, in one namespace.
 *
 * Request-stable rather than fresh, so an exact retry restates the id the
 * first attempt wrote and resolves against it instead of minting a second
 * one, while a different payload for that id is caught by whatever comparison
 * owns the record. Pure and namespaced, so it is restart-safe without a second
 * durable store or an in-memory map.
 *
 * The digest is what keeps caller-controlled text out of a durable name: the
 * request id is hashed, never embedded, so nothing a caller wrote reaches a
 * directory name, a log path, or a UI row — and no escaping is involved.
 */
export function requestScopedUuid(namespace: string, requestId: string, scope?: string): string {
  const uuid = createHash('sha256')
    .update(`agent-team:${namespace}:${requestId}${scope === undefined ? '' : `#${scope}`}`)
    .digest()
    .subarray(0, 16)
  const shaped = Buffer.from(uuid)
  // Present the digest as an ordinary uuid so directory names keep the shape
  // a fresh `randomUUID()` produces: version 4, RFC 4122 variant bits.
  shaped[6] = (shaped[6]! & 0x0f) | 0x40
  shaped[8] = (shaped[8]! & 0x3f) | 0x80
  const hex = shaped.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
