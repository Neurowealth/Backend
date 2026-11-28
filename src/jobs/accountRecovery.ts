import { scheduleResilientJob } from './resilientScheduler'
import { sweepAccountRecovery } from '../recovery/service'

export function scheduleAccountRecoverySweep(): NodeJS.Timeout {
  return scheduleResilientJob({
    jobName: 'account_recovery_completion',
    task: sweepAccountRecovery,
    intervalMs: 60_000,
  })
}
