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
  'missing-core-key' | 'missing-baseline-key' | 'undocumented-key'

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
