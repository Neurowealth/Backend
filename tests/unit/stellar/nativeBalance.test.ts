/**
 * #654 — getNativeBalance must read the on-chain account entry.
 *
 * `rpc.Server.getAccount` returns an Account with only a sequence number, so
 * the balance has to come from `getAccountEntry`, whose `balance()` is in
 * stroops. The fixture below is the shape that call actually returns.
 */
jest.mock('../../../src/utils/rpc-metrics', () => ({
  rpcAttemptCounter: { inc: jest.fn() },
  rpcFailoverCounter: { inc: jest.fn() },
  rpcCircuitOpenCounter: { inc: jest.fn() },
  rpcLatencyHistogram: { startTimer: jest.fn(() => jest.fn()) },
}))

jest.mock('../../../src/config', () => ({
  config: {
    stellar: { network: 'testnet', rpcUrl: 'https://rpc.example.com' },
    httpClient: {
      timeoutMs: 5_000,
      maxRetries: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      circuitBreakerThreshold: 5,
      circuitBreakerResetMs: 60_000,
    },
  },
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import {
  getNativeBalance,
  getResilientClient,
} from '../../../src/stellar/client'

/** Shape of `rpc.Server.getAccountEntry(...)` — an xdr.AccountEntry. */
function rpcAccountEntryFixture(balanceStroops: string, subentryCount = 2) {
  return {
    balance: () => ({ toString: () => balanceStroops }),
    subentryCount: () => subentryCount,
    seqNum: () => ({ toString: () => '9182736450' }),
  }
}

describe('getNativeBalance', () => {
  it('converts the account entry balance from stroops to XLM', async () => {
    const execute = jest
      .spyOn(getResilientClient(), 'execute')
      .mockResolvedValue(rpcAccountEntryFixture('80000000000') as never)

    await expect(getNativeBalance('GHOT')).resolves.toBe(8000)
    expect(execute).toHaveBeenCalledWith(
      expect.any(Function),
      'stellar.getNativeBalance'
    )
  })

  it('returns 0 for an account with no balance', async () => {
    jest
      .spyOn(getResilientClient(), 'execute')
      .mockResolvedValue(rpcAccountEntryFixture('0') as never)

    await expect(getNativeBalance('GHOT')).resolves.toBe(0)
  })
})
