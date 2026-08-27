# Tax Reporting & Cost-Basis Lot Tracking

Answers "what's my realized gain/loss this year?" (#284). Every confirmed
on-chain deposit creates a **cost-basis lot**; every confirmed on-chain
withdrawal consumes open lots under the account's configured **accounting
method** (FIFO/LIFO/HIFO/SPECIFIC_ID — #317) and records immutable
**disposal** rows snapshotting cost basis, proceeds, and realized gain at
disposal time. The report endpoint is a pure read over that ledger.

The design principle throughout: **tax bookkeeping is derived data**. It is
written transactionally alongside the deposit/withdrawal it derives from, but a
tax problem must never block or roll back a confirmed on-chain transaction —
failures are loud (structured error log + alert) and repairable by an
idempotent backfill, never silent.

## Data model

| Model          | Meaning                                                                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CostBasisLot` | One per confirmed DEPOSIT Transaction (`transactionId` unique). Carries `originalAmount`, `remainingAmount`, nullable `acquisitionPrice` + `priceSource`, `acquiredAt`.                                                          |
| `LotDisposal`  | One lot's share of a withdrawal. A withdrawal may span many lots (`@@unique([transactionId, lotId])`). Snapshots `disposalPrice`, `costBasis`, `proceeds`, `realizedGain` — nullable, where null means **unpriced, never zero**. |

`User.accountingMethod` (default `FIFO`) selects the consumption order;
`User.methodEffectiveAt` stamps when it last changed (see "Accounting
methods" below). The lot/disposal schema itself is unchanged from #284 — the
method only decides _which_ open lots a withdrawal consumes, never the shape
of what gets written.

## Accounting methods (#317)

`src/tax/methods/` is a small interface (`CostBasisMethod.consumeLots`) with
four implementations, resolved through a whitelist (`resolveMethod`) so a raw
method string never reaches a switch/ORDER BY:

| Method        | Consumption order                                                                          |
| ------------- | ------------------------------------------------------------------------------------------ |
| `FIFO`        | Oldest lot first (`acquiredAt` asc, id tiebreak). **Default**; byte-identical to pre-#317. |
| `LIFO`        | Newest lot first (mirror of FIFO's ordering).                                              |
| `HIFO`        | Highest `acquisitionPrice` first; unpriced lots sort last; tiebreak `acquiredAt` asc, id.  |
| `SPECIFIC_ID` | Consumes only the caller-selected lots, in the given order — see below.                    |

All four share one consumption loop (`consumeOrderedLots` in
`src/tax/methods/types.ts`): all-or-nothing shortfall (`InsufficientLotsError`
before any instruction is produced), `remainingAmount` never negative, and the
same costBasis/proceeds/realizedGain math. `src/tax/fifo.ts` re-exports the
original `consumeLotsFifo` name unchanged for backward compatibility.

### SPECIFIC_ID plumbing

Choosing which lots to sell has to happen at withdrawal _request_ time (the
user says which lots), but disposal recording happens later, when the Stellar
event listener confirms the on-chain withdrawal. `Transaction.selectedLotIds`
(a plain string array, default empty) bridges the gap: `POST /api/v1/withdraw`
accepts an optional `selectedLotIds` array, `executeWithdraw`/
`enqueueAndDispatch` persist it on the `Transaction` row, and
`handleWithdrawEvent` reads it back off that same row (matched by `txHash`)
when it calls `recordDisposalsForWithdrawal`.

**Important**: an invalid or missing selection is only discovered at that
point — _after_ the withdrawal has already executed on-chain, since disposal
recording always happens on the confirmation path (the same timing every
other method already uses). It is treated exactly like an
`InsufficientLotsError` shortfall: a critical alert, nothing written, the
withdrawal itself unaffected. There is no synchronous pre-flight validation in
the withdraw route — the controller has no tax-module awareness, and adding
one would break that separation. Validate the selection client-side before
submitting a SPECIFIC_ID withdrawal.

### Method changes are forward-only

Changing `accountingMethod` stamps `methodEffectiveAt = now()` and never
rewrites history: disposals already recorded keep whatever numbers they were
given under the method active at the time. `buildTaxReport` surfaces a
`methodChangeNote` caveat when `methodEffectiveAt` falls inside the requested
report year, so a year that mixes two methods is flagged, never silently
presented as one. Only the most recent method change is tracked — a second
change does not retroactively re-attribute the window before the first one.

### Pricing source hierarchy (#317)

`src/tax/pricing.ts`'s `priceForAsset` now checks, in order:

1. An explicit `userDeclaredPrice` passed by the caller → `USER_DECLARED`.
2. `lookupFeedPrice` — a real, callable integration point for a future
   volatile-asset market-data feed (`MARKET_FEED` source) — **stubbed to
   always return `null` in this release**; no feed/credentials exist yet.
3. The USDC 1:1 USD assumption → `STABLECOIN_ASSUMPTION` (unchanged).
4. `null` — genuinely unpriced (unchanged contract, never a silent zero).

So volatile, non-stablecoin assets remain honestly unpriced today, exactly as
before #317, just reached through a documented hierarchy instead of a
two-branch `if`.

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

| Asset         | Price               | Source                                               |
| ------------- | ------------------- | ---------------------------------------------------- |
| USDC          | `1.0` USD per token | `STABLECOIN_ASSUMPTION` (surfaced in report caveats) |
| anything else | `null`              | —                                                    |

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
GET /api/v1/portfolio/:userId/tax-report?year=<yyyy>&format=json|csv&method=FIFO|LIFO|HIFO|SPECIFIC_ID
```

- Auth: `requireAuth` + `enforceUserAccess` (own report only). The userId is a
  path param deliberately — `enforceUserAccess` only checks
  `params.userId`/`body.userId`, so a query-param userId would bypass it.
- `year` is bounded 2000–2100; boundaries are **UTC** (`disposedAt` in
  `[Jan 1 00:00 UTC, next Jan 1)`). A disposal belongs to the year it was
  disposed in, regardless of when the lot was acquired.
- `method` is **optional and a confirmation gate, not a recompute switch**:
  if passed, it must equal the account's current `accountingMethod` or the
  request is rejected with 400 (`MethodMismatchError`). This report shows
  disposals that actually happened under whichever method was active at each
  withdrawal — it cannot hypothetically re-simulate a year under a different
  method, since that would produce numbers that don't match what the real
  withdrawals did lot-for-lot. Change the account's method (forward-only, see
  above) to affect future reports.
- A year with no activity returns a valid empty report (200).
- `format=csv` returns an RFC 4180 attachment (`tax-report-<year>.csv`).
  Cells starting with `=` `+` `-` `@` tab or CR are prefixed with `'`
  (spreadsheet formula-injection guard, `src/utils/csv.ts`).

Money values are decimal strings. `totals` sums only fully priced disposals.
`method` in the response is the account's `accountingMethod`, not a
per-request-computed value.

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

1. **Rebalances are not disposals.** Rebalance events carry no per-user
   amounts (protocol/APY only) and are same-asset protocol moves; some tax
   regimes may treat them differently — not modeled.
2. **Volatile (non-stablecoin) assets are unpriced** and excluded from
   totals (flagged in caveats). The market-feed pricing hierarchy level is a
   real, tested integration point but has no feed wired up yet (see
   "Pricing source hierarchy").
3. **USDC 1:1 USD assumption** — actual market price may deviate slightly.
4. **HTTP-controller-only transactions** never re-seen by the event listener
   get no lots/disposals (consistent with Position behavior).
5. **UTC year boundaries** — users in other timezones may expect local-time
   year edges.
6. **Forward-only unless the backfill script is run** at deploy.
7. Yield claims, referral rewards, and swaps do not create or consume lots;
   only DEPOSIT/WITHDRAWAL Transactions participate.
8. This is bookkeeping output, **not tax advice**; jurisdictions differ.
9. **The report never recomputes history under a hypothetical method** —
   `?method=` is a confirmation gate against the account's real setting, not
   a what-if simulator (see "Endpoint").
10. **SPECIFIC_ID selection is validated only after the withdrawal has
    already executed on-chain** (event-listener confirmation timing); an
    invalid selection alerts critically and writes nothing rather than
    blocking the withdrawal.
11. **Only the most recent method change is tracked** (`methodEffectiveAt`
    is a single timestamp) — a second change does not retroactively
    re-attribute the window before the first one.
12. Wash-sale-like adjustment rules and long/short-term holding-period
    classification are not computed — out of scope, jurisdiction-specific.
