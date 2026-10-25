# Agent Liquidity Floor

`User.liquidityFloor` is a minimum USD-equivalent amount the agent attempts to
keep in positions that can be exited immediately within the configured 0.5%
slippage target. It is evaluated before active goals and strategy allocation;
those controls operate only on the balance above the floor.

## Data Contract

Liquidity snapshots are valid for 24 hours. A position counts toward the floor
only when all of the following hold:

- Its asset is USDC.
- Its protocol has a fresh liquidity snapshot with a valid depth curve.
- The snapshot reports zero withdrawal delay and zero queue depth.
- The position is not locked and has no pending transaction.
- The whole position is exitable within the 0.5% slippage target.

Unknown assets, missing or stale snapshots, invalid depth curves, pending
transactions, and locked positions fail closed. The agent blocks rebalancing
while required liquidity data is unavailable rather than assuming funds are
liquid.

The current collector derives conservative 50-basis-point depth from Horizon's
USDC pool reserves for Stellar DEX. Blend and Luma snapshots are written only
when their API responses explicitly provide withdrawal delay, queue depth, and
depth data. `ProtocolLiquiditySnapshot.withdrawalDelayHours` must be set by the
trusted collector; null means unknown, not zero.

## Agent Behavior

When the floor is already met, the agent allocates no more than total balance
minus the floor and never uses fully liquid positions as rebalance sources.
When there is a shortfall, it considers unlocked positions with known exit times
in shortest-exit order and routes only to protocols with verified immediate
liquidity. Existing strategy risk and rebalance cost/payback gates still apply.
Pending transactions prevent duplicate attempts.

If the floor exceeds the total balance, the agent keeps the full balance out of
yield and reports the shortfall. A configured floor is a restoration target, not
an instantaneous on-chain guarantee; delayed withdrawals and cost gates can
extend restoration time.

## API

- `GET /api/v1/liquidity-floor` returns the authenticated user's configured
  floor, current balances, shortfall, estimated restoration time, and data
  availability.
- `PATCH /api/v1/liquidity-floor` accepts `{ "floorUsd": <non-negative number> }`.
  Send `null` to clear the floor.
