jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logBackgroundJob: jest.fn(),
}))

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    position: {
      findMany: jest.fn(),
    },
    outboxOp: { findFirst: jest.fn() },
    linkedExternalWallet: {
      findFirst: jest.fn(),
    },
    complianceCase: {
      findFirst: jest.fn(),
    },
    savingsGoal: {
      findMany: jest.fn(),
    },
  },
}))

import db from '../../../src/db'
import {
  resolveWithdrawalAmount,
  checkDestinationRisk,
  checkGoalGuardrailConflict,
} from '../../../src/jobs/recurringWithdrawals'

describe('recurringWithdrawals job helpers', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('resolveWithdrawalAmount', () => {
    it('returns FIXED amount directly', async () => {
      ;(db.position.findMany as jest.Mock).mockResolvedValue([
        { currentValue: 200 },
      ])
      const plan: any = {
        userId: 'user-1',
        assetSymbol: 'USDC',
        amountMode: 'FIXED',
        amount: 150,
      }

      const res = await resolveWithdrawalAmount(plan)
      expect(res.amount).toBe(150)
    })

    it('skips a fixed amount when funds are insufficient', async () => {
      ;(db.position.findMany as jest.Mock).mockResolvedValue([
        { currentValue: 10 },
      ])
      const result = await resolveWithdrawalAmount({
        userId: 'user-1',
        assetSymbol: 'USDC',
        amountMode: 'FIXED',
        amount: 50,
      } as any)
      expect(result).toEqual({ amount: 0, reason: 'insufficient_balance' })
    })

    it('returns yield amount for YIELD_ONLY mode', async () => {
      ;(db.position.findMany as jest.Mock).mockResolvedValue([
        { currentValue: 1000, yieldEarned: 50 },
        { currentValue: 2000, yieldEarned: 30 },
      ])

      const plan: any = {
        userId: 'user-1',
        assetSymbol: 'USDC',
        amountMode: 'YIELD_ONLY',
      }

      const res = await resolveWithdrawalAmount(plan)
      expect(res.amount).toBe(80)
    })

    it('returns percentage of balance for PERCENT_OF_BALANCE mode', async () => {
      ;(db.position.findMany as jest.Mock).mockResolvedValue([
        { currentValue: 1000, yieldEarned: 50 },
        { currentValue: 1000, yieldEarned: 30 },
      ])

      const plan: any = {
        userId: 'user-1',
        assetSymbol: 'USDC',
        amountMode: 'PERCENT_OF_BALANCE',
        percentage: 20,
      }

      const res = await resolveWithdrawalAmount(plan)
      expect(res.amount).toBe(400) // 20% of 2000
    })
  })

  describe('checkDestinationRisk', () => {
    it('returns isRisk: false if address is in prior transactions', async () => {
      ;(db.outboxOp.findFirst as jest.Mock).mockResolvedValue({ id: 'tx-1' })
      ;(db.linkedExternalWallet.findFirst as jest.Mock).mockResolvedValue(null)
      ;(db.complianceCase.findFirst as jest.Mock).mockResolvedValue(null)

      const res = await checkDestinationRisk('user-1', 'GKNOWNADDRESS')
      expect(res.isRisk).toBe(false)
    })

    it('returns isRisk: true if address is unknown', async () => {
      ;(db.outboxOp.findFirst as jest.Mock).mockResolvedValue(null)
      ;(db.linkedExternalWallet.findFirst as jest.Mock).mockResolvedValue(null)
      ;(db.complianceCase.findFirst as jest.Mock).mockResolvedValue(null)

      const res = await checkDestinationRisk('user-1', 'GNEWDESTINATION')
      expect(res.isRisk).toBe(true)
      expect(res.reason).toBe('new_destination_unverified')
    })
  })

  describe('checkGoalGuardrailConflict', () => {
    it('returns conflict: false if no active goal', async () => {
      ;(db.savingsGoal.findMany as jest.Mock).mockResolvedValue([])

      const res = await checkGoalGuardrailConflict('user-1', 'USDC', 100)
      expect(res.conflict).toBe(false)
    })

    it('returns conflict: true if withdrawal would breach targetAmount', async () => {
      ;(db.savingsGoal.findMany as jest.Mock).mockResolvedValue([
        { targetAmount: 1500 },
      ])
      ;(db.position.findMany as jest.Mock).mockResolvedValue([
        { currentValue: 1600 },
      ])

      const res = await checkGoalGuardrailConflict('user-1', 'USDC', 200)
      expect(res.conflict).toBe(true)
    })
  })
})
