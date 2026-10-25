# Fiat and Portfolio Input Constraints

## Fiat requests

`POST /api/fiat/quote`, `GET /api/fiat/quotes`, and `POST /api/fiat/orders`
accept fiat amounts from **1 through 100,000 inclusive**, expressed in the
currency's major unit. Values must be finite numbers. Currency codes are
three ASCII letters; lowercase input is normalized to uppercase. A syntactically
valid ISO-style code may still be unsupported by a selected provider, in which
case the provider returns its normal availability error.

Out-of-range amounts, non-finite values, and malformed currency codes receive a
`400` validation response with a field path and a clear reason. The limits are
centralized in `src/config/financial-limits.ts` and pinned by
`tests/unit/validators/fiat-validators.test.ts`.

## Portfolio transactions

Deposit and withdrawal amounts must be finite, positive token amounts. Stellar
amounts are represented in stroops (10,000,000 stroops per token); the largest
accepted value is `Number.MAX_SAFE_INTEGER / 10,000,000`, which keeps the stroop
conversion within JavaScript's exact integer range. Values must represent at
least one stroop and support no more than seven decimal places. Larger values,
sub-stroop values, excess precision, and non-finite numbers are rejected with
`400` before an on-chain transaction is queued.