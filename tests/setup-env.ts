/**
 * Jest environment bootstrap — runs before any test module (and therefore
 * before src/config/env.ts validates configuration at import time).
 *
 * Loads .env.test with `override: true` so the test environment is hermetic:
 * a developer's ambient shell variables (a real ANTHROPIC_API_KEY, a personal
 * DATABASE_URL) can never leak in and fail validation or point the suite at
 * the wrong database. CI and local runs therefore see identical configuration,
 * and .env.test is the single source of truth for both.
 *
 * DATABASE_URL in .env.test must be the database `prisma migrate deploy`
 * applies in the Node CI job. Overriding onto any other URL makes DB suites
 * query a database CI never creates (#852).
 */

import path from 'path'
import dotenv from 'dotenv'

dotenv.config({
  path: path.resolve(__dirname, '..', '.env.test'),
  override: true,
})
