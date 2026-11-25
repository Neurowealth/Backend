/**
 * Tests for #766: adjust_strategy validation and strategyConfig merge semantics.
 *
 * - Rejects unpublishable targetAllocations (weights not summing to 100,
 *   missing/empty targetAllocations for TARGET_ALLOCATION, empty protocol keys,
 *   non-finite weights, non-integer riskCeiling) at both argsSchema and
 *   execute() layers.
 * - Merges updated fields into the user's existing strategyConfig so keys the
 *   tool does not own (such as exposureCaps and defaultMaxFraction) survive.
 */

import {
  getModelToolSpecs,
  getTool,
} from '../../../../src/agent/tools/registry'

jest.mock('../../../../src/db', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    position: { findMany: jest.fn() },
    recurringDepositPlan: { create: jest.fn() },
    alertRule: { create: jest.fn() },
    publishedStrategy: { findFirst: jest.fn() },
  },
}))

jest.mock('../../../../src/controllers/transaction-controller', () => ({
  executeDeposit: jest.fn(),
  executeWithdraw: jest.fn(),
}))

jest.mock('../../../../src/agent/router', () => ({
  executeRebalanceIfNeeded: jest.fn(),
  getThresholds: jest.fn(() => ({
    minimumImprovement: 0.5,
    maxGasPercent: 0.1,
  })),
  compareProtocols: jest.fn(),
  logAgentAction: jest.fn(),
}))

jest.mock('../../../../src/agent/breakerService', () => ({
  getBreakerStatusForUser: jest.fn(),
}))

jest.mock('../../../../src/agent/volatilityCircuitBreaker', () => ({
  isPortfolioRebalanceAllowed: jest.fn(),
}))

jest.mock('../../../../src/strategy/service', () => ({
  loadActiveFollowsForUsers: jest.fn(() => new Map()),
  followStrategy: jest.fn(),
  unfollowStrategy: jest.fn(),
  getActiveFollow: jest.fn(),
}))

