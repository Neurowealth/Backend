# Rebalance Exposure Caps & Cost-Payback Gate (#346 / #347)

Two controls govern *whether* and *how much* the agent moves during a rebalance:

1. **Per-protocol exposure caps (#346)** — bound how much of a user's portfolio any
   protocol may hold, applied greedily with residual routing.
2. **Rebalance cost model + payback gate (#347)** — a grounded estimate of the
   cost of a move (network fee, price impact, entry/exit); a move only fires if
   it recoups its cost within a bounded horizon.

Both live behind the existing explainable-rebalance `UserStrategyPreferences`
fields, so a user with no framing configured sees byte-for-byte the same
default-max-yield behavior as before.

---

## Exposure caps (#346)

### The input contract

`UserStrategyPreferences` now carries two cap fields (validated by
`src/validators/strategy-validators.ts` `publishableConfigSchema`):

- `defaultMaxFraction` (`number`, 0–1) — the per-protocol ceiling used when a
  protocol has no explicit override.
- `exposureCaps` (`Record<protocol, { maxFraction?: number; maxAbsolute?: string }>`)
  — explicit per-protocol caps. `maxAbsolute` is a raw `Decimal(36,18)` amount and
  participates in the cap directly; `maxFraction` is a portfolio share.

A cap is only *active* if set. When `riskTolerance` is present (the agent loop
always sets it, default 5), `buildExposureContextForUser` derives a
risk-tolerance default cap from `RISK_TOLERANCE_CAP_TABLE` for protocols without
an explicit override — so the caps path is effectively always active in the
strategy path, while still being opt-in per protocol.

### Resolution

`resolveProtocolCap` / `resolveExposureCap` (pure, `src/agent/exposureCaps.ts`)
pick, per protocol, the **tightest applicable** of:
`exploit exposure override` → `risk-tolerance default` → `defaultMaxFraction`.

> **Tighten-only merge (follows).** `src/agent/effectiveStrategy.ts`
> `resolveEffectiveConfig` merges a followed strategy's caps with `Math.min` on
> `maxFraction` and `stricterExposureCaps` for the map — a follow may only ever
> *tighten* exposure, never loosen it. An ACTIVE `SavingsGoal` overrides via `??`
> (a personal target may legitimately loosen), mirroring the risk-ceiling rule.

### Move planning

`planCappedRebalance(preferredOrder, requestedFraction, snapshot, caps)`:

- Fills the preferred protocol greedily up to its cap.
- Routes any residual to the next eligible protocol, then to other held
  protocols, each under its own cap.
- Returns an explicit `CappedAllocationPlan` with per-move `capped`/`boundedBy`
  and a `unplacedFraction` — the sum of caps over the eligible set can be below
  100%, in which case the remainder stays in place (`agent.exposure_unplaceable`).

The strategy's decision is passed through `planFromStrategyDecision` in
`src/agent/router.ts`, which clamps the target move and emits
`agent.exposure_unplaceable` when nothing can move. Over-cap state is surfaced in
the decision record/log even when APY alone wouldn't justify a move.

### Failure semantics

- Caps never exceed 100% collectively in a way that silently rebalances; the
  unplaceable remainder is explicit and logged.
- `validateExposureCapConfig` rejects invalid fractions (≤0, >1) before use.

---

## Rebalance cost model & payback gate (#347)

Replaces the old `$0.50`/`/1e18` flat heuristic in `src/agent/strategies.ts` with
a grounded model in pure module `src/agent/rebalanceCost.ts`.

### The model

`estimateRebalanceCost(...)` produces a `RebalanceCost` with:

- **Network fee** — from a live fee-oracle snapshot when present
  (`recommendedBaseFee`, stroops), else a conservative `NETWORK_FEE_FALLBACK_USD`
  constant. Real asset decimals are used (`amountToHumanUnits`), killing the old
  hard-coded `/1e18` wei bug.
- **Price impact** — an explicit simulated bps when a cross-asset path was
  simulated; for a same-asset hop it is 0; an *un-simulated cross-asset* move
  falls back to a conservative `PRICE_IMPACT_FALLBACK_BPS`.
- **Entry/exit bps** — per-protocol `protocolEntryExitBps`.
- **Confidence** — `dataConfidence: 'measured' | 'fallback'` plus the
  `fallbackReasons` that forced the fallback (e.g. `fee_oracle_unavailable`,
  `fee_oracle_stale_or_invalid`, `price_impact_unavailable`).

Fallback is **never** a discount — it is the cautious path.

### The payback gate

`passesPaybackGate(cost, fromApy, toApy, congestionLevel)` computes

```
paybackDays = (cost.totalCostPct / (toApy - fromApy)) * 365
```

A move is allowed only if `paybackDays < REBALANCE_MAX_PAYBACK_DAYS` (default 21).
No positive benefit ⇒ always rejected. Under elevated congestion the horizon is
*tightened* (more reluctant to trade when fees are elevated), never extended.

### Conservative-by-default decisions

In `MaxYieldStrategy` and the default `compareProtocols` path:

- The move is gated on `netImprovement = rawImprovement − totalCostPct` **and**
  `payback.allowed`.
- When `dataConfidence === 'fallback'`, the minimum required net improvement is
  **doubled** (`FALLBACK_THRESHOLD_MULTIPLIER`) — a blind decision is held to a
  higher bar, never a lower one.

A tiny position whose modeled cost dwarfs its size (fee% ≫ 100) is rejected as
dust — consistent with the payback math. See `tests/unit/agent/rebalanceCost.test.ts`
(golden payback math, `/1e18` regression fixture, fallback-confidence and
congestion-premium cases) and `tests/integration/agent/rebalanceCost.integration.test.ts`
(unprofitable move is not enqueued; a clearly profitable move is).

---

## Interaction

Caps (#346) decide *how much* moves; the cost gate (#347) decides *whether it is
worth it*. Both apply in the rebalance loop (`src/agent/loop.ts`) and the strategy
engine (`src/agent/router.ts`). Over-cap correction notes in
`src/agent/router.ts` currently surface the over-cap state; the fee-aware gate in
`#347` gives the cost basis that makes the correction decision meaningful.

## Configuration (curated)

- Risk-tolerance default caps: `RISK_TOLERANCE_CAP_TABLE` in
  `src/agent/exposureCaps.ts`.
- Fee/payback constants (fallback USD, max payback days, congestion premium):
  `src/agent/rebalanceCost.ts`.
