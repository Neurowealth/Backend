# Accounting Exports (QuickBooks Online / Xero)

`GET /api/v1/accounting/export?format=qbo|xero-csv&from=<iso>&to=<iso>`
exports one user's transactions for a period. The same route is available on
the deprecated `/api/accounting/export` alias.

Auth: `requireAuth` + `transactions:read` scope. The response is
`text/csv` with `Content-Disposition: attachment`, `Cache-Control:
private, no-store`, and the following metadata headers:

| Header                | Meaning                                          |
| --------------------- | ------------------------------------------------ |
| `X-Export-Row-Count`  | Data rows in the file (excluding the header).    |
| `X-Export-Checksum`   | SHA-256 of the exact bytes sent.                 |
| `X-Export-Reconciled` | `true` only after the safety check below passes. |

## The reconciliation gate (#669)

An export that silently drops, duplicates, or rewrites a row corrupts the
customer's books and is usually discovered weeks later during bank
reconciliation. Generation therefore has a mandatory post-generation gate in
`src/accounting/reconciliation.ts`:

1. Build the CSV from the ledger rows via `toQbo` / `toXeroCsv`.
2. Parse the generated file back (RFC 4180, quoted commas and escaped quotes
   included).
3. Compare, per asset and per fee:
   - exported row count vs ledger row count,
   - sum of exported signed amounts vs the ledger total,
   - QBO fee totals vs ledger fees.
4. If anything differs, **send no file**. The route returns `422` with the
   original `AccountingReconciliationError` and a per-asset diff summary,
   checksum, row count, and totals. The failure is logged as an audit event
   (`ACCOUNTING_EXPORT_RECONCILIATION_FAILED`).

The response on success also includes the `reconciliation` object (totals and
diffs) from the controller, and the audit log records the row count, checksum,
period, format, and per-asset totals.

## Sign and fee conventions

`Transaction.amount` is stored as a positive magnitude. Exports apply direction:

- Inflows (`DEPOSIT`, `YIELD_CLAIM`, `REFERRAL_REWARD`, `INBOUND_TRANSFER`,
  `CLAIMABLE_BALANCE_CLAIM`, `LOAN_DISBURSE`) are positive.
- Outflows (`WITHDRAWAL`, `LOAN_REPAYMENT`, `LOAN_LIQUIDATION`) are negative.
- `REBALANCE` / `SWAP` are internal moves and export as `0.00` transfer rows.
- QBO has separate `Amount` (gross signed) and `Fee` columns.
- Xero's `Amount` is net: signed amount minus fee, matching a bank statement.

CSV field escaping uses `src/utils/csv.ts`. Plain negative numbers are left
unprefixed so accounting software imports them as numbers; non-numeric fields
starting with `=`, `+`, `-`, `@`, tab or CR keep the spreadsheet-injection
guard.

## Format guarantees

Golden files live in `tests/fixtures/accounting/` and are checked in CI for:

- exact headers and column order,
- RFC 4180 quoting/escaping (commas, quotes),
- sign conventions,
- fees and multi-currency assets.

The round-trip tests parse the generated file and compare it to the ledger.
Any intentional format change must update the golden file in the same commit.
