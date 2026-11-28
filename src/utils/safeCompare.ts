import { createHash, timingSafeEqual } from 'crypto'

/**
 * Constant-time string equality check for shared secrets/tokens.
 * Hashes both inputs to fixed-length digests before comparison to avoid
 * leaking length or content timing information.
 */
export function safeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false

  const digestA = createHash('sha256').update(a, 'utf8').digest()
  const digestB = createHash('sha256').update(b, 'utf8').digest()

  return timingSafeEqual(digestA, digestB)
}
