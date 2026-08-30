# Non-Custodial Wallet Architecture — Evaluation & Migration Plan

## Current Architecture (Custodial)

The backend holds user Stellar private keys encrypted at rest (`aes-256-gcm`) in the `custodial_wallets` table. Every deposit and withdrawal goes through `executeCustodialVaultOperation()`, which decrypts the user's key inside the backend process, signs the transaction, and submits it to Stellar.

```
User → POST /api/deposit → transaction-controller.ts
  → contract.depositForUser() → wallet.getKeypairForUser(userId)
    → decrypt secret with WALLET_ENCRYPTION_KEY
    → executeWriteContractCall(method, args, userKeypair)
      → build → simulate → prepare → SIGN(userKeypair) → submit → wait
```

The agent loop (`rebalance`, `update_total_assets`) signs with `STELLAR_AGENT_SECRET_KEY` — this is a separate concern and remains backend-signed (see §4).

## Target Architecture (Non-Custodial)

**User keys never enter the backend.** Deposit and withdrawal transactions are built and simulated server-side, returned as unsigned XDR, signed by the user's Stellar wallet (Freighter), and submitted to Stellar — either directly by the client or through a relay endpoint.

```
User → POST /api/vault/build-transaction
  → contract.buildUnsignedVaultTransaction(method, userAddress, amount, asset)
    → build → simulate → prepare → return unsigned XDR
                                                         ↓
User signs XDR with Freighter (user's private key, client-side)
                                                         ↓
Option A: User submits XDR directly to Stellar network
          (backend event listener picks up the on-chain event)

Option B: User → POST /api/vault/submit-signed-transaction { signedXdr }
          → backend submits to Stellar RPC → returns txHash
          → backend creates Transaction record (status=PENDING)
          → event listener confirms status=CONFIRMED on-chain
```

## 1. Tradeoffs

### Security

| Factor | Custodial (current) | Non-custodial (target) |
|---|---|---|
| Key storage | AES-256-GCM at rest in DB | User holds key in Freighter/extension |
| Key in memory | Decrypted key during every tx | Never in backend memory |
| Backend compromise | Attacker can drain all wallets | Attacker cannot drain — cannot sign |
| WALLET_ENCRYPTION_KEY loss | All wallet keys permanently lost | Not applicable (key not stored) |
| DB backup exposure | Encrypted keys + encryption key = compromise | Only public data |
| User error | Not possible (backend handles signing) | User can lose key / sign wrong tx |
| **Risk: replay** | Backend controls nonce/seq | User signs and submits — backend must verify idempotency via txHash dedup in event listener |
| **Risk: front-running** | Backend controls submission timing | User submits — race with other txs possible |

### User Experience

| Aspect | Custodial | Non-custodial |
|---|---|---|
| Onboarding | Backend generates key silently | User must install Freighter / wallet extension |
| Transaction flow | Single API call | 2-step: build → sign in wallet → submit |
| Mobile support | Works with any HTTP client | Requires wallet SDK (Freighter mobile, WalletConnect) |
| Gas fees | Backend pays (from agent key) | User pays Soroban fees (can be subsidized — see §1c) |
| Recovery | Backend can recover via encrypted backup | User must manage their own seed phrase |
| Speed | Single round-trip | Multi-round-trip with user confirmation |

### Operational Complexity

| Aspect | Custodial | Non-custodial |
|---|---|---|
| Key management | `WALLET_ENCRYPTION_KEY` rotation, backup, audit | Eliminated entirely |
| Compliance | Custodial license / custody obligations in many jurisdictions | Reduced or eliminated |
| Transaction tracking | Backend knows tx outcome synchronously | Must rely on event listener for confirmation |
| Error recovery | Backend can retry with same key | User must re-sign if tx fails (Freighter may not retain) |
| Testing | Single service to test | Needs wallet integration tests (or mock signing) |

### Fee Subsidy Design

For non-custodial flows, the user pays Soroban fees. If the product wants to subsidize fees:
- Build tx with the agent key as the **fee-bump source**, wrapping the user's inner tx in a fee bump transaction.
- Or refund the user out-of-band (e.g., send XLM to their wallet periodically).
- Simplest approach: return the unsigned XDR, let the user sign and submit, and **do not subsidize** — the vault contract already accounts for protocol yield.

