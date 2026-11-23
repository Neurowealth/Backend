/**
 * Unit tests for savings-goal position ownership and the durable
 * single-ACTIVE-goal guard (#790).
 *
 * Before this change a goal could be created against another user's
 * `positionId`. `resolveCurrentAmounts` then read that foreign position's
 * `currentValue`, and `computeGoalProgress` leaked whether the position was
 * still ACTIVE. The partial unique index plus the P2002 mapping also close the
 * race between the `findFirst` pre-check and `create`.
 */
import db from '../../../src/db'
import {
  createGoal,
  computeGoalProgress,
  GoalConflictError,
  GoalNotFoundError,
} from '../../../src/goals/service'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/agent/router', () => ({ logAgentAction: jest.fn() }))
jest.mock('../../../src/agent/scanner', () => ({ scanAllProtocols: jest.fn() }))

const mockDb = db as any
const { logAgentAction } = require('../../../src/agent/router')

const targetDate = new Date(Date.now() + 30 * 86_400_000)

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.savingsGoal = {
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn(),
    create: jest.fn(async ({ data }: any) => ({ id: 'goal-1', ...data })),
    update: jest.fn(),
  }
  mockDb.position = {
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
  }
  mockDb.yieldSnapshot = { findMany: jest.fn().mockResolvedValue([]) }
  mockDb.linkedExternalWallet = {
    findMany: jest.fn().mockResolvedValue([]),
  }
})

describe('createGoal position ownership', () => {
  it('rejects a positionId owned by another user with GoalNotFoundError', async () => {
    mockDb.position.findUnique.mockResolvedValue({
      id: 'pos-1',
      userId: 'someone-else',
      currentValue: 500,
      status: 'ACTIVE',
    })

    await expect(
      createGoal('user-1', {
        targetAmount: 1000,
        targetDate,
        positionId: 'pos-1',
      })
    ).rejects.toBeInstanceOf(GoalNotFoundError)

    expect(mockDb.savingsGoal.create).not.toHaveBeenCalled()
  })

  it('rejects a positionId that does not exist with GoalNotFoundError', async () => {
    mockDb.position.findUnique.mockResolvedValue(null)

    await expect(
      createGoal('user-1', {
        targetAmount: 1000,
        targetDate,
        positionId: 'ghost',
      })
    ).rejects.toBeInstanceOf(GoalNotFoundError)

    expect(mockDb.savingsGoal.create).not.toHaveBeenCalled()
  })

  it('rejects a foreign positionId even when startingAmount is supplied', async () => {
    mockDb.position.findUnique.mockResolvedValue({
      id: 'pos-1',
      userId: 'someone-else',
      currentValue: 500,
      status: 'ACTIVE',
    })

    await expect(
      createGoal('user-1', {
        targetAmount: 1000,
        targetDate,
        positionId: 'pos-1',
        startingAmount: 10,
      })
    ).rejects.toBeInstanceOf(GoalNotFoundError)

    expect(mockDb.savingsGoal.create).not.toHaveBeenCalled()
  })

  it('accepts a positionId owned by the caller', async () => {
    mockDb.position.findUnique.mockResolvedValue({
      id: 'pos-1',
      userId: 'user-1',
      currentValue: 250,
      status: 'ACTIVE',
    })

    const goal = await createGoal('user-1', {
      targetAmount: 1000,
      targetDate,
      positionId: 'pos-1',
    })

    expect(goal.positionId).toBe('pos-1')
    expect(goal.startingAmount).toBe(250)
    expect(goal.status).toBe('ACTIVE')
  })
})

describe('createGoal concurrent-create guard', () => {
  it('maps a P2002 unique violation to GoalConflictError', async () => {
    mockDb.savingsGoal.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    )

    await expect(
      createGoal('user-1', { targetAmount: 1000, targetDate })
    ).rejects.toBeInstanceOf(GoalConflictError)
  })

  it('rethrows unrelated database errors unchanged', async () => {
    const failure = Object.assign(new Error('connection reset'), {
      code: 'P1017',
    })
    mockDb.savingsGoal.create.mockRejectedValue(failure)

    await expect(
      createGoal('user-1', { targetAmount: 1000, targetDate })
    ).rejects.toBe(failure)
  })
})

describe('computeGoalProgress ownership hardening', () => {
  it('cancels an ACTIVE goal whose linked position is no longer owned', async () => {
    const goal = {
      id: 'goal-1',
      userId: 'user-1',
      positionId: 'pos-1',
      targetAmount: 1000,
      startingAmount: 100,
      targetDate,
      status: 'ACTIVE',
      includeExternalHoldings: false,
      riskCeiling: null,
    }
    mockDb.savingsGoal.findUnique
      .mockResolvedValueOnce(goal)
      .mockResolvedValueOnce({ ...goal, status: 'CANCELLED' })
    mockDb.position.findUnique.mockResolvedValue({
      id: 'pos-1',
      userId: 'someone-else',
      currentValue: 900,
      status: 'ACTIVE',
    })

    const progress = await computeGoalProgress('goal-1')

    expect(mockDb.savingsGoal.update).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { status: 'CANCELLED' },
    })
    expect(logAgentAction).toHaveBeenCalled()
    expect(progress.status).toBe('CANCELLED')
    // The foreign position's value must never surface in the projection.
    expect(progress.currentAmount).toBe(0)
  })

  it('does not throw for a terminal goal whose position became foreign', async () => {
    mockDb.savingsGoal.findUnique.mockResolvedValue({
      id: 'goal-1',
      userId: 'user-1',
      positionId: 'pos-1',
      targetAmount: 1000,
      startingAmount: 100,
      targetDate,
      status: 'ACHIEVED',
      includeExternalHoldings: false,
      riskCeiling: null,
    })
    mockDb.position.findUnique.mockResolvedValue({
      id: 'pos-1',
      userId: 'someone-else',
      currentValue: 900,
      status: 'ACTIVE',
    })

    const progress = await computeGoalProgress('goal-1')

    expect(progress.status).toBe('ACHIEVED')
    expect(progress.currentAmount).toBe(0)
  })
})
