# Recurring on-chain withdrawals

Create an owner-scoped plan at `POST /api/v1/recurring-withdrawals` with
`confirmed: true`. WEEKLY, BIWEEKLY and MONTHLY plans send the held asset without
conversion using FIXED, YIELD_ONLY or PERCENT_OF_BALANCE amounts. List, read,
patch, cancel and `POST /:id/preview` use the same resource prefix.

Insufficient funds or amounts below minAmount skip the occurrence and roll the
cadence forward. The scheduler calls executeWithdraw, sharing risk scoring,
approval policies and goal checks with manual withdrawals. Risk and freeze
holds pause the plan. Goal conflicts skip and notify; no unattended goal
acknowledgement is allowed. Destination changes pause the plan for review.

Claims compare both the previous run timestamp and state, including null values.
An interrupted occurrence with an expired execution lease is paused for review:
check its transaction/outbox intent before resuming to avoid duplicate sends.
Approval requests advance the cadence so one occurrence cannot create repeated
requests. Holds and skips are delivered as withdrawal events on the alerts stream.

Migration rollback is in `prisma/rollback/20261008090000_recurring_withdrawals.sql`.