## 2. Migration Plan

### Phase 0: Inventory & Safety (current state)

- `buildUnsignedVaultTransaction()` exists and works (`POST /api/vault/build-transaction`).
- No endpoint accepts a signed XDR back for relay submission.
- Frontend does not use the build-transaction endpoint — all traffic goes through custodial `POST /api/deposit` and `POST /api/withdraw`.

### Phase 1: Add Signed Transaction Relay

**Goal**: Provide the missing half of the non-custodial flow — accept a user-signed XDR, submit it, and track the result.

Add `POST /api/vault/submit-transaction`:

```typescript
// src/validators/vault-validators.ts
export const submitTransactionSchema = z.object({
  signedXdr: z.string().min(1, 'signedXdr is required'),
  type: z.enum(['deposit', 'withdraw']),
  amount: z.number().positive(),
})

// src/routes/vault.ts — new route
router.post('/submit-transaction', requireAuth, async (req, res) => {
  const parsed = submitTransactionSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const { signedXdr, type, amount } = parsed.data
  const userId = req.auth!.userId
  const walletAddress = req.auth!.walletAddress

  // Reconstruct the Transaction from XDR
  const tx = TransactionBuilder.fromXDR(signedXdr, getNetworkPassphrase())

  // Verify source account matches the authenticated user
  if (tx.source.accountId() !== walletAddress) {
    return res.status(403).json({ error: 'Transaction source does not match authenticated user' })
  }

  // Verify the transaction targets the vault contract with the correct method
  const operation = tx.operations[0]
  // (validate operation targets VAULT_CONTRACT_ID and method is deposit/withdraw)

  // Check it hasn't been submitted already (idempotency via the event listener)
  const hash = tx.hash().toString('hex')
  const existing = await db.transaction.findUnique({ where: { txHash: hash } })
  if (existing) {
    return res.status(200).json({ txHash: hash, status: existing.status })
  }

  // Submit to Stellar RPC
  const txHash = await submitTransaction(tx)

  // Create a PENDING transaction record so the frontend has immediate feedback
  await db.transaction.create({
    data: {
      userId,
      txHash,
      type: type === 'deposit' ? TransactionType.DEPOSIT : TransactionType.WITHDRAWAL,
      status: TransactionStatus.PENDING,
      amount: String(amount),
      assetSymbol: parsed.data.assetSymbol ?? 'USDC',
      network: extractNetwork(),
    },
  })

  // Fire-and-forget confirmation poll (or rely on event listener)
  waitForConfirmation(txHash).then(result => {
    // Update transaction status based on result
    // The event listener will also catch this, but updating proactively
    // reduces latency for the user
  }).catch(err => {
    logger.error(`[Relay] Confirmation polling failed for ${txHash}:`, err)
  })

  return res.status(200).json({ txHash, status: 'submitted' })
})
```

**Key verifications on the relayed XDR**:
1. Source account === authenticated user's `walletAddress`
2. Operation targets the known `VAULT_CONTRACT_ID`
3. Method is one of `deposit` or `withdraw`
4. `txHash` not already processed (idempotency)
5. Transaction is fully signed (all signatures present)

### Phase 2: Frontend Migration

**Goal**: Move users from custodial API calls to Freighter-signed transactions.

1. Feature-detect Freighter / wallet extension on the web client.
2. For users without a wallet: show onboarding flow (install Freighter, create wallet).
3. Modify the deposit/withdraw UI flow:

   ```
   Old flow:           New flow (non-custodial):
   Enter amount        Enter amount
   Click "Deposit"     Click "Deposit"
   (backend signs)     → POST /api/vault/build-transaction
                       → Receive unsigned XDR
                       → window.freighter.signTransaction(xdr)
                       → POST /api/vault/submit-transaction (signed XDR)
                       → Show confirmation
   ```

4. Run both custodial and non-custodial paths in parallel during migration. Use a feature flag:

   ```typescript
   const USE_NON_CUSTODIAL = process.env.FEATURE_NON_CUSTODIAL === 'true'
   ```

