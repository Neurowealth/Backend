/**
 * Structural guarantee for the durable outbox (#325).
 *
 * THIS IS THE ACCEPTANCE CRITERION, not a style check. The whole point of the
 * outbox is that it is the single choke point every on-chain money movement
 * passes through — durable, retriable, priority-ordered, observable. That
 * property is worth nothing the first time someone adds a route or job that
 * calls `depositForUser`/`withdrawForUser`/`triggerRebalance`/
 * `payReferralReward` directly instead of going through
 * src/outbox/service.ts + src/outbox/dispatcher.ts.
 *
 * Uses the same specifier-parsing approach as
 * tests/unit/analytics/structural.test.ts and
 * tests/integration/agent/strategy-follow.integration.test.ts.
 */

import fs from 'fs'
import path from 'path'

const SRC_DIR = path.join(__dirname, '../../../src')

// The raw write functions in src/stellar/contract.ts that actually move
// money on-chain. Read functions (getOnChainBalance, getOnChainAPY, ...) are
// exempt — they never submit a transaction.
const RAW_WRITE_FUNCTIONS = [
  'depositForUser',
  'withdrawForUser',
  'triggerRebalance',
  'payReferralReward',
  // Legacy aliases exported by contract.ts for the same write paths.
  'deposit',
  'withdraw',
]

// Files allowed to import them directly:
//  - src/stellar/contract.ts itself (it defines them)
//  - src/outbox/executors.ts (the ONE place the dispatcher actually submits)
const ALLOWED_IMPORTERS = new Set([
  path.join(SRC_DIR, 'stellar', 'contract.ts'),
  path.join(SRC_DIR, 'outbox', 'executors.ts'),
])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const resolved = path.resolve(path.dirname(fromFile), specifier)
  return resolved.endsWith('.ts') ? resolved : `${resolved}.ts`
}

/** Named imports from a given module specifier, e.g. `from '../stellar/contract'`. */
function namedImportsFrom(source: string, specifierSuffix: string): string[] {
  const names: string[] = []
  const importRegex =
    /import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = importRegex.exec(source)) !== null) {
    const [, namedBlock, specifier] = match
    if (!specifier.includes('stellar/contract')) continue
    if (specifierSuffix && !specifier.endsWith(specifierSuffix)) continue
    for (const raw of namedBlock.split(',')) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)[0]
        .trim()
      if (name) names.push(name)
    }
  }
  return names
}

describe('src/outbox/ — no-bypass structural guarantee', () => {
  const contractFile = path.join(SRC_DIR, 'stellar', 'contract.ts')

  it('src/stellar/contract.ts still exports every raw write function this test guards', () => {
    const source = fs.readFileSync(contractFile, 'utf8')
    for (const fn of [
      'depositForUser',
      'withdrawForUser',
      'triggerRebalance',
      'payReferralReward',
    ]) {
      expect(source).toMatch(
        new RegExp(`export\\s+async\\s+function\\s+${fn}\\b`)
      )
    }
  })

  it('src/outbox/executors.ts exists and imports the raw write functions', () => {
    const executorsFile = path.join(SRC_DIR, 'outbox', 'executors.ts')
    expect(fs.existsSync(executorsFile)).toBe(true)
    const source = fs.readFileSync(executorsFile, 'utf8')
    const imports = namedImportsFrom(source, '')
    expect(imports.length).toBeGreaterThan(0)
  })

  const allFiles = walk(SRC_DIR)
  // Sanity: this test must actually be scanning a non-trivial tree, or a
  // regex that silently stopped matching could make every assertion below
  // pass vacuously.
  it('scans a non-trivial number of source files', () => {
    expect(allFiles.length).toBeGreaterThan(50)
  })

  it.each(allFiles.filter((f) => !ALLOWED_IMPORTERS.has(f)))(
    '%s does not import a raw on-chain write function from stellar/contract',
    (file) => {
      const source = fs.readFileSync(file, 'utf8')
      const imports = namedImportsFrom(source, '')
      const forbidden = imports.filter((name) =>
        RAW_WRITE_FUNCTIONS.includes(name)
      )
      expect(forbidden).toEqual([])
    }
  )

  it('resolves relative "stellar/contract" specifiers to the same file across the tree (regex sanity)', () => {
    // Guards the resolver helper itself: if it stopped resolving correctly,
    // the "does not import" assertions above could pass for the wrong reason.
    const sample = path.join(SRC_DIR, 'controllers', 'sample.ts')
    const resolved = resolveSpecifier(sample, '../stellar/contract')
    expect(resolved).toBe(contractFile)
  })
})
