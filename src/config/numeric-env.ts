/**
 * Numeric environment variable parsing with startup validation (#789).
 *
 * Bare `parseInt`/`parseFloat` silently produce `NaN` for typos, and `NaN`
 * compares false against every bound. A typo such as
 * `REFERRAL_MIN_ACTIVATION_DEPOSIT=ten` therefore disabled money-affecting
 * guards instead of failing at boot. This helper parses a numeric env var once
 * and rejects non-finite or out-of-range values with an error that names the
 * offending variable, so misconfiguration fails fast and loudly.
 */

export interface NumericEnvOptions {
  /** Reject values that are not whole numbers (used for counts, ports, ms). */
  integer?: boolean
  /** Inclusive lower bound. */
  min?: number
  /** Inclusive upper bound. */
  max?: number
}

function coerceFallback(key: string, fallback: number | string): number {
  const value = typeof fallback === 'string' ? Number(fallback) : fallback
  if (!Number.isFinite(value)) {
    // The fallback is a code literal, not operator input; a bad one is a bug.
    throw new Error(
      `Invalid default for numeric environment variable ${key}: ${String(
        fallback
      )} is not a finite number`
    )
  }
  return value
}

/**
 * Parse `process.env[key]` as a validated number.
 *
 * - Unset or empty string falls back to `fallback`.
 * - Otherwise a strict `Number()` parse is used, so values like `"10abc"` are
 *   rejected rather than silently truncated to `10`.
 * - `NaN`/`Infinity` are always rejected.
 * - `integer`, `min`, and `max` are enforced when supplied.
 */
export function parseNumericEnv(
  key: string,
  fallback: number | string,
  options: NumericEnvOptions = {}
): number {
  const raw = process.env[key]
  const value =
    raw === undefined || raw.trim() === ''
      ? coerceFallback(key, fallback)
      : Number(raw)

  if (!Number.isFinite(value)) {
    throw new Error(
      `Invalid numeric environment variable ${key}="${String(
        raw
      )}": expected a finite number`
    )
  }
  if (options.integer && !Number.isInteger(value)) {
    throw new Error(
      `Invalid numeric environment variable ${key}="${String(
        raw
      )}": expected an integer`
    )
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(
      `Invalid numeric environment variable ${key}="${String(
        raw
      )}": must be greater than or equal to ${options.min}`
    )
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(
      `Invalid numeric environment variable ${key}="${String(
        raw
      )}": must be less than or equal to ${options.max}`
    )
  }

  return value
}
