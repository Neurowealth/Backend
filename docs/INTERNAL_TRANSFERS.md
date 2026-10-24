# Platform-Internal Transfers (#546)

`POST /api/v1/transfer` sends one asset between two users on the same network.
The recipient is resolved from their eight-character public referral code; raw
user IDs and wallet addresses are not accepted. Users can retrieve their code
from the existing referral-code endpoint.

## Settlement and limits

Settlement atomically reassigns the sender's existing active, unlocked Position
balance to the recipient under the same protocol. It creates paired
`INTERNAL_TRANSFER` transaction history and one durable transfer record, but
does not submit a Stellar transaction. This is a transfer of platform-managed
position ownership, not an on-chain withdrawal and not a separate cash balance.
The v1 path rejects collateral-locked positions, frozen accounts, cross-network
transfers, self-transfers, and transfers while a withdrawal is pending. An
active savings goal is also enforced unless the sender explicitly acknowledges
the impact.

Transfers are immediate and final when the database transaction commits. V1
does not provide a recall or reversal window. The API requires an
`Idempotency-Key`, and recipient-handle resolution is protected by the
authenticated sensitive-operation rate limit. A parent's transfer into a
linked sub-account requires the existing `DEPOSIT` permission.

The compliance scorer evaluates each transfer, including velocity,
structuring, account age, amount anomaly, and a new-destination signal for a
first-time recipient. Scores at or above the existing withdrawal hold threshold
of 70 reject the transfer. Both transfer legs and audit entries are committed
with the position changes. Transaction responses expose the other party's
public handle only, not their internal user ID or wallet address.

## Tax treatment

An internal transfer is an ownership change, not a disposal. No tax disposal
is recorded; open cost-basis lots are split and carried to the recipient with
their original acquisition date and price. Amounts not represented by an open
lot (such as yield or legacy balance) are transferred without a new lot. See
[TAX_REPORT.md](./TAX_REPORT.md) for details.
