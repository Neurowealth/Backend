import {
  claimDueFiatPurchasePlan,
  executeFiatPurchasePlan,
  evaluateQuoteSlippage,
  handleFiatOrderSettledForPlan,
  handleFiatOrderFailedForPlan,
  sweepInFlightPlanRuns,
  generateFiatPurchasePreview,
  FIAT_PURCHASE_EXECUTING_LEASE_MS,
  RUN_STUCK_TIMEOUT_MS,
} from '../../../src/jobs/fiatPurchases'
import {
  getBestExecutionQuote,
  createFiatOrder,
} from '../../../src/fiat/service'
import { NoHealthyProvidersError, FiatOrderError } from '../../../src/fiat/types'
import { executeDeposit } from '../../../src/controllers/transaction-controller'
import { publishUserEvent } from '../../../src/events/publisher'
import { alertingService } from '../../../src/services/alerting'
import { paymentMethodRefSchema } from '../../../src/validators/fiat-validators'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
  logBackgroundJob: jest.fn(),
}))
jest.mock('../../../src/fiat/service', () => ({
  getBestExecutionQuote: jest.fn(),
  createFiatOrder: jest.fn(),
}))
jest.mock('../../../src/controllers/transaction-controller', () => ({
  executeDeposit: jest.fn(),
}))
jest.mock('../../../src/events/publisher', () => ({
  publishUserEvent: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/services/alerting', () => ({
  alertingService: { emit: jest.fn().mockResolvedValue({ sent: true }) },
}))

const mockGetQuote = getBestExecutionQuote as jest.Mock
const mockCreateOrder = createFiatOrder as jest.Mock
const mockExecuteDeposit = executeDeposit as jest.Mock
const mockPublishEvent = publishUserEvent as jest.Mock
const mockAlertEmit = alertingService.emit as jest.Mock

function createMockDb() {
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'user-1',
        isActive: true,
        walletAddress: 'GUSERWALLET1234567890',
      }),
    },
    custodialWallet: {
      findUnique: jest.fn().mockResolvedValue({
        publicKey: 'GCUSTODIAL1234567890',
      }),
    },
    complianceCase: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    fiatPurchasePlan: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn().mockImplementation(async ({ data }: any) => data),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    fiatPurchasePlanRun: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(async ({ data }: any) => ({
        id: 'run-1',
        ...data,
      })),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => ({
        id: where.id,
        ...data,
      })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    fiatOrder: {
      findUnique: jest.fn(),
    },
    auditPayloadHash: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
  } as any
}

function basePlan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plan-1',
    userId: 'user-1',
    fiatAmount: 100,
    fiatCurrency: 'USD',
    assetSymbol: 'USDC',
    paymentMethodRef: 'pm_tok_visa_4242',
    cadence: 'WEEKLY',
    nextRunAt: new Date('2026-10-20T00:00:00.000Z'),
    status: 'ACTIVE',
    autoDeposit: true,
    maxSlippagePct: 0.02,
    baselineRate: 1.0,
    retryPolicy: { maxAttempts: 3, backoffMinutes: 15 },
    consecutiveFailures: 0,
    lastRunAt: null,
    lastRunStatus: null,
    ...overrides,
  }
}

