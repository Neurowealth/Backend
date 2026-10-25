# Protocol-Risk Protection Fund

## Overview

The Protocol-Risk Protection Fund is a platform-funded reserve pool that makes depositors partially or fully whole after a covered protocol-level loss event. It is funded by a configurable revenue skim and governed by explicit, published coverage terms.

## Coverage Terms

### Covered Events
- **EXPLOIT** — A smart-contract exploit or hack of the protocol
- **INSOLVENCY** — The protocol becomes insolvent (e.g., cannot honor withdrawals)
- **GOVERNANCE_FAILURE** — A governance attack or failure that results in loss of funds

### Excluded Events
- **MARKET_PRICE_LOSS** — Normal market-price movement (this is investing risk, not protocol risk)
- **USER_ERROR** — User sends funds to wrong address, falls for phishing, etc.
- **NORMAL_RISK** — Any loss that is not a protocol-level failure

### Coverage Caps
- **Per-user cap**: `PROTECTION_FUND_PER_USER_CAP` (default: 10,000 USDC)
- **Minimum hold duration**: `PROTECTION_FUND_MIN_HOLD_DURATION_MS` (default: 7 days)
- **Fund balance**: The fund pays out pro-rated when underfunded

## API Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/v1/protection-fund/status` | Public fund balance, coverage terms, historical events | None |
| GET | `/api/v1/protection-fund/my-coverage` | User's exposure in covered protocols + estimated coverage | User |
| POST | `/api/v1/protection-fund/events` | Declare a coverage event (pending review) | Admin |
| POST | `/api/v1/protection-fund/events/:eventId/review` | Approve/reject a declared event | Admin |
| POST | `/api/v1/protection-fund/contributions` | Record a fund contribution | Admin |
| POST | `/api/v1/protection-fund/claims/:claimId/payout` | Execute a claim payout | Admin |

## How It Works

### 1. Fund Accumulation
The fund accrues from a configurable revenue skim (`PROTECTION_FUND_REVENUE_SKIM_FRACTION`, default: 0 = off). When a revenue source (e.g., performance fees) lands, the configured fraction is skimmed into the fund.

### 2. Event Declaration
When a protocol-level loss event occurs:
1. An admin declares the event with protocol name, cause, loss window, and total exposure
2. The event enters `PENDING_REVIEW` status
3. A second admin reviews and approves/rejects (dual-review requirement)

### 3. Claim Computation
Upon approval, claims are computed automatically from position history:
- For each position in the affected protocol during the loss window
- Net loss = deposits - withdrawals - current value
- Payout = min(net loss, per-user cap, remaining fund balance)
- Pro-rated when fund is underfunded

### 4. Payout
Approved claims are paid out via the outbox pattern (durable, audited).

## Transparency

- Fund balance is publicly visible via `GET /protection-fund/status`
- All contributions and payouts are on the audit ledger (#315)
- Historical coverage events are publicly queryable
- Individual claim amounts are private to each user

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `PROTECTION_FUND_REVENUE_SKIM_FRACTION` | `0` | Fraction of revenue skimmed into fund |
| `PROTECTION_FUND_PER_USER_CAP` | `10000` | Max payout per user per event (USDC) |
| `PROTECTION_FUND_MIN_HOLD_DURATION_MS` | `604800000` (7 days) | Minimum position hold before eligible |
| `PROTECTION_FUND_DEFAULT_ASSET` | `USDC` | Default asset symbol for the fund |

## Security

- Fund custody reuses the existing treasury/multisig tiering (#528)
- Every contribution and payout is on the audit ledger (#315)
- Coverage-event declaration requires dual-review (same pattern as SAR case decisions #373)
- Public fund-status transparency is a deliberate trust mechanism
