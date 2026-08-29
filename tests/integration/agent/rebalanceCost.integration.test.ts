/**
 * Integration test: #347 rebalance cost model + payback gate
 *
 * The grounded cost model (network fee + slippage + entry/exit) feeds a payback
 * gate that decides whether a move is worth it. This exercises the full
 * `executeRebalanceIfNeeded` → `compareProtocols` path with DB/Stellar mocked and
 * asserts that:
 *  - A marginal/unprofitable move (cost not being recouped in time) is NOT
 *    executed — no Stellar rebalance transaction is submitted.
 *  - A clearly profitable move that clears the payback gate IS executed.
 */

import { executeRebalanceIfNeeded } from '../../../src/agent/router'

// ---- mock external dependencies ----------------------------------------

const mockSubmitRebalance = jest.fn()
jest.mock('../../../src/stellar/contract', () => ({
  triggerRebalance: (...args: unknown[]) => mockSubmitRebalance(...args),
}))

const mockScanAllProtocols = jest.fn()
const mockGetCurrentOnChainApy = jest.fn()
jest.mock('../../../src/agent/scanner', () => ({
  scanAllProtocols: (...args: unknown[]) => mockScanAllProtocols(...args),
  getCurrentOnChainApy: (...args: unknown[]) =>
    mockGetCurrentOnChainApy(...args),
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockAgentLogCreate = jest.fn().mockResolvedValue({ id: 'log-1' })
const mockTransactionCreate = jest
  .fn()
  .mockImplementation(({ data }: any) => ({ id: 'txn-1', ...data }))
const mockPositionFindFirst = jest.fn().mockResolvedValue(null)
const mockPositionFindMany = jest.fn().mockResolvedValue([])
const mockOutboxOpCreate = jest.fn().mockResolvedValue({ id: 'op-1' })
const mockOutboxOpFindUnique = jest.fn().mockResolvedValue(null)

jest.mock('../../../src/db', () => {
  const client: any = {
    agentLog: { create: (...a: unknown[]) => mockAgentLogCreate(...a) },
    transaction: { create: (...a: unknown[]) => mockTransactionCreate(...a) },
    position: {
      findFirst: (...a: unknown[]) => mockPositionFindFirst(...a),
      findMany: (...a: unknown[]) => mockPositionFindMany(...a),
    },
    outboxOp: {
      create: (...a: unknown[]) => mockOutboxOpCreate(...a),
      findUnique: (...a: unknown[]) => mockOutboxOpFindUnique(...a),
    },
  }
  client.$transaction = (fn: (tx: unknown) => unknown) => fn(client)
  return { __esModule: true, default: client }
})

jest.mock('../../../src/outbox/dispatcher', () => ({
  dispatchInBackground: jest.fn(),
}))

// ------------------------------------------------------------------------

describe('#347 rebalance cost payback gate (integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockScanAllProtocols.mockResolvedValue([
      {
        name: 'Luma',
        apy: 8.5,
        assetSymbol: 'USDC',
        lastUpdated: new Date(),
        isAvailable: true,
      },
    ])
    mockGetCurrentOnChainApy.mockResolvedValue(3.0)
    mockSubmitRebalance.mockResolvedValue({ hash: 'tx-hash-001' })
    mockPositionFindFirst.mockResolvedValue({
      id: 'pos-rep',
      userId: 'user-1',
      positionId: 'pos-big',
      assetSymbol: 'USDC',
      user: { network: 'MAINNET' },
    })
  })

  it('blocks an unprofitable move: tiny position whose cost never recoups', async () => {
    // A ~0.001 USDC (18-decimals) position is worth ~$0.001. The modeled
    // network fee ($0.50 fallback) dwarfs it, so fee% is enormous and the
    // payback gate rejects the move even though APY jumps 3% → 8.5%.
    const result = await executeRebalanceIfNeeded('Blend', [
      { id: 'pos-tiny', amount: '1000000000000000', userId: 'user-1' },
    ])

    expect(result).toBeNull()
    // No rebalance was even enqueued — the payback gate held.
    expect(mockTransactionCreate).not.toHaveBeenCalled()
    expect(mockOutboxOpCreate).not.toHaveBeenCalled()
  })

  it('executes a clearly profitable move that clears the payback gate', async () => {
    // A $10,000 position moving 3% → 8.5% clears the gate (fee% is negligible,
    // payback is a fraction of a day) so a durable OutboxOp rebalance IS enqueued.
    const result = await executeRebalanceIfNeeded('Blend', [
      { id: 'pos-big', amount: '10000000000000000000000', userId: 'user-1' },
    ])

    expect(result).not.toBeNull()
    expect(mockTransactionCreate).toHaveBeenCalledTimes(1)
    expect(mockOutboxOpCreate).toHaveBeenCalledTimes(1)
  })
})
