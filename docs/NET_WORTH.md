# Private Net Worth and External Stellar Wallets

`GET /api/v1/net-worth` combines the authenticated user's active platform
positions with balances from explicitly linked external Stellar addresses. Every
holding includes `source: "platform"` or `source: "external"`. External data is
returned only to its linking user; it is not passed to strategy-marketplace
metrics, public track records, tax reporting, or agent decisions.

Session-authenticated users may link/remove addresses directly. API-key callers
need `portfolio:write` for link/remove; reading net worth or listing links is
available to authenticated callers.

## Read-Only and Verification

An external address is **unverified and self-reported**. Linking does not prove
ownership and never grants access to a secret key, signing, transaction
submission, or custody. The service only makes a read-only Horizon account
request. The response and sync batch are bounded; accounts over 100 trustlines
or Horizon responses over 128 KiB fail closed rather than returning partial
balances. A user's auth or custodial wallet address cannot be linked as external.

Unverified values affect only the owner's private net-worth endpoint and a goal
whose owner explicitly enables `includeExternalHoldings`. They cannot affect
anything visible to another user. That flag defaults to `false` for new and
existing goals. External holdings never become platform-manageable positions.
The goal's stored `startingAmount` remains platform-only, and goals opted into
external holdings are excluded from agent strategy selection and agent-loop goal
presence checks.

## Sync, Valuation, and Staleness

The background sync runs every 15 minutes and processes at most 25 wallets per
batch, prioritizing wallets not yet attempted. It reads positive native XLM and
trustline balances; it does not fetch transaction history. Only USDC issued by
the configured `USDC_ISSUER` is assigned the existing 1:1 USD assumption. Other
assets, including XLM, remain visible with `valueUsd: null` and are not silently
counted as zero in a complete valuation. `totalKnownUsd` is therefore a known
subtotal, not a claim that every asset is priced.

Successful snapshots retain their original `lastSyncedAt`. If a later read
fails, the previous balances remain visible with `stale: true`, the last
successful `asOf`, and `syncFailed: true`. Data older than 30 minutes is also
marked stale. Stale snapshots may still contribute to opted-in private goals;
the net-worth response sets `valuationComplete: false`, while goal progress
reports `externalStaleWalletCount` and `unpricedExternalHoldingCount`.

Removing a linked wallet immediately removes it from net-worth and goal
calculations. Existing historical snapshots/reports are not rewritten.
