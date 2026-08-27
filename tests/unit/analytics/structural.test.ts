/**
 * Structural guarantees for src/analytics/ (#322).
 *
 * THIS IS THE ACCEPTANCE CRITERION, not a style check. The whole safety story of
 * the optimization feature is that a suggestion is ADVISORY: it can be computed,
 * stored and displayed, and it structurally cannot move funds or silently
 * rewrite the configuration the agent acts on. A comment saying so is worth
 * nothing the first time someone adds a convenient `db.user.update`.
 *
 * The import assertions use the stricter specifier-parsing form from
 * tests/integration/agent/strategy-follow.integration.test.ts rather than a bare
 * substring scan, and assert `imports.length > 0` so a regex that silently
 * stops matching cannot let the test pass vacuously.
 */

import fs from 'fs'
import path from 'path'

const ANALYTICS_DIR = path.join(__dirname, '../../../src/analytics')

const FILES = ['types.ts', 'optimizer.ts', 'estimation.ts', 'service.ts']

function read(file: string): string {
  return fs.readFileSync(path.join(ANALYTICS_DIR, file), 'utf8')
}

function importsOf(source: string): string[] {
  return Array.from(source.matchAll(/from\s+['"]([^'"]+)['"]/g), (m) => m[1])
}

/**
 * Strip block and line comments before scanning for forbidden CODE.
 *
 * These files document the very invariants asserted below, so their headers
 * legitimately contain the strings the assertions forbid — the first version of
 * this test failed on service.ts's own comment explaining that it must never
 * call `user.update`. Scanning prose would either force the docs to be vague
 * about what is banned, or force the test to be lenient. Stripping comments
 * keeps both precise.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('src/analytics/ — custody boundary', () => {
  it('every analytics file exists', () => {
    for (const file of FILES) {
      expect(fs.existsSync(path.join(ANALYTICS_DIR, file))).toBe(true)
    }
  })

  it.each(FILES)(
    '%s imports nothing from src/stellar/ and no wallet',
    (file) => {
      const source = read(file)
      const imports = importsOf(source)

      // Guards against a regex that stopped matching: a file with zero parsed
      // imports would pass every filter below for the wrong reason. types.ts is
      // the one file that legitimately has none.
      if (file !== 'types.ts') {
        expect(imports.length).toBeGreaterThan(0)
      }

      expect(imports.filter((i) => i.includes('stellar'))).toEqual([])
      expect(imports.filter((i) => i.includes('wallet'))).toEqual([])
    }
  )

  it.each(['types.ts', 'optimizer.ts', 'estimation.ts'])(
    '%s is pure — no database import at all',
    (file) => {
      const imports = importsOf(read(file))
      expect(imports.filter((i) => /\/db$|\/db\//.test(i))).toEqual([])
    }
  )

  it('optimizer.ts and estimation.ts contain no Prisma model access', () => {
    for (const file of ['optimizer.ts', 'estimation.ts']) {
      const source = read(file)
      expect(source).not.toMatch(/\bdb\.\w+\./)
      expect(source).not.toMatch(/prisma/i)
    }
  })
})

describe('src/analytics/service.ts — the advisory invariant', () => {
  const source = stripComments(read('service.ts'))

  it('never writes to the User model', () => {
    // db.user.update / updateMany / upsert / delete — any of these could change
    // what the agent does on its next tick.
    expect(source).not.toMatch(/user\s*\.\s*(update|upsert|delete|create)/i)
  })

  it('never mentions strategyConfig as an assignment target', () => {
    // Reading User.strategyConfig is required (it is an optimizer input);
    // WRITING it is what must never happen. A `select` is a read.
    const writeShapes = [
      /strategyConfig\s*:/, // object literal in a `data:` payload
      /rebalanceStrategy\s*:/,
    ]
    // The only permitted occurrence is inside a `select:` clause, so strip
    // those before asserting.
    const withoutSelects = source.replace(
      /select:\s*\{[^}]*\}/g,
      'select:{STRIPPED}'
    )
    for (const shape of writeShapes) {
      expect(withoutSelects).not.toMatch(shape)
    }
  })

  it('the only model it creates rows in is allocationSuggestion', () => {
    const creates = Array.from(
      source.matchAll(/db\.(\w+)\.(create|update|upsert|delete)\w*/g),
      (m) => `${m[1]}.${m[2]}`
    )
    expect(creates).toEqual(['allocationSuggestion.create'])
  })

  it('reads only the models an optimizer input needs', () => {
    const reads = Array.from(
      source.matchAll(/db\.(\w+)\./g),
      (m) => m[1]
    ).filter((v, i, a) => a.indexOf(v) === i)

    expect(reads.sort()).toEqual(
      [
        'allocationSuggestion',
        'position',
        'protocolRate',
        'protocolRiskScore',
        'savingsGoal',
        'strategyFollow',
        'user',
      ].sort()
    )
  })
})

describe('src/jobs/allocationSuggestions.ts — the advisory invariant holds on the timer too', () => {
  const raw = fs.readFileSync(
    path.join(__dirname, '../../../src/jobs/allocationSuggestions.ts'),
    'utf8'
  )
  const source = stripComments(raw)

  it('imports nothing from src/stellar/ and no wallet', () => {
    const imports = importsOf(raw)
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.filter((i) => i.includes('stellar'))).toEqual([])
    expect(imports.filter((i) => i.includes('wallet'))).toEqual([])
  })

  it('never writes to the User model', () => {
    // A precompute job that rewrote strategy configs on a 6-hour timer would be
    // an autonomous trading system, not an analytics job.
    expect(source).not.toMatch(/user\s*\.\s*(update|upsert|delete|create)/i)
    expect(source).not.toMatch(/strategyConfig\s*:/)
  })
})
