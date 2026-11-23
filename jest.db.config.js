/**
 * Jest config for the DB-backed suites (#799).
 *
 * Extends the default config so transforms, test setup and coverage settings
 * have one source of truth. Only the ignore list and the test selection change:
 * `npm test` stays DB-free, while `npm run test:db` runs exactly the suites
 * that need Postgres. CI runs this after `prisma migrate deploy` against the
 * Postgres service already provisioned in the `ci` job.
 */
const base = require('./jest.config')

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...base,
  testPathIgnorePatterns: ['/node_modules/'],
  testMatch: [
    '**/tests/regression.test.ts',
    '**/tests/integration/deposit-withdraw.integration.test.ts',
    '**/tests/integration/tax-report.integration.test.ts',
    // #325 atomic claim and kill-the-worker scenarios.
    '**/tests/integration/outbox/**/*.integration.test.ts',
    // Later DB-backed suites (for example the savings-goal concurrency test
    // from #790) only need to land in this directory to be picked up here.
    '**/tests/integration/goals/**/*.integration.test.ts',
  ],
}
