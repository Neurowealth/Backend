# Stress Testing — Named Historical Scenarios (#351)

**Caveat (shipped with every response):** Scenarios apply a fixed, historically-calibrated shock to your current holdings. They are not predictions and do not model correlations between shocks or your own or others' reactions.

## Built-in scenarios (6, each with provenance)

| id | label | shocks | recoveryDays | provenance |
|---|---|---|---|---|
| `stablecoin_depeg_2022` | 2022 Stablecoin De-peg | `assetPriceShockPct: {USD_STABLECOIN:-8}` | 45 | Terra UST May 2022 + USDC Mar 2023 de-peg ~8% (Luna Foundation Guard, Circle) |
| `yield_collapse` | DeFi Yield Collapse | `apyShockPct:-60, incentiveApyToZero:true` | 90 | DeFi Summer 2021 → Bear 2022 supply APYs -60% (DeFi Llama) |
| `protocol_exploit` | Protocol Exploit Haircut | `protocolLossPct: Blend/Luma/Stellar DEX 30%` | 30 | Wormhole Feb 2022 $325m, Nomad Aug 2022 avg 30% haircut |
| `liquidity_crunch` | Liquidity Crunch (2023) | `assetPrice -2% stable, apy -40%` | 60 | 2023 US banking stress (SVB) 2% stable dislocation, yields -40% (Fed, DeFi Llama) |
| `rate_spike` | Rate Spike Opportunity | `apy +50%` | 30 | Fed Funds 2022-2023 0.25%→5.25% (Fed H.15) |
| `bear_market_2022` | Broad Bear Market | `asset -5% stable/-15% XLM, apy -30%, protocolLoss 5%` | 180 | BTC -65%, DeFi TVL -75% 2022 (CoinGecko) |

Asset keys matched by predicate: `USD_STABLECOIN`/`STABLECOIN` matches `USDC|USDT|DAI|USD*` case-insensitive; `XLM` matches `XLM`; else exact symbol case-insensitive. Response lists which positions each shock hit.

## Model

*   **Order fixed:** `protocolLoss` (principal) → `assetPriceShock` → `apyShock`/`incentiveApyToZero` (forward yield only). Overlapping shocks on one position compound in that order.
*   **Incentive fallback:** `incentiveApyToZero` with `incentiveApy==null` assumes 15% share (`apy*0.85`) and sets `assumedIncentiveShare:true` + caveat.
*   **Recovery:** `dailyYield = postValue * (postYield%/100)/365`. `modeledRecoveryDays = ceil(|impact|/dailyYield)`. If `postYield ≤0` → `null` + `permanentImpairment:true`. Linear path documented; `recoveryDays` is assumption for time-to-recover.
*   **Degenerate:** empty `ACTIVE` positions → `null` with `reason:"no active positions"`. Never fake 0 impact.
*   **Bounds:** custom `|price|≤90`, `apyShock≥-100`, `0≤protocolLoss≤90`, `1≤recoveryDays≤365`; rejected 400.
*   **Determinism:** pure `applyScenario(portfolio, scenario, asOf)` — no wall-clock; `asOf` snapshot in result.

## API

*   `GET /api/v1/analytics/stress/scenarios` → `{scenarios, caveat}` owner-scoped.
*   `POST /api/v1/analytics/stress` body `{scenarioId}` or `{custom:{shocks}}` + `runAll?:boolean, asOf?:ISO` → single result or `runAll` ranked by `impactPct` (most negative first). Always `caveat` field.

## Limits

*   O(positions) compute, rate-limited like other analytics reads.
*   No correlation/second-order modeling, no optimizer integration, no auto-derisking.