jest.mock('../../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import db from '../../../../src/db'

const mockCtx = (overrides = {}) => ({
  userId: 'user-766',
  actingAsUserId: null,
  channel: 'api' as const,
  dryRun: false,
  ...overrides,
})

function getAdjustStrategyTool() {
  const tool = getTool('adjust_strategy')
  if (!tool) throw new Error('Unknown tool: adjust_strategy')
  return tool
}

describe('#766 — adjust_strategy validation and config merge', () => {
  const tool = getAdjustStrategyTool()

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('argsSchema validation', () => {
    it('rejects TARGET_ALLOCATION when allocations sum to 150', () => {
      const result = tool.argsSchema.safeParse({
        strategyName: 'TARGET_ALLOCATION',
        targetAllocations: { Blend: 80, Aquarius: 70 },
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(/sum to 100/i)
      }
    })

    it('rejects TARGET_ALLOCATION when allocations sum to less than 100', () => {
      const result = tool.argsSchema.safeParse({
        strategyName: 'TARGET_ALLOCATION',
        targetAllocations: { Blend: 40, Aquarius: 30 },
      })
      expect(result.success).toBe(false)
    })

    it('rejects TARGET_ALLOCATION when targetAllocations is omitted', () => {
      const result = tool.argsSchema.safeParse({
        strategyName: 'TARGET_ALLOCATION',
      })
      expect(result.success).toBe(false)
    })

    it('rejects TARGET_ALLOCATION when targetAllocations is empty', () => {
      const result = tool.argsSchema.safeParse({
        strategyName: 'TARGET_ALLOCATION',
        targetAllocations: {},
      })
      expect(result.success).toBe(false)
    })

    it('rejects MAX_YIELD when supplied targetAllocations sum to 150', () => {
      const result = tool.argsSchema.safeParse({
        strategyName: 'MAX_YIELD',
        targetAllocations: { Blend: 100, Aquarius: 50 },
      })
      expect(result.success).toBe(false)
    })

    it('rejects non-integer riskCeiling', () => {
      const result = tool.argsSchema.safeParse({
        strategyName: 'MAX_YIELD',
        riskCeiling: 50.5,
      })
      expect(result.success).toBe(false)
    })

    it('rejects empty protocol key in targetAllocations', () => {
      const result = tool.argsSchema.safeParse({
        strategyName: 'TARGET_ALLOCATION',
        targetAllocations: { '': 100 },
      })
      expect(result.success).toBe(false)
    })

    it('accepts valid TARGET_ALLOCATION summing to 100', () => {
      const result = tool.argsSchema.safeParse({
        strategyName: 'TARGET_ALLOCATION',
        targetAllocations: { Blend: 60, Aquarius: 40 },
        riskCeiling: 70,
      })
      expect(result.success).toBe(true)
    })

    it('accepts valid MAX_YIELD without targetAllocations', () => {
      const result = tool.argsSchema.safeParse({
        strategyName: 'MAX_YIELD',
        riskCeiling: 60,
      })
      expect(result.success).toBe(true)
    })

    it('serializes cleanly in getModelToolSpecs()', () => {
      const specs = getModelToolSpecs()
      const spec = specs.find((s) => s.name === 'adjust_strategy')
      expect(spec).toBeDefined()
      expect(spec?.input_schema.type).toBe('object')
    })
  })

  describe('execute() validation and config preservation', () => {
    it('rejects allocations summing to 150 on direct execute() without writing to DB', async () => {
      const result = await tool.execute(
        {
          strategyName: 'TARGET_ALLOCATION',
          targetAllocations: { Blend: 80, Aquarius: 70 },
        },
        mockCtx()
      )

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/sum to 100/i)
      expect(db.user.update).not.toHaveBeenCalled()
    })

    it('preserves existing exposureCaps and defaultMaxFraction when updating strategy', async () => {
      const existingExposureCaps = {
        Blend: { maxFraction: 0.4, maxAbsolute: '5000' },
        Aquarius: { maxFraction: 0.6 },
      }
      jest.mocked(db.user.findUnique).mockResolvedValue({
        strategyConfig: {
          strategyName: 'MAX_YIELD',
          exposureCaps: existingExposureCaps,
          defaultMaxFraction: 0.5,
          customUnownedKey: 'keep-me',
        },
      } as any)
      jest.mocked(db.user.update).mockResolvedValue({} as any)

      const result = await tool.execute(
        {
          strategyName: 'TARGET_ALLOCATION',
          targetAllocations: { Blend: 60, Aquarius: 40 },
          riskCeiling: 75,
        },
        mockCtx()
      )

      expect(result.ok).toBe(true)
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: 'user-766' },
        data: {
          rebalanceStrategy: 'TARGET_ALLOCATION',
          strategyConfig: {
            strategyName: 'TARGET_ALLOCATION',
            targetAllocations: { Blend: 60, Aquarius: 40 },
            riskCeiling: 75,
            exposureCaps: existingExposureCaps,
            defaultMaxFraction: 0.5,
            customUnownedKey: 'keep-me',
          },
        },
      })
      expect((result.data as any).strategyConfig.exposureCaps).toEqual(
        existingExposureCaps
      )
      expect((result.data as any).strategyConfig.defaultMaxFraction).toBe(0.5)
    })

    it('preserves existing exposureCaps in dryRun preview without updating DB', async () => {
      const existingExposureCaps = { Blend: { maxFraction: 0.35 } }
      jest.mocked(db.user.findUnique).mockResolvedValue({
        strategyConfig: {
          exposureCaps: existingExposureCaps,
          defaultMaxFraction: 0.5,
        },
      } as any)

      const result = await tool.execute(
        {
          strategyName: 'MAX_YIELD',
          riskCeiling: 80,
        },
        mockCtx({ dryRun: true })
      )

      expect(result.ok).toBe(true)
      expect((result.data as any).preview).toBe(true)
      expect((result.data as any).strategyConfig).toEqual({
        strategyName: 'MAX_YIELD',
        riskCeiling: 80,
        exposureCaps: existingExposureCaps,
        defaultMaxFraction: 0.5,
      })
      expect(db.user.update).not.toHaveBeenCalled()
    })

    it('handles null existing strategyConfig cleanly', async () => {
      jest.mocked(db.user.findUnique).mockResolvedValue({
        strategyConfig: null,
      } as any)
      jest.mocked(db.user.update).mockResolvedValue({} as any)

      const result = await tool.execute(
        {
          strategyName: 'MAX_YIELD',
        },
        mockCtx()
      )

      expect(result.ok).toBe(true)
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: 'user-766' },
        data: {
          rebalanceStrategy: 'MAX_YIELD',
          strategyConfig: {
            strategyName: 'MAX_YIELD',
          },
        },
      })
    })

    it('returns an error when the user is not found', async () => {
      jest.mocked(db.user.findUnique).mockResolvedValue(null)

      const result = await tool.execute(
        { strategyName: 'MAX_YIELD' },
        mockCtx()
      )

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/user not found/i)
      expect(db.user.update).not.toHaveBeenCalled()
    })
  })
})
