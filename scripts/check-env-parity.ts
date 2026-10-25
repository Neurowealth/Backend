/**
 * #497 — Environment parity CLI.
 *
 * Compares the tracked env files against .env.example so configuration drift
 * is caught during deployment review instead of at 3am. Exit codes:
 *   0 — no errors (warnings allowed; review them)
 *   1 — at least one environment is missing a core startup key
 *
 * Run directly:      npx ts-node scripts/check-env-parity.ts
 * Or via npm script: npm run env:parity
 */

import fs from 'node:fs'
import path from 'node:path'
import { checkEnvParity, formatParityReport } from '../src/config/envParity'

const ROOT = path.resolve(__dirname, '..')

const ENV_FILES = [
  '.env.example',
  '.env.development',
  '.env.production',
  '.env.test',
]

const files: Record<string, string> = {}
for (const name of ENV_FILES) {
  const filePath = path.join(ROOT, name)
  files[name] = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf-8')
    : ''
}

const issues = checkEnvParity(files)
console.log(formatParityReport(issues))

const hasErrors = issues.some((i) => i.severity === 'error')
if (hasErrors) {
  process.exit(1)
}
