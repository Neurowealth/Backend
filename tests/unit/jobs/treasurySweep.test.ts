import {
  evaluateTreasuryBalances,
  previewTreasurySweep,
  executeSweep,
  executeEmergencySweep,
  validateHysteresis,
} from '../../../src/jobs/treasurySweep'
import db from '../../../src/db'
import { getNativeBalance } from '../../../src/stellar/client'
import { enqueueOutboxOp } from '../../../src/outbox/service'
import { alertingService } from '../../../src/services/alerting'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    treasuryAccount: { findMany: jest.fn() },
    treasurySweepPolicy: { findFirst: jest.fn() },
    treasurySweep: { create: jest.fn(), update: jest.fn() },
    multisigEnvelope: { create: jest.fn() },
    adminAuditLog: { create: jest.fn() },
  },
}))
jest.mock('../../../src/stellar/client', () => ({
  getNativeBalance: jest.fn(),
}))
jest.mock('../../../src/outbox/service', () => ({
  enqueueOutboxOp: jest.fn(),
}))
jest.mock('../../../src/services/alerting', () => ({
  alertingService: { emit: jest.fn().mockResolvedValue({ sent: true }) },
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockDb = db as any
const mockGetNativeBalance = getNativeBalance as jest.Mock
const mockEnqueue = enqueueOutboxOp as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
})

describe('validateHysteresis', () => {
  it('accepts targetHigh at least 1.5x targetLow', () => {
    expect(validateHysteresis(1000, 1500)).toBe(true)
  })

  it('rejects targetHigh under the hysteresis factor', () => {
    expect(validateHysteresis(1000, 1200)).toBe(false)
  })
})

describe('evaluateTreasuryBalances', () => {
  it('plans a sweep when hot balance exceeds policy maxHotBalance by more than minSweepAmount', async () => {
    mockDb.treasurySweepPolicy.findFirst.mockImplementation(
      ({ where }: any) => {
        if (where.fromTier === 'HOT' && where.toTier === 'WARM') {
          return Promise.resolve({
            fromTier: 'HOT',
            toTier: 'WARM',
            maxHotBalance: '5000',
            minSweepAmount: '10',
            requiresApprovalAbove: null,
            isActive: true,
            sweepsEnabled: true,
          })
        }
        return Promise.resolve(null)
      }
    )
    mockDb.treasuryAccount.findMany.mockImplementation(({ where }: any) => {
      if (where.tier === 'HOT') {
        return Promise.resolve([{ id: 'hot-1', publicKey: 'GHOT' }])
      }
      return Promise.resolve([])
    })
    mockGetNativeBalance.mockResolvedValue(8000)

    const plans = await evaluateTreasuryBalances()

    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({
      fromTier: 'HOT',
      toTier: 'WARM',
      reason: 'hot_over_high_band',
    })
  })

  it('produces no plan when no active policy exists for a tier pair', async () => {
    mockDb.treasurySweepPolicy.findFirst.mockResolvedValue(null)
    mockDb.treasuryAccount.findMany.mockResolvedValue([
      { id: 'hot-1', publicKey: 'GHOT' },
    ])

    const plans = await evaluateTreasuryBalances()

    expect(plans).toEqual([])
  })
})

describe('executeSweep', () => {
  it('enqueues a TREASURY_SWEEP outbox op when no approval threshold applies', async () => {
    mockDb.treasurySweepPolicy.findFirst.mockResolvedValue({
      fromTier: 'HOT',
      toTier: 'WARM',
      requiresApprovalAbove: null,
      sweepsEnabled: true,
    })
    mockDb.treasurySweep.create.mockResolvedValue({ id: 'sweep-1' })
    mockDb.treasurySweep.update.mockResolvedValue({})
    mockEnqueue.mockResolvedValue({ id: 'op-1' })

    await executeSweep({
      fromTier: 'HOT',
      toTier: 'WARM',
      asset: 'XLM',
      amount: '1000',
      reason: 'hot_over_high_band',
    })

    expect(mockEnqueue).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        kind: 'TREASURY_SWEEP',
        payload: expect.objectContaining({ method: 'treasury_sweep' }),
      })
    )
    expect(mockDb.treasurySweep.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sweep-1' },
        data: expect.objectContaining({ status: 'SUBMITTED' }),
      })
    )
  })

  it('refuses a sweep above requiresApprovalAbove with an operator-visible error (#655)', async () => {
    mockDb.treasurySweepPolicy.findFirst.mockResolvedValue({
      fromTier: 'HOT',
      toTier: 'WARM',
      requiresApprovalAbove: '500',
      sweepsEnabled: true,
    })

    await expect(
      executeSweep({
        fromTier: 'HOT',
        toTier: 'WARM',
        asset: 'XLM',
        amount: '1000',
        reason: 'hot_over_high_band',
      })
    ).rejects.toThrow(/exceeds requiresApprovalAbove/)

    expect(mockDb.treasurySweep.create).not.toHaveBeenCalled()
    expect(mockDb.multisigEnvelope.create).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(alertingService.emit).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'critical' }),
      expect.stringContaining('treasury-sweep-failed')
    )
  })
})

