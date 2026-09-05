## PR Description

This PR resolves four issues:

closes #390
closes #395
closes #394
closes #391

### Summary

This PR addresses four issues in the Neurowealth Backend:

1. **#390 - API key scopes enforcement**: Added `requireScope` guards to all write endpoints that correspond to their respective `USER_SCOPES` entries. Previously, only `withdraw.ts` and `keys.ts` had scope enforcement, while `deposit.ts`, `goals.ts`, `recurring-deposits.ts`, `strategies.ts`, `webhooks.ts`, `vault.ts`, `alerts.ts`, and `fiat.ts` only called `requireAuth` without scope checks. A read-only-scoped API key can now be properly rejected (403) from write endpoints.

2. **#395 - Root documentation**: Added `README.md` and `CONTRIBUTING.md` at the repository root. README provides project overview, quickstart, and documentation links. CONTRIBUTING documents local setup, test/lint/typecheck commands, PR conventions, and how issues map to PRs.

3. **#394 - GDPR/CCPA right-to-erasure**: Added an erasure job (`src/jobs/erasureJob.ts`) that walks the `erasurePolicies` map and applies DELETE/ANONYMIZE per model while leaving IMMUTABLE tables (AuditBlock, OutboxOp) untouched. Added admin endpoint `POST /api/admin/erasure` with dry-run mode. Added unit tests covering each policy type and immutable-table exclusion.

4. **#391 - Travel Rule records**: Updated `detectTravelRule` to look up the user's data from the database and populate `originator` and `beneficiary` fields with VASP + customer information. Transitions status to `READY` when data is available, or `PENDING_DATA` when missing. Added unit coverage for both populated and missing-data paths.

### Changes by file

- `src/routes/deposit.ts` - added `requireScope('deposit:write')`
- `src/routes/goals.ts` - added `requireScope('goals:write')` on POST/PATCH/DELETE
- `src/routes/recurring-deposits.ts` - added `requireScope('recurring_deposits:write')` on POST/PATCH/DELETE
- `src/routes/strategies.ts` - added `requireScope('strategies:write')` on publish
- `src/routes/webhooks.ts` - added `requireScope('webhooks:manage')` on POST/PATCH/DELETE
- `src/routes/vault.ts` - added `requireScope('vault:write')` on build-transaction
- `src/routes/alerts.ts` - added `requireScope('alerts:manage')` on POST/PATCH/DELETE
- `src/routes/fiat.ts` - added `requireScope('fiat:write')` on create order
- `src/jobs/erasureJob.ts` - new file with erasure job and policies
- `src/middleware/adminAuth.ts` - added `erasure:write` and `erasure:read` scopes
- `src/routes/admin.ts` - added `POST /api/admin/erasure` endpoint
- `src/compliance/travelRule.ts` - populate originator/beneficiary from user data
- `tests/unit/middleware/apiKeyAuth.test.ts` - added scope denial tests for all write scopes
- `tests/unit/compliance/travelRule.test.ts` - new file with travel rule tests
- `README.md` - new file with project overview and quickstart
- `CONTRIBRIBUTING.md` - new file with contributing guidelines