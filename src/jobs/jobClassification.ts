/**
 * Cross-pod concurrency classification for every scheduled job (#636).
 *
 * `scheduleResilientJob` takes a per-tick advisory lock so exactly one replica
 * runs each job per tick. This table records what would happen without that
 * lock, so a new job cannot ship unclassified: tests/unit/jobs/jobClassification.test.ts
 * fails if a `jobName` appears in src/jobs/ that is not listed here.
 *
 * - `locked`                     — money-moving or destructive; must never run twice.
 * - `idempotent-by-design`       — safe to run twice (upsert / recompute).
 * - `safe-to-run-concurrently`   — designed for parallel runs (read + emit only).
 */

export type JobConcurrencyClass =
  'locked' | 'idempotent-by-design' | 'safe-to-run-concurrently'

export const JOB_CLASSIFICATION: Record<string, JobConcurrencyClass> = {
  alert_rules: 'idempotent-by-design',
  allocation_suggestions: 'idempotent-by-design',
  approval_expiry_sweep: 'locked',
  fiat_reconciliation: 'locked',
  linked_external_wallet_sync: 'idempotent-by-design',
  'loan-accrual': 'idempotent-by-design',
  'loan-liquidation-monitor': 'locked',
  message_delivery_sweep: 'idempotent-by-design',
  performance_attribution: 'idempotent-by-design',
  pool_metrics: 'safe-to-run-concurrently',
  portfolio_risk: 'idempotent-by-design',
  protocol_risk_scoring: 'idempotent-by-design',
  recurring_deposits: 'locked',
  recurring_withdrawals: 'locked',
  referral_payout: 'locked',
  reserve_reconciliation: 'idempotent-by-design',
  retention_all_jobs: 'locked',
  risk_metadata_staleness: 'idempotent-by-design',
  session_cleanup: 'locked',
  stellar_signer_rotation: 'locked',
  strategy_metrics: 'idempotent-by-design',
  support_ticket_sla: 'idempotent-by-design',
}
