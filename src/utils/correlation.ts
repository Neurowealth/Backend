import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

const correlationStorage = new AsyncLocalStorage<string>()

/** Max length for client-supplied request IDs. */
export const MAX_CORRELATION_ID_LENGTH = 128

/** UUID v4 or common request-id tokens (alphanumeric, hyphen, underscore). */
const VALID_CORRELATION_ID = /^[A-Za-z0-9_-]{1,128}$/

export function generateCorrelationId(): string {
  return randomUUID()
}

export function isValidCorrelationId(value: string): boolean {
  return (
    VALID_CORRELATION_ID.test(value) &&
    value.length <= MAX_CORRELATION_ID_LENGTH
  )
}

export function resolveCorrelationId(
  headers: Record<string, string | string[] | undefined>
): string {
  const raw =
    headers['x-request-id'] ??
    headers['x-correlation-id'] ??
    headers['X-Request-ID'] ??
    headers['X-Correlation-ID']

  const candidate = Array.isArray(raw) ? raw[0] : raw
  if (candidate && isValidCorrelationId(candidate.trim())) {
    return candidate.trim()
  }

  return generateCorrelationId()
}

export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore()
}

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return correlationStorage.run(correlationId, fn)
}

export async function runWithCorrelationIdAsync<T>(
  correlationId: string,
  fn: () => Promise<T>
): Promise<T> {
  return correlationStorage.run(correlationId, fn)
}
