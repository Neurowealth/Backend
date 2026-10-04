# Inbound Webhook Security

Fiat callbacks enter through `POST /api/fiat/webhook/:provider`. The route reads
the exact raw body and delegates HMAC verification to the selected provider
adapter. A missing provider secret, missing signature, or invalid signature is
rejected with `401` before parsing or processing. Provider secrets must be
configured for every enabled callback integration; there is no unsigned
fallback.

## Freshness and Replay

| Provider | Signed input                      | Freshness                                                                                                 | Replay key                                    |
| -------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| MoonPay  | Unix timestamp and exact raw body | Timestamp must be within 300 seconds of server time, past or future                                       | SHA-256 of exact raw body, scoped by provider |
| Transak  | Exact raw body                    | The provider's body-only signature has no signed timestamp, so freshness cannot be independently enforced | SHA-256 of exact raw body, scoped by provider |
| Sandbox  | Exact raw body                    | The provider's body-only signature has no signed timestamp, so freshness cannot be independently enforced | SHA-256 of exact raw body, scoped by provider |

The receipt table stores only the provider key and SHA-256 body hash, not the
callback payload. It has no automatic expiry: a successfully processed exact
body remains a duplicate indefinitely. A duplicate receives `200` with
`replay: true` so providers stop retrying, and is not processed again. Different
body bytes produce a different nonce. Provider order processing also remains
idempotent and never treats a provider callback alone as on-chain settlement.

For providers that sign no timestamp, the body hash blocks exact replays but
cannot establish when a newly signed body was originally created. Configure
provider-side delivery signing and protect webhook secrets accordingly; a
future provider adapter must implement its documented signed timestamp window
when the provider supports one.

## Failure Behavior

- Invalid or absent HMAC: `401`; no callback side effects.
- Authenticated malformed payload: `400`.
- Replay receipt lookup/storage failure or processing failure: `500`, allowing
  the provider to retry. A receipt is recorded only after processing succeeds.
- Previously processed exact body: `200` with `{ "received": true, "replay": true }`.
- Valid callback, including an unknown order: `200` after idempotent handling.

Timestamp checks depend on synchronized server clocks. Keep production hosts
time-synchronized and alert on repeated signature failures.
