import { createHash } from 'node:crypto'

/** A uuid-shaped id derived from one request in one namespace. The request id is hashed, never embedded, so caller text never reaches a directory name, log path, or UI row. */
export function stableRequestUuid(namespace: string, requestId: string, scope?: string): string {
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
