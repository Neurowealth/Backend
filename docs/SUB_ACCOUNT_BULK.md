# Bulk sub-account management

POST `/api/v1/sub-accounts/bulk` with `operations` and optional `atomic: true`.
Supported actions are create, update, setPermission, setLimit and revoke.
Create requires childUserId and a payload with 1–4 valid permissions. Other
actions require exactly one childUserId or subAccountId and their action-specific
payload. Limits are positive finite numbers; nullable update limits clear a cap.

Every row uses the same management services as single create, permission, limit
and revoke calls, including ownership, chained-account and duplicate checks.
Rows execute sequentially, so later updates see earlier changes. By default,
malformed or unauthorized rows fail independently and return their index,
HTTP-equivalent status and reason while valid rows continue.

Atomic mode wraps all rows in one database transaction. On failure, no changes
persist, and the 400 response includes failedIndex, rolledBack and each row's
failure, rollback or skipped state. Successful per-operation audit entries are
emitted only after commit, so rolled-back operations are never reported as
successful changes.

The default maximum is 100 rows. Set `SUB_ACCOUNT_MAX_BATCH_SIZE` to a positive
integer up to 100 to lower the limit. Oversized requests are rejected before any
row executes.

GET `/api/v1/sub-accounts/summary` reports child counts, active permission
distribution, daily/transaction-limit exposure, unlimited daily-limit children,
and transaction activity during the last 30 days. All queries are parent-scoped.
