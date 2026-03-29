# Stellar Integration Layer

Bridge between backend and Soroban vault contract.

## Structure

```
src/stellar/
├── client.ts      # RPC server + transaction submission
├── contract.ts    # Vault contract read/write calls
├── events.ts      # Contract event listener
├── wallet.ts      # Custodial wallet management
├── types.ts       # Shared Stellar types
└── index.ts       # Main exports
```

## Usage

```typescript
import {
  getOnChainBalance,
  triggerRebalance,
  startEventListener,
  createCustodialWallet
} from './stellar';
```

## Environment Variables

```bash
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_AGENT_SECRET=SXXX...
VAULT_CONTRACT_ID=CXXX...
WALLET_ENCRYPTION_KEY=<64_hex_chars>
```

## Key Functions

- `getOnChainBalance(address)` - Read user balance
- `triggerRebalance(protocol, apy)` - Execute rebalance
- `startEventListener()` - Monitor blockchain events
- `createCustodialWallet(userId)` - Generate user wallet
- `depositForUser(userId, address, amount)` - Custodial backend-signed vault deposit
- `withdrawForUser(userId, address, amount)` - Custodial backend-signed vault withdrawal

## Signing Strategy

Deposit and withdraw use a custodial signing model. The backend decrypts the user's
encrypted Stellar secret via `src/stellar/wallet.ts`, signs the Soroban transaction
server-side, submits it through the configured RPC server, and returns only the
resulting transaction hash/status. User secrets must never be logged or returned.
