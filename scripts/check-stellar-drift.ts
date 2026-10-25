/**
 * Automated Stellar Integration & Contract Drift Gate (#508)
 *
 * Runs drift detection checks against current environment metadata and app assumptions.
 * Exits with status 1 if any contract or configuration drift is detected.
 */

import { checkStellarIntegrationDrift } from '../src/stellar/driftCheck'
import { logger } from '../src/utils/logger'

async function runStellarDriftCheck() {
  logger.info('[Stellar Drift Gate] Running contract and schema drift checks...')
  const report = checkStellarIntegrationDrift()

  if (report.driftDetected) {
    console.error('\n❌ STELLAR INTEGRATION DRIFT DETECTED!')
    console.error(`Timestamp: ${report.timestamp}`)
    console.error(`Target Network: ${report.network}`)
    console.error(`Passed: ${report.checksPassed}/${report.totalChecks} checks\n`)

    for (const drift of report.drifts) {
      console.error(`[${drift.severity.toUpperCase()}] ${drift.field} (${drift.component}):`)
      console.error(`  Description: ${drift.description}`)
      console.error(`  Expected: ${drift.expected}`)
      console.error(`  Actual: ${drift.actual}\n`)
    }

    process.exit(1)
  }

  console.log('\n✅ All Stellar contract and configuration drift checks PASSED!')
  console.log(`Passed ${report.checksPassed}/${report.totalChecks} integration checks.\n`)
  process.exit(0)
}

if (require.main === module) {
  runStellarDriftCheck().catch((err) => {
    console.error('[Stellar Drift Gate] Error during drift check execution:', err)
    process.exit(1)
  })
}
