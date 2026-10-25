#!/usr/bin/env ts-node
/**
 * Monthly referral fraud calibration report (#619).
 *
 * Prints the score distribution, the false-positive rate from manual reviews
 * and a suggested REFERRAL_FRAUD_REVIEW_SCORE for one month.
 *
 * Usage:
 *   npx ts-node scripts/referral-calibration.ts [YYYY-MM]
 *
 * Defaults to the previous calendar month. Requires DATABASE_URL.
 */
import { buildCalibrationReport } from '../src/referral/reviewQueue'
import db from '../src/db'

function previousMonth(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

async function main(): Promise<void> {
  const month = process.argv[2] ?? previousMonth()
  const report = await buildCalibrationReport(month)
  console.log(JSON.stringify(report, null, 2))
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
