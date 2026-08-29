# Yield Composition & Effective APY (#349)

A protocol's quoted APY can be split into a **base** rate (what the market pays
for the collateral) and an **incentive** rate (token-denominated rewards). These
are economically different — incentives can be diluted, vest, or be pulled — so
any consumer of yield should value the incentive part at a haircut, never at face
value.

## The model

Pure core: `src/analytics/yieldComposition.ts`.

- `INCENTIVE_HAIRCUT = 0.15` — incentives are valued at 85c on the dollar.
- `effectiveApy = baseApy + incentiveApy × (1 − INCENTIVE_HAIRCUT)`, floored at 0.
  Fallback hierarchy, always non-null:
  - both parts known → the haircuted sum;
  - only one part known → that part at face value;
  - only `supplyApy` → `supplyApy` (no split → no haircut possible);
  - nothing known → `null` (null-on-degenerate, never 0).
- `incentiveShare(baseApy, incentiveApy)` → 0–1 share of yield from incentives,
  `null` when the split is unknown (fail-safe).
- `shouldUseEffectiveApy(env)` → `USE_EFFECTIVE_APY === 'true'`, **default OFF**.
- `YIELD_CAVEAT` travels with every yield-breakdown response.

## Data model

`ProtocolRate` (and the new migration `20260829000000_protocol_yield_composition`)
gains three columns, all stored **raw** exactly as the adapter returned them — the
DB never stores a haircuted value, so the consumption flag can toggle without a
rebuild:

- `baseApy Decimal(10,6)?`
- `incentiveApy Decimal(10,6)?`
- `rewardTokens Json?` — `[{ symbol, address?, apy? }]`

`YieldProtocol` (`src/agent/types.ts`) and `src/agent/scanner.ts` carry and persist
these fields.

## Flag-gated consumption

`USE_EFFECTIVE_APY=true` switches optimizer/agent consumption from quoted APY to
haircuted effective APY. Two boundaries, both off by default (byte-for-byte
unchanged until set):

1. **Agent**: `scanAllProtocols` ranks protocols by `effectiveApy` in memory; the
   DB keeps the raw quoted split.
2. **Optimizer**: `src/analytics/service.ts` builds its `RawRateObservation` rates
   from `effectiveApy` when the flag is on.

## Risk scoring

Emissions-heavy yield is riskier. `applyEmissionsPenalty(score, incentiveShare)`
(`src/agent/riskScoring.ts`) subtracts up to `EMISSIONS_MAX_PENALTY` (8 points)
as the incentive share rises from `EMISSIONS_LOW_SHARE` (0.4) toward
`EMISSIONS_HIGH_SHARE` (0.8). Unknown/absent share → no penalty (fail-safe).
`computeRiskScore` accepts an optional `incentiveShare` argument and applies it.

## Endpoint

`GET /api/v1/analytics/yield-breakdown` (JWT-authenticated) returns the per-held-
protocol split, `incentiveShare`, `effectiveApy`, and the `caveat`, plus
`effectiveApyEnabled`. Falls back to all protocols when the user holds none.
