import db from '../db'
import { logger } from '../utils/logger'
import { stellarSignerRotationOverdueDays } from '../utils/metrics'
import { initiateRotation } from '../treasury/signerRotation'
import { scheduleResilientJob } from './resilientScheduler'

const JOB_NAME = 'stellar_signer_rotation'
const QUARTER_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

export async function runSignerRotationCheck(now = new Date()): Promise<void> {
  const account = await db.treasuryAccount.findFirst({
    where: { isActive: true, tier: 'HOT' },
    orderBy: { createdAt: 'asc' },
  })
  if (!account) {
    logger.warn('[SignerRotation] No active HOT treasury account configured')
    return
  }

  const latest = await db.signerRotation.findFirst({
    where: { treasuryAccountId: account.id },
    orderBy: { createdAt: 'desc' },
  })
  if (latest?.status === 'DUAL_ACTIVE') {
    stellarSignerRotationOverdueDays.set(0)
    return
  }

  const reference =
    latest?.finalizedAt || latest?.createdAt || account.createdAt
  const ageDays = Math.floor((now.getTime() - reference.getTime()) / DAY_MS)
  stellarSignerRotationOverdueDays.set(Math.max(0, ageDays - QUARTER_DAYS))
  if (ageDays < QUARTER_DAYS) return

  const nextPublicKey = process.env.STELLAR_NEXT_AGENT_PUBLIC_KEY?.trim()
  if (!nextPublicKey) {
    logger.warn(
      '[SignerRotation] Quarterly signer rotation is due; configure STELLAR_NEXT_AGENT_PUBLIC_KEY to create the dual-active proposal',
      {
        treasuryAccountId: account.id,
        ageDays,
      }
    )
    return
  }

  await initiateRotation(
    account.id,
    account.publicKey,
    nextPublicKey,
    'scheduled-quarterly-rotation'
  )
  stellarSignerRotationOverdueDays.set(0)
}

export function scheduleSignerRotation(): NodeJS.Timeout {
  return scheduleResilientJob({
    jobName: JOB_NAME,
    task: runSignerRotationCheck,
    intervalMs: DAY_MS,
    unref: true,
  })
}
