/**
 * Environment parity core (#497).
 *
 * The runtime half of configuration safety lives in src/config/env.ts: it
 * validates required vars (and their shapes) once at module load, so a
 * misconfigured process refuses to boot. This module is the deployment-review
 * half: it compares the *sets of keys* across the tracked environment files
 * (.env.example / .env.development / .env.production / .env.test) so drift is
 * caught in a pull request — before it can reach a deploy.
 *
 * Deliberately pure: callers hand in file contents as strings, so the same
 * logic serves the CLI (scripts/check-env-parity.ts), the unit tests, and CI.
 */

/** Keys src/config/env.ts requires at startup — a missing one aborts boot. */
export const CORE_REQUIRED_KEYS = [
  'STELLAR_NETWORK',
  'STELLAR_AGENT_SECRET_KEY',
  'VAULT_CONTRACT_ID',
  'USDC_TOKEN_ADDRESS',
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
  'JWT_SEED',
  'WALLET_ENCRYPTION_KEY',
  'TWILIO_AUTH_TOKEN',
  'NODE_ENV',
] as const

/** The canonical file every environment is compared against. */
export const BASELINE_FILE = '.env.example'

export type EnvParityIssueKind =
  | 'missing-core-key'
  | 'missing-baseline-key'
  | 'undocumented-key'
  | 'database-url-mismatch'

export interface EnvParityIssue {
  file: string
  key: string
  kind: EnvParityIssueKind
  severity: 'error' | 'warning'
  message: string
}

/**
 * Extract the variable names defined in an env-file body.
 *
 * Handles the artifacts these files actually contain: full-line comments,
 * blank lines, surrounding whitespace, and (historically) stray markdown
 * code fences — any line without a `=` separator cannot define a variable
 * and is ignored, matching dotenv's own behavior.
 */
export function parseEnvKeys(content: string): string[] {
  const keys: string[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const key = line.slice(0, line.indexOf('=')).trim()
    if (key) keys.push(key)
  }
  return keys
}

/**
 * Compare a set of env files against the baseline.
 *
 * Severity model:
 *  - error   → a core startup key is absent. The process would refuse to
 *              boot with this file; CI fails on any error.
 *  - warning → the file drifted from the baseline in a way that does not
 *              break boot (a documented-but-absent key, or an env-only key
 *              nobody documented). Informational: some drift is intentional
 *              (e.g. .env.test is hermetic and minimal by design).
 */
export function checkEnvParity(
  files: Record<string, string>,
  baseline: string = BASELINE_FILE
): EnvParityIssue[] {
  const issues: EnvParityIssue[] = []
  const baselineKeys = new Set(parseEnvKeys(files[baseline] ?? ''))
  const coreKeys = new Set<string>(CORE_REQUIRED_KEYS)

  for (const [file, content] of Object.entries(files)) {
    if (file === baseline) continue
    const keys = new Set(parseEnvKeys(content))

    for (const key of CORE_REQUIRED_KEYS) {
      if (!keys.has(key)) {
        issues.push({
          file,
          key,
          kind: 'missing-core-key',
          severity: 'error',
          message: `${file}: core startup key "${key}" is missing — the process would fail to boot with this configuration`,
        })
      }
    }

    for (const key of baselineKeys) {
      if (key.startsWith('#') || key === '') continue
      if (!keys.has(key)) {
        issues.push({
          file,
          key,
          kind: 'missing-baseline-key',
          severity: 'warning',
          message: `${file}: "${key}" is documented in ${baseline} but absent here — if intentional, note why in the PR or docs`,
        })
      }
    }

    for (const key of keys) {
      if (!baselineKeys.has(key)) {
        issues.push({
          file,
          key,
          kind: 'undocumented-key',
          severity: 'warning',
          message: `${file}: "${key}" is not documented in ${baseline} — add it there so other environments can adopt it`,
        })
      }
    }
  }

  return issues
}

