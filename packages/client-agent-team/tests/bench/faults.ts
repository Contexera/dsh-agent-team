import type { Mock } from 'vitest'

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Make the next call to a remote mock fail with a structured Remote-style error. */
export function failNext<TArgs extends unknown[], TResult>(
  fn: Mock<(...args: TArgs) => Promise<TResult>>,
  message: string,
): void {
  fn.mockResolvedValueOnce({ ok: false as const, error: { message } } as Awaited<TResult>)
}

/** Hold the next call to a remote mock until the returned handle resolves or rejects it. */
export function holdNext<TArgs extends unknown[], TResult>(
  fn: Mock<(...args: TArgs) => Promise<TResult>>,
): Deferred<TResult> {
  const deferred = createDeferred<TResult>()
  fn.mockImplementationOnce(() => deferred.promise)
  return deferred
}
