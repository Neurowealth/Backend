import { logger } from '../utils/logger'
import { recordJobFailure, recordJobSuccess } from '../utils/job-metrics'
import { scheduleResilientJob } from './resilientScheduler'
import { syncLinkedExternalWallets } from '../externalWallets/service'

export const LINKED_EXTERNAL_WALLET_SYNC_INTERVAL_MS = Number(
  process.env.LINKED_EXTERNAL_WALLET_SYNC_INTERVAL_MS || 15 * 60 * 1000
)

export async function runLinkedExternalWalletSync(): Promise<void> {
  const startedAt = Date.now()
  try {
    const result = await syncLinkedExternalWallets()
    recordJobSuccess('linked_external_wallet_sync', Date.now() - startedAt)
    logger.info('[ExternalWalletSync] Batch completed', result)
  } catch (error) {
    recordJobFailure(
      'linked_external_wallet_sync',
      Date.now() - startedAt,
      error
    )
    logger.error('[ExternalWalletSync] Batch failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

export function scheduleLinkedExternalWalletSync(): NodeJS.Timeout {
  logger.info('[ExternalWalletSync] Scheduled', {
    intervalMs: LINKED_EXTERNAL_WALLET_SYNC_INTERVAL_MS,
  })
  return scheduleResilientJob({
    jobName: 'linked_external_wallet_sync',
    task: runLinkedExternalWalletSync,
    intervalMs: LINKED_EXTERNAL_WALLET_SYNC_INTERVAL_MS,
    unref: true,
  })
}
