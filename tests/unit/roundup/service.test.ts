import {
  getRoundUpSettings,
  updateRoundUpSettings,
  accrueRoundUpForOrder,
  getRoundUpAccruals,
  TargetGoalNotFoundError,
} from '../../../src/roundup/service'

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

describe('Round-Up Savings Service', () => {
  const userId = 'user-123'
  const otherUserId = 'user-999'
  const goalId = 'goal-uuid-1'

  let mockSettings: any = null
  let mockAccruals: any[] = []
  let mockGoals: any[] = []

  const mockDb: any = {
    roundUpSettings: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (mockSettings && mockSettings.userId === where.userId) {
          return mockSettings
        }
        return null
      }),
      upsert: jest.fn(async ({ create, update, where }: any) => {
        if (!mockSettings) {
          mockSettings = {
            id: 'settings-1',
            ...create,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        } else {
          mockSettings = {
            ...mockSettings,
            ...update,
            updatedAt: new Date(),
          }
        }
        return mockSettings
      }),
    },
    savingsGoal: {
      findUnique: jest.fn(async ({ where }: any) => {
        return mockGoals.find((g) => g.id === where.id) || null
      }),
    },
    roundUpAccrual: {
      create: jest.fn(async ({ data }: any) => {
        const item = {
          id: `accrual-${mockAccruals.length + 1}`,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        mockAccruals.push(item)
        return item
      }),
      findMany: jest.fn(async ({ where }: any) => {
        return mockAccruals.filter((a) => a.userId === where.userId)
      }),
    },
  }

  beforeEach(() => {
    mockSettings = null
    mockAccruals = []
    mockGoals = [
      { id: goalId, userId, status: 'ACTIVE' },
      { id: 'goal-other', userId: otherUserId, status: 'ACTIVE' },
    ]
  })

  it('returns default disabled settings when no settings exist', async () => {
    const settings = await getRoundUpSettings(userId, mockDb)
    expect(settings.enabled).toBe(false)
    expect(settings.multiplier).toBe(1.0)
    expect(settings.targetGoalId).toBeNull()
  })

  it('updates settings and persists configuration', async () => {
    const updated = await updateRoundUpSettings(
      userId,
      {
        enabled: true,
        roundToNearest: 1.0,
        multiplier: 2.0,
        targetGoalId: goalId,
      },
      mockDb
    )
    expect(updated.enabled).toBe(true)
    expect(updated.multiplier).toBe(2.0)
    expect(updated.targetGoalId).toBe(goalId)

    const retrieved = await getRoundUpSettings(userId, mockDb)
    expect(retrieved.enabled).toBe(true)
  })

  it('throws TargetGoalNotFoundError when target goal belongs to another user', async () => {
    await expect(
      updateRoundUpSettings(
        userId,
        { targetGoalId: 'goal-other' },
        mockDb
      )
    ).rejects.toThrow(TargetGoalNotFoundError)
  })

  it('skips accrual for OFF_RAMP orders', async () => {
    await updateRoundUpSettings(userId, { enabled: true }, mockDb)
    const result = await accrueRoundUpForOrder(
      {
        id: 'order-1',
        userId,
        direction: 'OFF_RAMP',
        fiatAmount: 49.2,
      },
      mockDb
    )
    expect(result).toBeNull()
    expect(mockAccruals.length).toBe(0)
  })

  it('skips accrual when user has disabled round-up', async () => {
    await updateRoundUpSettings(userId, { enabled: false }, mockDb)
    const result = await accrueRoundUpForOrder(
      {
        id: 'order-2',
        userId,
        direction: 'ON_RAMP',
        fiatAmount: 49.2,
      },
      mockDb
    )
    expect(result).toBeNull()
    expect(mockAccruals.length).toBe(0)
  })

  it('skips accrual when purchase amount is already an exact increment', async () => {
    await updateRoundUpSettings(
      userId,
      { enabled: true, roundToNearest: 1.0 },
      mockDb
    )
    const result = await accrueRoundUpForOrder(
      {
        id: 'order-3',
        userId,
        direction: 'ON_RAMP',
        fiatAmount: 50.0,
      },
      mockDb
    )
    expect(result).toBeNull()
    expect(mockAccruals.length).toBe(0)
  })

  it('records accrual when user is enabled and purchase is non-round', async () => {
    await updateRoundUpSettings(
      userId,
      { enabled: true, roundToNearest: 1.0, multiplier: 2.0 },
      mockDb
    )
    const result = await accrueRoundUpForOrder(
      {
        id: 'order-4',
        userId,
        direction: 'ON_RAMP',
        fiatAmount: 48.75,
      },
      mockDb
    )
    expect(result).not.toBeNull()
    expect(result?.roundUpAmount).toBe(0.25)
    expect(result?.totalRoundUp).toBe(0.5)
    expect(result?.status).toBe('ACCRUED')
    expect(mockAccruals.length).toBe(1)
  })

  it('preserves non-stranding invariant: disabling does not delete accruals', async () => {
    await updateRoundUpSettings(
      userId,
      { enabled: true, roundToNearest: 1.0, multiplier: 1.0 },
      mockDb
    )
    await accrueRoundUpForOrder(
      {
        id: 'order-5',
        userId,
        direction: 'ON_RAMP',
        fiatAmount: 20.3,
      },
      mockDb
    )
    await accrueRoundUpForOrder(
      {
        id: 'order-6',
        userId,
        direction: 'ON_RAMP',
        fiatAmount: 15.6,
      },
      mockDb
    )

    const beforeDisable = await getRoundUpAccruals(userId, mockDb)
    expect(beforeDisable.unsweptCount).toBe(2)
    expect(beforeDisable.unsweptBalance).toBe(1.1)

    await updateRoundUpSettings(userId, { enabled: false }, mockDb)

    const afterDisable = await getRoundUpAccruals(userId, mockDb)
    expect(afterDisable.unsweptCount).toBe(2)
    expect(afterDisable.unsweptBalance).toBe(1.1)
    expect(mockAccruals.length).toBe(2)
  })
})