/**
 * Parse an env-file body into key/value pairs.
 *
 * Unlike `parseEnvKeys`, this keeps values so the DATABASE_URL can be compared
 * against the individual DB_* keys in the same file. Quotes around a value are
 * stripped (dotenv does the same); comments and malformed lines are ignored.
 */
export function parseEnvValues(content: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const separator = line.indexOf('=')
    const key = line.slice(0, separator).trim()
    if (!key) continue
    let value = line.slice(separator + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  return values
}

interface PostgresUrlParts {
  user: string
  password: string
  host: string
  port: string
  database: string
}

/**
 * Break a PostgreSQL connection URL into the parts that must agree with the
 * individual DB_* variables. Returns null when the value is not a parseable
 * postgres URL, so callers can skip the comparison rather than false-alarm.
 */
function parsePostgresUrl(raw: string): PostgresUrlParts | null {
  if (!/^postgres(ql)?:\/\//i.test(raw)) return null
  try {
    const url = new URL(raw)
    const decode = (value: string) => {
      try {
        return decodeURIComponent(value)
      } catch {
        return value
      }
    }
    return {
      user: decode(url.username),
      password: decode(url.password),
      host: url.hostname,
      // WHATWG URL leaves port empty when it is omitted. Default to 5432 so a
      // URL without an explicit port still agrees with DB_PORT=5432.
      port: url.port || '5432',
      database: decode(url.pathname.replace(/^\//, '')),
    }
  } catch {
    return null
  }
}

/**
 * Check that DATABASE_URL agrees with the DB_* variables in every env file
 * that defines both (#800). A mismatch means following the quickstart with
 * that file authenticates against a different role/database than the one the
 * DB_* variables describe, which is exactly the failure the issue reports.
 *
 * Files without DB_* variables (for example the hermetic .env.test) cannot be
 * compared and are skipped. Each mismatched component is a separate error so
 * CI output says precisely what to fix.
 */
export function checkDatabaseUrlConsistency(
  files: Record<string, string>
): EnvParityIssue[] {
  const issues: EnvParityIssue[] = []
  const comparisons: Array<{
    key: string
    label: string
    fromUrl: (parts: PostgresUrlParts) => string
  }> = [
    { key: 'DB_USER', label: 'user', fromUrl: (p) => p.user },
    { key: 'DB_PASSWORD', label: 'password', fromUrl: (p) => p.password },
    { key: 'DB_HOST', label: 'host', fromUrl: (p) => p.host },
    { key: 'DB_PORT', label: 'port', fromUrl: (p) => p.port },
    { key: 'DB_NAME', label: 'database', fromUrl: (p) => p.database },
  ]

  for (const [file, content] of Object.entries(files)) {
    const values = parseEnvValues(content)
    const rawUrl = values.DATABASE_URL
    if (!rawUrl) continue
    const parts = parsePostgresUrl(rawUrl)
    if (!parts) continue

    for (const comparison of comparisons) {
      const expected = values[comparison.key]
      // No DB_* counterpart in this file means there is nothing to compare.
      if (expected === undefined) continue
      const actual = comparison.fromUrl(parts)
      if (expected !== actual) {
        issues.push({
          file,
          key: comparison.key,
          kind: 'database-url-mismatch',
          severity: 'error',
          message: `${file}: DATABASE_URL ${comparison.label} "${actual}" does not match ${comparison.key} "${expected}" — align them so the quickstart authenticates correctly`,
        })
      }
    }
  }

  return issues
}

/** Render a human-readable report for CI logs and local runs. */
export function formatParityReport(issues: EnvParityIssue[]): string {
  if (issues.length === 0) {
    return 'Environment parity: OK — no drift detected.'
  }
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')
  const lines = [
    `Environment parity: ${errors.length} error(s), ${warnings.length} warning(s)`,
    ...issues.map((i) => `  [${i.severity.toUpperCase()}] ${i.message}`),
  ]
  return lines.join('\n')
}
