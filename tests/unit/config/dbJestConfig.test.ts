/**
 * Regression guard for the DB test configuration (#799).
 *
 * The reported bug was that four suites were excluded from every test run,
 * including CI. These assertions make the exclusion list and the db runner's
 * selection explicit so a future edit cannot silently drop a suite again.
 */
const dbConfig = require('../../../jest.db.config')
const baseConfig = require('../../../jest.config')

const ignoredSuites = [
  'deposit-withdraw\\.integration\\.test\\.ts$',
  'tax-report\\.integration\\.test\\.ts$',
  'regression\\.test\\.ts$',
  'outbox/dispatcher\\.integration\\.test\\.ts$',
]

describe('jest.db.config.js (#799)', () => {
  it('removes every default ignore rule for DB suites', () => {
    for (const pattern of ignoredSuites) {
      expect(baseConfig.testPathIgnorePatterns).toContain(pattern)
      expect(dbConfig.testPathIgnorePatterns).not.toContain(pattern)
    }
    expect(dbConfig.testPathIgnorePatterns).toContain('/node_modules/')
  })

  it('selects each previously excluded suite', () => {
    expect(dbConfig.testMatch).toContain('**/tests/regression.test.ts')
    expect(dbConfig.testMatch).toContain(
      '**/tests/integration/deposit-withdraw.integration.test.ts'
    )
    expect(dbConfig.testMatch).toContain(
      '**/tests/integration/tax-report.integration.test.ts'
    )
  })

  it('selects the outbox and goals DB suites by directory', () => {
    expect(dbConfig.testMatch).toContain(
      '**/tests/integration/outbox/**/*.integration.test.ts'
    )
    expect(dbConfig.testMatch).toContain(
      '**/tests/integration/goals/**/*.integration.test.ts'
    )
  })

  it('inherits transforms, setup and roots from the base config', () => {
    expect(dbConfig.preset).toBe(baseConfig.preset)
    expect(dbConfig.roots).toEqual(baseConfig.roots)
    expect(dbConfig.setupFiles).toEqual(baseConfig.setupFiles)
    expect(dbConfig.transform).toEqual(baseConfig.transform)
    expect(dbConfig.coverageThreshold).toEqual(baseConfig.coverageThreshold)
  })
})
