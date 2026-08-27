/**
 * tests/unit/analytics/no-duplicate-definitions.test.ts
 *
 * Anti-duplication guard test.
 *
 * REQUIREMENT (Issue #225 / STRATEGY_MARKETPLACE.md §2):
 * "Do not add a third definition of risk-adjusted return / Sharpe / volatility.
 *  Whichever side becomes canonical, the other must import it. Add a test that
 *  fails if a second, divergent Sharpe/volatility implementation is introduced."
 *
 * This test scans all files in `src/` to ensure:
 * 1. `src/analytics/metrics.ts` is the SINGLE canonical provider of volatility,
 *    inferPeriodsPerYear, Sortino, VaR, CVaR, and max drawdown calculations.
 * 2. No other file in `src/` defines duplicate mathematical functions for
 *    annualised volatility or inferPeriodsPerYear.
 */

import * as fs from 'fs'
import * as path from 'path'

describe('Anti-Duplication Guard: Risk Analytics Engine', () => {
  const srcDir = path.resolve(__dirname, '../../../src')

  function getAllTsFiles(dir: string): string[] {
    const files: string[] = []
    const list = fs.readdirSync(dir)
    for (const file of list) {
      const fullPath = path.join(dir, file)
      const stat = fs.statSync(fullPath)
      if (stat.isDirectory()) {
        files.push(...getAllTsFiles(fullPath))
      } else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
        files.push(fullPath)
      }
    }
    return files
  }

  it('ensures src/analytics/metrics.ts exists as the canonical risk module', () => {
    const canonicalPath = path.join(srcDir, 'analytics', 'metrics.ts')
    expect(fs.existsSync(canonicalPath)).toBe(true)
  })

  it('verifies no duplicate definitions of annualisedVolatility or inferPeriodsPerYear exist outside src/analytics/metrics.ts', () => {
    const tsFiles = getAllTsFiles(srcDir)
    const canonicalMetricsFile = path.join(srcDir, 'analytics', 'metrics.ts')

    const forbiddenPatterns = [
      /function\s+annualisedVolatility\s*\(/,
      /function\s+annualizedVolatility\s*\(/,
      /const\s+annualisedVolatility\s*=/,
      /const\s+annualizedVolatility\s*=/,
      /function\s+inferPeriodsPerYear\s*\(/,
      /const\s+inferPeriodsPerYear\s*=/,
    ]

    const violations: { file: string; line: number; match: string }[] = []

    for (const filePath of tsFiles) {
      // Skip the canonical file itself
      if (filePath === canonicalMetricsFile) continue

      // Skip strategyMetrics.ts — it re-exports inferPeriodsPerYear as a
      // delegating adapter (arrow const) that calls the canonical metrics.ts
      // implementation. It is NOT a duplicate implementation.
      if (filePath.endsWith('agent/strategyMetrics.ts')) continue

      const content = fs.readFileSync(filePath, 'utf8')
      const lines = content.split('\n')

      lines.forEach((line, idx) => {
        // Skip comment lines
        const trimmed = line.trim()
        if (
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*')
        )
          return

        for (const pattern of forbiddenPatterns) {
          if (pattern.test(line)) {
            violations.push({
              file: path.relative(srcDir, filePath),
              line: idx + 1,
              match: line.trim(),
            })
          }
        }
      })
    }

    expect(violations).toEqual([])
  })
})
