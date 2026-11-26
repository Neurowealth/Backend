# Email identity account merge semantics

This document records the required behavior for an account merge. The current
email identity API only verifies and suppresses email addresses; it does not
perform account merges. Merge and unmerge must not be exposed until the storage
and transaction lifecycle below is implemented.

## Ownership and conflict matrix

The destination account is the survivor. Its existing records remain
authoritative when both accounts own a record that cannot be combined. Source
records that can be transferred are reassigned to the destination in one
database transaction. Every table with a user foreign key must be explicitly
listed in the merge implementation before it can be enabled.

| Data | Merge rule |
|---|---|
| Savings goals | Keep destination goals; transfer source goals unless a unique constraint conflicts, in which case abort the entire merge for operator resolution. |
| Transactions and positions | Preserve every ledger row and its identifiers; reassign ownership. Never combine balances or delete history. |
| Referral attribution | Keep the destination attribution when present; otherwise transfer the source attribution. Record the conflict in the audit entry. |
| Email identity | Keep the verified identity on the destination. A source identity may be transferred only when the destination has none and the email is still uniquely owned. |
| Sessions and refresh tokens | Revoke all sessions for both accounts atomically with the merge. Both users must authenticate again. |

No conflict is resolved by creation time or query order. A conflict that lacks
an explicit rule aborts the transaction without changing either account.

## Reversibility and audit

A merge must create a durable merge record containing both user IDs, the
operator (or authenticated user), a timestamp, the previous owner and identity
state for every changed row, and an expiry timestamp for undo. The undo window
is 24 hours. During that window, unmerge restores the captured ownership and
identity state in one transaction; new records created after the merge remain
with the destination. After expiry, the merge record is retained as audit
history and the merge becomes irreversible.

Every successful merge and unmerge writes an audit entry in the same database
transaction as its data changes. Concurrent login or refresh operations must
serialize against the merge transaction. A refresh racing with a merge must
either complete before the merge and then be revoked, or observe the revoked
session; it must never issue a token for a split account state.
