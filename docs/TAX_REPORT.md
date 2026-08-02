# Tax Reporting & Cost-Basis Lot Tracking

Answers "what's my realized gain/loss this year?" (#284). Every confirmed
on-chain deposit creates a **cost-basis lot**; every confirmed on-chain
withdrawal consumes open lots **FIFO** and records immutable **disposal** rows
snapshotting cost basis, proceeds, and realized gain at disposal time. The
report endpoint is a pure read over that ledger.

The design principle throughout: **tax bookkeeping is derived data**. It is
written transactionally alongside the deposit/withdrawal it derives from, but a
tax problem must never block or roll back a confirmed on-chain transaction —
failures are loud (structured error log + alert) and repairable by an
idempotent backfill, never silent.

## Data model

| Model | Meaning |
| --- | --- |
| `CostBasisLot` | One per confirmed DEPOSIT Transaction (`transactionId` unique). Carries `originalAmount`, `remainingAmount`, nullable `acquisitionPrice` + `priceSource`, `acquiredAt`. |
| `LotDisposal` | One lot's share of a withdrawal. A withdrawal may span many lots (`@@unique([transactionId, lotId])`). Snapshots `disposalPrice`, `costBasis`, `proceeds`, `realizedGain` — nullable, where null means **unpriced, never zero**. |

The schema carries no accounting-method column: FIFO ordering (acquiredAt asc,
id tiebreak) lives in `src/tax/fifo.ts`, so LIFO/HIFO could be added later
without a schema change.

## Write path (who creates lots)

The **Stellar event listener is authoritative**, matching how Positions work:

- `handleDepositEvent` → `createLotForDeposit(...)` on the same transaction
  handle as the deposit's Transaction/Position writes.
- `handleWithdrawEvent` → `recordDisposalsForWithdrawal(...)`, likewise — and
  it runs even when no Position matched, because the confirmed Transaction is
  the disposal source of truth.
- The HTTP deposit/withdraw controller does **not** create lots (it never
  touched Positions either). A Transaction only seen over HTTP and never
  re-observed by the event listener gets no lot/disposal — accepted and
  reconcilable (see below).
- Rebalances are **not** disposals (see Known limitations).

Both service functions are idempotent under event replay and the batch-failure
fallback path: lot creation relies on the `transactionId` unique constraint
(P2002 → quiet skip), disposal recording on an exists-check plus
`(transactionId, lotId)` uniqueness.

### Failure behavior (invariants)

- `remainingAmount` never goes negative; disposal is **all-or-nothing** per
  withdrawal. If open lots can't cover the amount, **nothing is written**, a
  critical alert fires, and the withdrawal proceeds untouched. Partial rows
  would poison later repair; with nothing written, re-running the recorder
  after backfill produces the correct ledger.
- Alert emission is fire-and-forget — no awaited network I/O inside the DB
  transaction.

## Pricing

| Asset | Price | Source |
| --- | --- | --- |
| USDC | `1.0` USD per token | `STABLECOIN_ASSUMPTION` (surfaced in report caveats) |
| anything else | `null` | — |

Unpriced lots/disposals keep null money fields, are flagged `priced: false`,
and are **excluded from report totals** with a visible caveat
(`unpricedDisposalCount`, `unpricedAssets`). Never silently zeroed.

### Units

Lot amounts inherit the Transaction's `amount` units verbatim, so lots and
Positions are internally consistent with each other by construction. The
`1.0` USDC price is **per token**. Event parsers pass the on-chain `amount`
through unscaled — if the vault contract emits stroop-scaled (1e7) integer
amounts on your deployment, priced totals will be scaled by the same factor.
**Verify one real deposit event's persisted `Transaction.amount` against the
wallet-visible token amount before trusting priced totals on a new network.**

## Endpoint

```
GET /api/v1/portfolio/:userId/tax-report?year=<yyyy>&format=json|csv
```

- Auth: `requireAuth` + `enforceUserAccess` (own report only). The userId is a
  path param deliberately — `enforceUserAccess` only checks
  `params.userId`/`body.userId`, so a query-param userId would bypass it.
- `year` is bounded 2000–2100; boundaries are **UTC** (`disposedAt` in
  `[Jan 1 00:00 UTC, next Jan 1)`). A disposal belongs to the year it was
  disposed in, regardless of when the lot was acquired.
- A year with no activity returns a valid empty report (200).
- `format=csv` returns an RFC 4180 attachment (`tax-report-<year>.csv`).
  Cells starting with `=` `+` `-` `@` tab or CR are prefixed with `'`
  (spreadsheet formula-injection guard, `src/utils/csv.ts`).

Money values are decimal strings. `totals` sums only fully priced disposals.

## Backfill

```
npx ts-node scripts/backfill-cost-basis-lots.ts [--dry-run]
```

Replays all CONFIRMED DEPOSIT/WITHDRAWAL Transactions in `confirmedAt` order
through the same service functions. **Run once when deploying this feature**:
without it, tracking starts forward-only and every pre-existing user's first
withdrawal fires a false-positive "insufficient lots" critical alert. Safe to
re-run any time (idempotent); also the repair tool after any lot-creation
failure alert.

## Reconciliation queries

Confirmed deposits missing a lot:

```sql
SELECT t.id, t."userId", t."txHash", t.amount
FROM transactions t
LEFT JOIN cost_basis_lots l ON l."transactionId" = t.id
WHERE t.type = 'DEPOSIT' AND t.status = 'CONFIRMED' AND l.id IS NULL;
```

Confirmed withdrawals with no disposal rows:

```sql
SELECT t.id, t."userId", t."txHash", t.amount
FROM transactions t
LEFT JOIN lot_disposals d ON d."transactionId" = t.id
WHERE t.type = 'WITHDRAWAL' AND t.status = 'CONFIRMED' AND d.id IS NULL
GROUP BY t.id;
```

Non-empty results → run the backfill script, then re-check. Rows that persist
indicate an insufficient-lots condition (see the paired critical alert).

## Known limitations (v1)

1. **FIFO only.** No LIFO/HIFO/specific-identification election.
2. **Rebalances are not disposals.** Rebalance events carry no per-user
   amounts (protocol/APY only) and are same-asset protocol moves; some tax
   regimes may treat them differently — not modeled.
3. **Non-USDC assets are unpriced** and excluded from totals (flagged in
   caveats). No market price feed is integrated.
4. **USDC 1:1 USD assumption** — actual market price may deviate slightly.
5. **HTTP-controller-only transactions** never re-seen by the event listener
   get no lots/disposals (consistent with Position behavior).
6. **UTC year boundaries** — users in other timezones may expect local-time
   year edges.
7. **Forward-only unless the backfill script is run** at deploy.
8. Yield claims, referral rewards, and swaps do not create or consume lots;
   only DEPOSIT/WITHDRAWAL Transactions participate.
9. This is bookkeeping output, **not tax advice**; jurisdictions differ.