describe('Scheduled Fiat Purchases (#361)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('paymentMethodRefSchema PCI guard', () => {
    it('accepts opaque provider payment tokens and rejects raw 13-19 digit card PANs', () => {
      expect(paymentMethodRefSchema.safeParse('pm_moonpay_tok_98a7bc').success).toBe(
        true
      )
      expect(paymentMethodRefSchema.safeParse('4242424242424242').success).toBe(
        false
      )
      expect(
        paymentMethodRefSchema.safeParse('4242-4242-4242-4242').success
      ).toBe(false)
      expect(
        paymentMethodRefSchema.safeParse('4242 4242 4242 4242').success
      ).toBe(false)
    })
  })

  describe('claimDueFiatPurchasePlan atomic concurrency claim', () => {
    it('atomically claims a due ACTIVE plan and blocks a second worker from double-claiming', async () => {
      const db = createMockDb()
      const plan = basePlan()
      const now = new Date('2026-10-20T00:05:00.000Z')

      db.fiatPurchasePlan.findUnique
        .mockResolvedValueOnce(plan)
        .mockResolvedValueOnce({
          ...plan,
          lastRunStatus: 'executing',
          lastRunAt: now,
        })
        .mockResolvedValueOnce({
          ...plan,
          lastRunStatus: 'executing',
          lastRunAt: now,
        })

      const firstClaim = await claimDueFiatPurchasePlan('plan-1', now, db)
      expect(firstClaim).not.toBeNull()
      expect(db.fiatPurchasePlan.updateMany).toHaveBeenCalledTimes(1)

      // Second concurrent worker sees lastRunStatus='executing' within lease window
      const secondClaim = await claimDueFiatPurchasePlan('plan-1', now, db)
      expect(secondClaim).toBeNull()
    })

    it('reclaims a stale executing claim after FIAT_PURCHASE_EXECUTING_LEASE_MS', async () => {
      const db = createMockDb()
      const staleAt = new Date('2026-10-20T00:00:00.000Z')
      const now = new Date(
        staleAt.getTime() + FIAT_PURCHASE_EXECUTING_LEASE_MS + 1000
      )
      const stalePlan = basePlan({
        lastRunStatus: 'executing',
        lastRunAt: staleAt,
      })

      db.fiatPurchasePlan.findUnique
        .mockResolvedValueOnce(stalePlan)
        .mockResolvedValueOnce({ ...stalePlan, lastRunAt: now })

      const reclaimed = await claimDueFiatPurchasePlan('plan-1', now, db)
      expect(reclaimed).not.toBeNull()
    })
  })

  describe('evaluateQuoteSlippage & skipped_rate guard', () => {
    it('skips execution and emits fiat_purchase.skipped when live quote is worse than baseline by > maxSlippagePct', async () => {
      const db = createMockDb()
      const plan = basePlan({ baselineRate: 1.0, maxSlippagePct: 0.02 })
      const now = new Date('2026-10-20T00:05:00.000Z')

      mockGetQuote.mockResolvedValue({
        best: {
          provider: 'moonpay',
          quoteId: 'quote-1',
          cryptoAmount: 95,
          rate: 0.95, // 5% worse than 1.0 > 2% maxSlippagePct
        },
        quotes: [],
        excluded: [],
      })

      const res = await executeFiatPurchasePlan(plan, now, db)
      expect(res.status).toBe('skipped_rate')
      expect(mockCreateOrder).not.toHaveBeenCalled()
      expect(mockPublishEvent).toHaveBeenCalledWith(
        'user-1',
        expect.any(String),
        'fiat_purchase.skipped',
        expect.objectContaining({
          planId: 'plan-1',
          reason: 'skipped_rate',
        })
      )
      expect(db.auditPayloadHash.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ kind: 'RUN_SKIPPED_RATE' }),
        })
      )
    })

    it('re-quotes once when quote lock expires mid-run and skips if refreshed quote violates slippage', async () => {
      const db = createMockDb()
      const plan = basePlan({ baselineRate: 1.0, maxSlippagePct: 0.02 })
      const now = new Date('2026-10-20T00:05:00.000Z')

      mockGetQuote
        .mockResolvedValueOnce({
          best: {
            provider: 'moonpay',
            quoteId: 'quote-expired',
            cryptoAmount: 99,
            rate: 0.99,
          },
          quotes: [],
          excluded: [],
        })
        .mockResolvedValueOnce({
          best: {
            provider: 'moonpay',
            quoteId: 'quote-fresh',
            cryptoAmount: 94,
            rate: 0.94, // 6% worse > 2%
          },
          quotes: [],
          excluded: [],
        })

      mockCreateOrder.mockRejectedValueOnce(
        new FiatOrderError('quote_expired', 409, 'Quote expired')
      )

      const res = await executeFiatPurchasePlan(plan, now, db)
      expect(res.status).toBe('skipped_rate')
      expect(mockGetQuote).toHaveBeenCalledTimes(2)
    })
  })

  describe('settlement -> autoDeposit chaining & idempotency', () => {
    it('chains settled crypto into executeDeposit when autoDeposit=true and emits fiat_purchase.completed', async () => {
      const db = createMockDb()
      const plan = basePlan({ autoDeposit: true })
      const run = {
        id: 'run-1',
        planId: 'plan-1',
        userId: 'user-1',
        fiatOrderId: 'order-1',
        fiatOrderIds: ['order-1'],
        scheduledFor: new Date('2026-10-20T00:00:00.000Z'),
        status: 'awaiting_settlement',
        quotedCryptoAmount: 99.5,
        plan,
      }

      db.fiatPurchasePlanRun.findFirst.mockResolvedValue(run)
      db.fiatOrder.findUnique.mockResolvedValue({
        id: 'order-1',
        status: 'SETTLED',
        settledCryptoAmount: 99.5,
      })
      mockExecuteDeposit.mockResolvedValue({
        status: 'CONFIRMED',
        transaction: { id: 'tx-dep-1', txHash: '0xabc123' },
      })

      const res = await handleFiatOrderSettledForPlan('order-1', db)
      expect(res.handled).toBe(true)
      expect(res.status).toBe('completed')
      expect(res.depositTxId).toBe('tx-dep-1')
      expect(mockExecuteDeposit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          amount: 99.5,
          assetSymbol: 'USDC',
        })
      )
      expect(mockPublishEvent).toHaveBeenCalledWith(
        'user-1',
        expect.any(String),
        'fiat_purchase.completed',
        expect.objectContaining({
          planId: 'plan-1',
          runId: 'run-1',
          depositTxId: 'tx-dep-1',
        })
      )
    })

    it('records completed_deposit_pending without retrying fiat order when executeDeposit fails', async () => {
      const db = createMockDb()
      const plan = basePlan({ autoDeposit: true })
      const run = {
        id: 'run-1',
        planId: 'plan-1',
        userId: 'user-1',
        fiatOrderId: 'order-1',
        fiatOrderIds: ['order-1'],
        scheduledFor: new Date('2026-10-20T00:00:00.000Z'),
        status: 'awaiting_settlement',
        quotedCryptoAmount: 99.5,
        plan,
      }

      db.fiatPurchasePlanRun.findFirst.mockResolvedValue(run)
      db.fiatOrder.findUnique.mockResolvedValue({
        id: 'order-1',
        status: 'SETTLED',
        settledCryptoAmount: 99.5,
      })
      mockExecuteDeposit.mockRejectedValue(new Error('Soroban RPC timeout'))

      const res = await handleFiatOrderSettledForPlan('order-1', db)
      expect(res.handled).toBe(true)
      expect(res.status).toBe('completed_deposit_pending')
      expect(mockCreateOrder).not.toHaveBeenCalled()
    })

    it('is idempotent on duplicate SETTLED webhook delivery and never double-deposits', async () => {
      const db = createMockDb()
      const plan = basePlan({ autoDeposit: true })
      const run = {
        id: 'run-1',
        planId: 'plan-1',
        userId: 'user-1',
        fiatOrderId: 'order-1',
        fiatOrderIds: ['order-1'],
        scheduledFor: new Date('2026-10-20T00:00:00.000Z'),
        status: 'awaiting_settlement',
        quotedCryptoAmount: 99.5,
        plan,
      }

      db.fiatPurchasePlanRun.findFirst.mockResolvedValue(run)
      // Simulate conditional claim returning count: 0 on duplicate delivery
      db.fiatPurchasePlanRun.updateMany.mockResolvedValueOnce({ count: 0 })

      const res = await handleFiatOrderSettledForPlan('order-1', db)
      expect(res.handled).toBe(true)
      expect(res.status).toBe('already_claimed')
      expect(mockExecuteDeposit).not.toHaveBeenCalled()
    })
  })

  describe('soft retries, hard declines, 3-DS action_required, and compliance freeze', () => {
    it('auto-pauses immediately on hard card decline without burning retries', async () => {
      const db = createMockDb()
      const plan = basePlan()
      const run = {
        id: 'run-1',
        planId: 'plan-1',
        userId: 'user-1',
        fiatOrderId: 'order-1',
        fiatOrderIds: ['order-1'],
        scheduledFor: new Date('2026-10-20T00:00:00.000Z'),
        attemptCount: 1,
        status: 'awaiting_settlement',
        plan,
      }
      db.fiatPurchasePlanRun.findFirst.mockResolvedValue(run)

      const res = await handleFiatOrderFailedForPlan(
        'order-1',
        'card_declined_hard: do_not_honor',
        new Date('2026-10-20T00:10:00.000Z'),
        db
      )
      expect(res.status).toBe('failed')
      expect(db.fiatPurchasePlan.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PAUSED',
          }),
        })
      )
    })

    it('schedules exponential backoff retry on soft decline and reuses the same occurrence run', async () => {
      const db = createMockDb()
      const plan = basePlan({
        retryPolicy: { maxAttempts: 3, backoffMinutes: 15 },
      })
      const run = {
        id: 'run-1',
        planId: 'plan-1',
        userId: 'user-1',
        fiatOrderId: 'order-1',
        fiatOrderIds: ['order-1'],
        scheduledFor: new Date('2026-10-20T00:00:00.000Z'),
        attemptCount: 1,
        status: 'awaiting_settlement',
        plan,
      }
      db.fiatPurchasePlanRun.findFirst.mockResolvedValue(run)

      const now = new Date('2026-10-20T00:10:00.000Z')
      const res = await handleFiatOrderFailedForPlan(
        'order-1',
        'soft_decline_issuer_timeout',
        now,
        db
      )
      expect(res.status).toBe('retrying')
      expect(db.fiatPurchasePlanRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'run-1' },
          data: expect.objectContaining({
            status: 'retrying',
            nextRetryAt: new Date(now.getTime() + 15 * 60_000),
          }),
        })
      )
    })

    it('transitions to action_required when provider returns a 3-DS/KYC URL and emits fiat_purchase.action_required', async () => {
      const db = createMockDb()
      const plan = basePlan()
      const now = new Date('2026-10-20T00:05:00.000Z')

      mockGetQuote.mockResolvedValue({
        best: {
          provider: 'moonpay',
          quoteId: 'quote-1',
          cryptoAmount: 100,
          rate: 1.0,
        },
        quotes: [],
        excluded: [],
      })
      mockCreateOrder.mockResolvedValue({
        id: 'order-3ds',
        status: 'PENDING',
        kycUrl: 'https://provider.example/3ds-challenge',
      })

      const res = await executeFiatPurchasePlan(plan, now, db)
      expect(res.status).toBe('action_required')
      expect(mockPublishEvent).toHaveBeenCalledWith(
        'user-1',
        expect.any(String),
        'fiat_purchase.action_required',
        expect.objectContaining({
          actionRequiredUrl: 'https://provider.example/3ds-challenge',
        })
      )
    })

    it('pauses plan without calling ramp provider when user has an active compliance freeze', async () => {
      const db = createMockDb()
      const plan = basePlan()
      db.complianceCase.findFirst.mockResolvedValue({
        id: 'case-1',
        status: 'INVESTIGATING',
      })

      const res = await executeFiatPurchasePlan(plan, new Date(), db)
      expect(res.status).toBe('paused_compliance_freeze')
      expect(mockGetQuote).not.toHaveBeenCalled()
      expect(mockCreateOrder).not.toHaveBeenCalled()
    })

    it('defers run and alerts when all providers are unhealthy (circuit open)', async () => {
      const db = createMockDb()
      const plan = basePlan()
      mockGetQuote.mockRejectedValue(
        new NoHealthyProvidersError([
          { provider: 'moonpay', reason: 'circuit open' },
        ])
      )

      const res = await executeFiatPurchasePlan(plan, new Date(), db)
      expect(res.status).toBe('deferred_unhealthy')
      expect(mockAlertEmit).toHaveBeenCalled()
    })

    it('force-fails awaiting_settlement runs stuck past RUN_STUCK_TIMEOUT_MS and emits critical alert', async () => {
      const db = createMockDb()
      const plan = basePlan()
      const now = new Date('2026-10-22T00:00:00.000Z')
      const stuckUpdatedAt = new Date(
        now.getTime() - RUN_STUCK_TIMEOUT_MS - 60_000
      )

      db.fiatPurchasePlanRun.findMany.mockResolvedValue([
        {
          id: 'run-stuck',
          planId: 'plan-1',
          userId: 'user-1',
          fiatOrderId: 'order-stuck',
          scheduledFor: new Date('2026-10-20T00:00:00.000Z'),
          status: 'awaiting_settlement',
          updatedAt: stuckUpdatedAt,
          plan,
        },
      ])
      db.fiatOrder.findUnique.mockResolvedValue({
        id: 'order-stuck',
        status: 'PROCESSING',
      })

      const stats = await sweepInFlightPlanRuns(now, db)
      expect(stats.stuckFailed).toBe(1)
      expect(mockAlertEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'critical',
          component: 'fiat-purchases',
        }),
        'fiat-purchase:stuck:run-stuck'
      )
    })
  })

  describe('generateFiatPurchasePreview', () => {
    it('projects next N scheduled occurrences with rate and slippage floor disclosure', () => {
      const plan = basePlan({
        fiatAmount: 200,
        baselineRate: 1.0,
        maxSlippagePct: 0.05,
      })
      const preview = generateFiatPurchasePreview({
        plan,
        runs: 4,
        liveRate: 0.98,
      })

      expect(preview.runs).toHaveLength(4)
      expect(preview.runs[0].estimatedCryptoAmount).toBe(196)
      expect(preview.runs[0].minCryptoAmountAfterSlippage).toBe(190)
      expect(preview.disclosure).toContain(
        'amount fixed in fiat, crypto received varies with rate'
      )
    })
  })
})