5. Frontend routes:
   - If `USE_NON_CUSTODIAL`: disable custodial deposit/withdraw buttons, route through build→sign→submit flow.
   - If flag off: existing custodial flow unchanged.

### Phase 3: Deprecate Custodial Deposit/Withdraw

**Goal**: Remove backend user-key storage and signing.

1. **Stop creating new custodial wallets**. Remove the `createCustodialWallet()` call from the registration flow. New users authenticate via Stellar challenge (SEP-10-like, already implemented) and use their existing Freighter wallet — no backend-held key needed.

2. **Add a migration endpoint** for existing custodial users to "claim" their wallet:
   ```
   POST /api/vault/claim-wallet
   Body: { signedXdr: "<self-transfer of 0 XLM from custodial key to user's Freighter key>" }
   ```
   This proves the user controls the custodial key. On success, remove the `CustodialWallet` row. The user then uses their Freighter key for all future transactions.

   Alternatively, simply leave existing custodial wallets in place for legacy users and let them migrate at their own pace. New users are non-custodial from day one.

3. **Remove custodial endpoints**:
   - Remove `depositForUser()` / `withdrawForUser()` from `contract.ts`
   - Remove `getKeypairForUser()` and `createCustodialWallet()` from `wallet.ts`
   - Remove `POST /api/deposit` and `POST /api/withdraw` routes (or make them call the build→relay flow)

4. **Drop `custodial_wallets` table** (after all users migrated or after a grace period).

### Phase 4: Cleanup

- Remove `WALLET_ENCRYPTION_KEY` from required env vars.
- Remove the `custodial_wallets` Prisma model and migration.
- Audit logs to ensure no secret material is logged.
- Update documentation and runbook.

## 3. What Stays Backend-Signed

| Operation | Signer | Reason |
|---|---|---|
| `rebalance(protocol, apy)` | `STELLAR_AGENT_SECRET_KEY` | Protocol-level operation, not user-scoped |
| `update_total_assets(amount)` | `STELLAR_AGENT_SECRET_KEY` | Protocol-level accounting, not user-scoped |
| Event listener | — | Read-only (polling RPC, no signing) |
| Auth challenge/verify | — | Only signature verification (user signs nonce) |

These are **agent operations** that mutate vault state based on protocol conditions, not individual user actions. They will continue to use `STELLAR_AGENT_SECRET_KEY`.

## 4. Transaction Confirmation (Event Listener)

The event listener (`src/stellar/events.ts`) already confirms transactions by polling Soroban RPC for contract events. This is **submission-path agnostic** — whether the backend submits or the user submits directly to Stellar, the event listener will:

1. Detect `deposit` / `withdraw` events on-chain.
2. Match by `txHash` against the `transactions` table.
3. Update `status → CONFIRMED` and update position balances.

For the relay path (Phase 1), the backend also proactively polls `getTransaction()` for faster feedback, but the event listener is the source of truth and handles edge cases (e.g., user submits directly to Stellar bypassing the relay).

## 5. Security Considerations (User-Signed Transactions)

### Replay Protection

- The event listener deduplicates by `(contractId, txHash, eventType, ledger)` (see `events.ts:352-368`).
- The `transactions` table has a unique constraint on `txHash`.
- Nonce/sequence number protection is built into Stellar transactions — a submitted transaction cannot be replayed if the sequence number advances.

### Transaction Validation (Relay Path)

Before submitting a user-provided signed XDR, the backend must validate:

1. **Source account** matches `req.auth.walletAddress` — prevents a malicious user from submitting a transaction signed by another user's key.
2. **Contract ID** matches `VAULT_CONTRACT_ID` — prevents the relay from being used to submit arbitrary Stellar transactions.
3. **Method** is `deposit` or `withdraw` — prevents relay of agent-only operations.
4. **Signatures** are present and valid — `tx.signatures.length > 0`. (Full signature verification against the expected source account is ideal but adds complexity; the RPC node will reject invalid signatures on submission.)
5. **txHash** not already processed — prevents duplicate submissions.

