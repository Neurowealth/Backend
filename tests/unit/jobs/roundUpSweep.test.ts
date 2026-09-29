import {
  isExecutingClaimStale,
  claimEligibleAccruals,
  executeUserSweep,
  processRoundUpSweeps,
  ROUND_UP_SWEEP_EXECUTING_LEASE_MS,
} from '../../../src/jobs/roundUpSweep'
import { executeDeposit } from '../../../src/controllers/transaction-controller'

jest.mock('../../../src/controllers/transaction-controller', () => ({
  executeDeposit: jest.fn(),
}))

jest.mock('../../../src/events/publisher', () => ({
  publishUserEvent: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

describe('Round-Up Sweep Job', () => {
  const userId = 'user-sweep-1'
  const walletAddress = 'GWALLET_SWEEP_1'

  let mockAccruals: any[] = []
  let mockSettings: any = null
  let mockGoals: any[] = []
  let mockWallets: any[] = []

  const mockDb: any = {
    roundUpAccrual: {
      findMany: jest.fn(async ({ where, distinct }: any) => {
        if (distinct) {
          const userIds = Array.from(
            new Set(
              mockAccruals
                .filter((a) => !where?.status || a.status === where.status)
                .map((a) => a.userId)
            )
          )
          return userIds.map((u) => ({ userId: u }))
        }
        return mockAccruals.filter((a) => {
          if (where?.userId && a.userId !== where.userId) return false
          if (where?.OR) {
            return where.OR.some((cond: any) => {
              if (cond.status === 'ACCRUED' && a.status === 'ACCRUED')
                return true
              if (
                cond.status === 'EXECUTING' &&
                a.status === 'EXECUTING' &&
                cond.updatedAt?.lt &&
                a.updatedAt < cond.updatedAt.lt
              ) {
                return true
              }
              return false
            })
          }
          return true
        })
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0
        for (const a of mockAccruals) {
          if (where.id?.in?.includes(a.id)) {
            Object.assign(a, data)
            count++
          }
        }
        return { count }
      }),
    },
    roundUpSettings: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (mockSettings && mockSettings.userId === where.userId) {
          return mockSettings
        }
        return null
      }),
    },
    savingsGoal: {
      findUnique: jest.fn(async ({ where }: any) => {
        return mockGoals.find((g) => g.id === where.id) || null
      }),
    },
    custodialWallet: {
      findUnique: jest.fn(async ({ where }: any) => {
        return mockWallets.find((w) => w.userId === where.userId) || null
      }),
    },
    user: {
      findUnique: jest.fn(async () => null),
    },
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockAccruals = []
    mockSettings = {
      userId,
      enabled: true,
      roundToNearest: 1.0,
      multiplier: 1.0,
      targetGoalId: null,
    }
    mockGoals = []
    mockWallets = [{ userId, publicKey: walletAddress }]
  })

  it('detects stale executing claims past lease duration', () => {
    const now = Date.now()
    const freshDate = new Date(now - 1000)
    const staleDate = new Date(
      now - ROUND_UP_SWEEP_EXECUTING_LEASE_MS - 5000
    )

    expect(isExecutingClaimStale(freshDate, now)).toBe(false)
    expect(isExecutingClaimStale(staleDate, now)).toBe(true)
  })

  it('skips claiming when balance is below threshold and not forced', async () => {
    mockAccruals.push({
      id: 'a1',
      userId,
      totalRoundUp: 2.5,
      status: 'ACCRUED',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const { accruals, totalAmount } = await claimEligibleAccruals(
      userId,
      5.0,
      false,
      mockDb
    )
    expect(accruals.length).toBe(0)
    expect(totalAmount).toBe(0)
    expect(mockAccruals[0].status).toBe('ACCRUED')
  })

  it('claims eligible accruals when threshold is met', async () => {
    mockAccruals.push(
      {
        id: 'a1',
        userId,
        totalRoundUp: 3.5,
        status: 'ACCRUED',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'a2',
        userId,
        totalRoundUp: 2.0,
        status: 'ACCRUED',
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    )

    const { accruals, totalAmount } = await claimEligibleAccruals(
      userId,
      5.0,
      false,
      mockDb
    )
    expect(accruals.length).toBe(2)
    expect(totalAmount).toBe(5.5)
    expect(mockAccruals[0].status).toBe('EXECUTING')
    expect(mockAccruals[1].status).toBe('EXECUTING')
  })

  it('claims accruals when forced even below threshold', async () => {
    mockAccruals.push({
      id: 'a1',
      userId,
      totalRoundUp: 1.5,
      status: 'ACCRUED',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const { accruals, totalAmount } = await claimEligibleAccruals(
      userId,
      5.0,
      true,
      mockDb
    )
    expect(accruals.length).toBe(1)
    expect(totalAmount).toBe(1.5)
    expect(mockAccruals[0].status).toBe('EXECUTING')
  })

  it('executes user sweep successfully and updates accruals to SWEPT', async () => {
    mockAccruals.push({
      id: 'a1',
      userId,
      totalRoundUp: 6.0,
      status: 'ACCRUED',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    ;(executeDeposit as jest.Mock).mockResolvedValueOnce({
      status: 'CONFIRMED',
      transaction: { id: 'tx-sweep-123' },
    })

    const result = await executeUserSweep(userId, false, mockDb)
    expect(result.status).toBe('SWEPT')
    expect(result.totalSwept).toBe(6.0)
    expect(result.transactionId).toBe('tx-sweep-123')
    expect(mockAccruals[0].status).toBe('SWEPT')
    expect(mockAccruals[0].sweepTransactionId).toBe('tx-sweep-123')
    expect(mockAccruals[0].sweptAt).toBeInstanceOf(Date)
  })

  it('reverts accruals to ACCRUED when user has no custodial wallet', async () => {
    mockWallets = []
    mockAccruals.push({
      id: 'a1',
      userId,
      totalRoundUp: 10.0,
      status: 'ACCRUED',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const result = await executeUserSweep(userId, true, mockDb)
    expect(result.status).toBe('NO_WALLET')
    expect(mockAccruals[0].status).toBe('ACCRUED')
  })

  it('reverts accruals to ACCRUED when deposit execution fails', async () => {
    mockAccruals.push({
      id: 'a1',
      userId,
      totalRoundUp: 8.0,
      status: 'ACCRUED',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    ;(executeDeposit as jest.Mock).mockRejectedValueOnce(
      new Error('Network RPC timeout')
    )

    const result = await executeUserSweep(userId, true, mockDb)
    expect(result.status).toBe('FAILED')
    expect(mockAccruals[0].status).toBe('ACCRUED')
  })

  it('falls back to default strategy when target savings goal is inactive', async () => {
    mockSettings.targetGoalId = 'goal-inactive-1'
    mockGoals.push({
      id: 'goal-inactive-1',
      userId,
      status: 'ACHIEVED',
    })
    mockAccruals.push({
      id: 'a1',
      userId,
      totalRoundUp: 7.0,
      status: 'ACCRUED',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    ;(executeDeposit as jest.Mock).mockResolvedValueOnce({
      status: 'CONFIRMED',
      transaction: { id: 'tx-fallback-1' },
    })

    const result = await executeUserSweep(userId, true, mockDb)
    expect(result.status).toBe('SWEPT')
    expect(result.targetGoalId).toBeNull()
    expect(executeDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        memo: `round-up:sweep:${userId}`,
      })
    )
  })

  it('processes batch sweeps across multiple users', async () => {
    mockAccruals.push(
      {
        id: 'u1-a1',
        userId: 'user-1',
        totalRoundUp: 6.0,
        status: 'ACCRUED',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'u2-a1',
        userId: 'user-2',
        totalRoundUp: 2.0,
        status: 'ACCRUED',
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    )
    mockWallets.push(
      { userId: 'user-1', publicKey: 'G_U1' },
      { userId: 'user-2', publicKey: 'G_U2' }
    )

    ;(executeDeposit as jest.Mock).mockResolvedValueOnce({
      status: 'CONFIRMED',
      transaction: { id: 'tx-u1' },
    })

    const summary = await processRoundUpSweeps(mockDb)
    expect(summary.sweptCount).toBe(1)
    expect(summary.skippedCount).toBe(1)
    expect(summary.failedCount).toBe(0)
  })
})
