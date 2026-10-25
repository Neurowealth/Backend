# Multi-Currency Portfolio Display (#534)

## Overview

Users can set a preferred display currency and see portfolio values converted to that currency across the API. This is strictly a presentation layer — all internal accounting stays USD/token-native.

## How It Works

### Setting Display Currency

```
PUT /api/v1/settings
{ "displayCurrency": "EUR" }
```

Supported currencies: USD, EUR, GBP, JPY, CAD, AUD, CHF, CNY, INR, BRL, MXN, SGD, HKD, KRW

### Response Format

Endpoints that return USD amounts now include additive fields:

```json
{
  "totalBalance": 10000,
  "displayTotalBalance": 9200,
  "displayCurrency": "EUR"
}
```

- `totalBalance` — canonical USD amount (always present, full precision)
- `displayTotalBalance` — converted amount (omitted if FX unavailable)
- `displayCurrency` — the user's preferred currency

### Endpoints Updated

- `GET /api/v1/portfolio/:userId` — adds `displayTotalBalance`, `displayTotalEarnings`, `displayCurrency`
- `GET /api/v1/goals/:id/progress` — adds `displayTargetAmount`, `displayCurrentAmount`, `displayCurrency`

## Important Distinctions

### Display Currency vs Tax Currency

- **Display currency** (#534): Presentation only. Does NOT affect tax calculations.
- **Tax currency** (#356): Determined by jurisdiction profile. Tax reports always use the jurisdiction's native currency per its own rules.

A user seeing their portfolio in GBP does NOT mean their UK tax liability is computed in GBP — that is governed by the jurisdiction profile's tax rules.

### Historical Figures

Historical amounts (past digests, closed tax years) are converted at the **current** FX rate, not the rate at the time. This is documented and labeled — a past USD amount does not retroactively become a different GBP amount.

### Precision

- Display conversions round to 2 decimal places for readability
- Canonical USD amounts keep full Decimal precision
- Rounded display figures never feed back into any calculation

## Configuration

No configuration needed. FX rates are built into `src/utils/fxConvert.ts` and can be updated as needed.

## Graceful Degradation

When an FX rate is unavailable:
- `displayAmount` is omitted (not a wrong guess)
- `displayCurrency` is still echoed
- `amountUsd` is always present regardless

The primary figure is never blocked by a secondary feature's dependency.