### Fee Attack Mitigation

A malicious user could submit a signed transaction with an extremely low fee, causing it to hang in the mempool. Mitigations:
- The relay endpoint should enforce a minimum `fee` on the XDR.
- Or the relay submits with a fee-bump transaction (backed by the agent key) to guarantee inclusion.
- Simplest: accept the risk — the tx will either confirm or expire, and the event listener handles both outcomes cleanly.

## 6. Rollback Plan

If the non-custodial migration causes issues:

| Phase | Rollback |
|---|---|
| Phase 1 (relay endpoint) | Remove the new endpoint; custodial paths continue working |
| Phase 2 (frontend migration) | Flip feature flag `USE_NON_CUSTODIAL=false`; revert to custodial API calls |
| Phase 3 (deprecation) | If `custodial_wallets` still exist, re-enable custodial endpoints. If table is dropped, restore from backup |
| Phase 4 (cleanup) | Re-add `WALLET_ENCRYPTION_KEY` and `custodial_wallets` model if needed (full schema revert) |

## 7. Reserve Sponsorship

Every custodial Stellar account needs a base reserve (1 XLM) plus 0.5 XLM per trustline. Without sponsorship a stablecoin-only user cannot hold assets.

*   **Create:** `buildSponsoredCreateAccount({newAccountId, sponsorKeypair})` wraps `CreateAccount(0)` between `BeginSponsoringFutureReserves`/`EndSponsoringFutureReserves` so the sponsor (from `STELLAR_SPONSOR_KEYS` pool, hash-tracked via `keys/registry.ts`) pays the reserve. `createCustodialWallet` enqueues this via `OutboxOpKind.ACCOUNT_PROVISION` behind `SPONSORED_RESERVES_ENABLED` (default on).
*   **Trustline:** `buildSponsoredTrustline({accountId, asset:` USDC `, sponsor})` sandwiches `ChangeTrust` similarly; only for classic `G...` USDC (Soroban `C...` needs no trustline). Sponsored before first deposit of a new asset.
*   **Ledger:** `ReserveSponsorship` (one row per sponsored entry, `xlmReserved` 1 / 0.5, `status ACTIVE|REVOKED|RECLAIMED`, `ledgerKey` for revoke) tracks outstanding liability (`SUM WHERE ACTIVE` → gauge `reserve_sponsorship_outstanding_xlm`).
*   **Multi-sponsor:** `STELLAR_SPONSOR_KEYS` comma-separated, `pickSponsor()` selects most available XLM above `SPONSOR_MIN_XLM_FLOOR` (default 10 XLM); if none, `503 sponsor_capacity_exhausted` + critical alert, never silently under-reserves.
*   **Revoke:** `buildRevokeSponsorship` leaf-first (trustlines before account) for close; reconciliation job walks on-chain sponsor fields and joins pending outbox before alerting on drift.

See `docs/RUNBOOK.md` #8 and `docs/OUTBOX.md` Fee oracle section for operational details.

## 8. Migration Checklist

- [ ] Phase 1: `POST /api/vault/submit-transaction` endpoint implemented with XDR validation
- [ ] Phase 1: Idempotency check via `txHash` uniqueness
- [ ] Phase 1: Event listener confirms relayed transactions (already works)
- [ ] Phase 2: Frontend Freighter integration for signing
- [ ] Phase 2: Feature flag for parallel custodial/non-custodial paths
- [ ] Phase 2: Wallet onboarding flow for new users without Freighter
- [ ] Phase 3: Existing custodial user migration (claim-wallet or grace period)
- [ ] Phase 3: Remove `depositForUser()` / `withdrawForUser()` from contract.ts
- [ ] Phase 3: Remove `POST /api/deposit` and `POST /api/withdraw` routes
- [ ] Phase 3: Remove `createCustodialWallet()` from registration flow
- [ ] Phase 4: Drop `custodial_wallets` table
- [ ] Phase 4: Remove `WALLET_ENCRYPTION_KEY` env var
- [ ] Phase 4: Update docs/RUNBOOK.md — remove key custody section for user keys
- [ ] Phase 4: Audit logs for secret exposure
