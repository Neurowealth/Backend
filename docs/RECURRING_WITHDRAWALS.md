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

Manual withdrawals may explicitly acknowledge a goal impact with
`acknowledgeGoalImpact: true`; scheduled occurrences never supply this flag.
Acknowledgement does not bypass destination risk, compliance or approvals.
Read-only external-holdings links do not establish trusted send destinations;
destination history comes from exact confirmed outbox payloads. Fractional
scheduled amounts round down to Stellar's seven decimal places.

The shared withdrawal path reserves pending withdrawal amounts under a database
advisory lock per owner/asset before creating a transaction intent. Concurrent
manual and scheduled requests therefore check available funds after existing
reservations; an insufficient occurrence rolls forward without on-chain dispatch.

Claims compare both the previous run timestamp and state, including null values.
An interrupted occurrence with an expired execution lease is paused for review:
check its transaction/outbox intent before resuming to avoid duplicate sends.
Approval requests advance the cadence so one occurrence cannot create repeated
requests. Holds and skips are delivered as withdrawal events on the alerts stream.

Migration rollback is in `prisma/rollback/20261008090000_recurring_withdrawals.sql`.