describe('executeEmergencySweep', () => {
  it('enqueues without checking any policy requiresApprovalAbove', async () => {
    mockDb.treasurySweep.create.mockResolvedValue({ id: 'sweep-3' })
    mockDb.treasurySweep.update.mockResolvedValue({})
    mockEnqueue.mockResolvedValue({ id: 'op-2' })

    await executeEmergencySweep(
      'HOT',
      'COLD',
      'XLM',
      '1000000',
      'admin-1',
      'circuit_breaker_trip'
    )

    expect(mockDb.treasurySweepPolicy.findFirst).not.toHaveBeenCalled()
    expect(mockEnqueue).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ kind: 'TREASURY_SWEEP', priority: 'CRITICAL' })
    )
  })

  it('writes a distinct AdminAuditLog row', async () => {
    mockDb.treasurySweep.create.mockResolvedValue({ id: 'sweep-4' })
    mockDb.treasurySweep.update.mockResolvedValue({})
    mockEnqueue.mockResolvedValue({ id: 'op-3' })

    await executeEmergencySweep(
      'WARM',
      'COLD',
      'XLM',
      '500',
      'admin-1',
      'manual_admin_action'
    )

    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'treasury.emergency_sweep' }),
      })
    )
  })
})

describe('previewTreasurySweep (#620)', () => {
  const policy = {
    id: 'p1',
    version: 3,
    fromTier: 'HOT',
    toTier: 'WARM',
    maxHotBalance: '5000',
    minSweepAmount: '10',
    requiresApprovalAbove: '500',
    isActive: true,
    sweepsEnabled: false,
  }

  beforeEach(() => {
    mockDb.treasurySweepPolicy.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(where.fromTier === 'HOT' ? policy : null)
    )
    mockDb.treasuryAccount.findMany.mockResolvedValue([{ publicKey: 'GHOT' }])
    mockGetNativeBalance.mockResolvedValue(6000)
  })

  it('reports plans for a disabled policy without writing anything', async () => {
    const preview = await previewTreasurySweep()

    expect(preview.plans).toHaveLength(1)
    expect(preview.plans[0]).toMatchObject({
      amount: '1000.0000000',
      policyEnabled: false,
      requiresApproval: true,
      policyId: 'p1',
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockDb.treasurySweep.create).not.toHaveBeenCalled()
    expect(mockDb.treasurySweep.update).not.toHaveBeenCalled()
    expect(mockDb.multisigEnvelope.create).not.toHaveBeenCalled()
  })

  it('evaluateTreasuryBalances ignores a policy that is not enabled', async () => {
    expect(await evaluateTreasuryBalances()).toEqual([])
  })

  it('executeSweep refuses a policy that is not enabled and alerts', async () => {
    await expect(
      executeSweep({
        fromTier: 'HOT',
        toTier: 'WARM',
        asset: 'XLM',
        amount: '1000',
        reason: 'hot_over_high_band',
      })
    ).rejects.toThrow('not enabled')
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockDb.treasurySweep.create).not.toHaveBeenCalled()
    expect(alertingService.emit).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'critical' }),
      expect.stringContaining('treasury-sweep-failed')
    )
  })

  it('executeSweep alerts when enqueueing fails', async () => {
    mockDb.treasurySweepPolicy.findFirst.mockResolvedValue({
      ...policy,
      sweepsEnabled: true,
      requiresApprovalAbove: null,
    })
    mockDb.treasurySweep.create.mockResolvedValue({ id: 'sweep-9' })
    mockEnqueue.mockRejectedValue(new Error('outbox down'))

    await expect(
      executeSweep({
        fromTier: 'HOT',
        toTier: 'WARM',
        asset: 'XLM',
        amount: '1000',
        reason: 'hot_over_high_band',
      })
    ).rejects.toThrow('outbox down')
    expect(alertingService.emit).toHaveBeenCalledTimes(1)
  })
})
