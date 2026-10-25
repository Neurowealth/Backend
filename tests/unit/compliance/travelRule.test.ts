import { detectTravelRule } from '../../../src/compliance/travelRule'
import { Request, Response, NextFunction } from 'express'
import db from '../../../src/db'

let memoryRecords: any[] = []

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    travelRuleRecord: {
      create: jest.fn().mockImplementation(async (args) => {
        const record = { ...args.data }
        memoryRecords.push(record)
        return record
      }),
      findFirst: jest.fn().mockImplementation(async (args) => {
        return (
          memoryRecords.find(
            (r) => r.transactionId === args.where.transactionId
          ) || null
        )
      }),
    },
  },
}))

describe('Travel Rule Records (#391)', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: NextFunction

  beforeEach(() => {
    memoryRecords = []
    jest.clearAllMocks()
    req = {}
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }
    next = jest.fn()
  })

  describe('detectTravelRule', () => {
    const mockDbUser = {
      id: 'user-123',
      walletAddress: 'GABC123...',
      displayName: 'Test User',
      email: 'test@example.com',
      network: 'TESTNET',
    }

    it('populates originator and beneficiary when user data is available', async () => {
      ;(db.user.findUnique as jest.Mock).mockResolvedValueOnce(
        mockDbUser as any
      )

      await detectTravelRule(1500, 'tx-abc-123', 'OUTBOUND', 'user-123')

      const record = await db.travelRuleRecord.findFirst({
        where: { transactionId: 'tx-abc-123' },
      })

      expect(record).toBeDefined()
      expect(record?.originator).toBeDefined()
      expect(record?.beneficiary).toBeDefined()
      expect((record?.originator as any)?.name).toBe('Test User')
      expect((record?.beneficiary as any)?.name).toBe('Test User')
      expect(record?.status).toBe('READY')
    })

    it('sets status to PENDING_DATA when user data is missing', async () => {
      ;(db.user.findUnique as jest.Mock).mockResolvedValueOnce(null as any)

      await detectTravelRule(1500, 'tx-def-456', 'INBOUND', 'user-nonexistent')

      const record = await db.travelRuleRecord.findFirst({
        where: { transactionId: 'tx-def-456' },
      })

      expect(record).toBeDefined()
      expect(record?.status).toBe('PENDING_DATA')
      expect(record?.originator).toEqual({})
      expect(record?.beneficiary).toEqual({})
    })

    it('creates record when amount is above threshold', async () => {
      ;(db.user.findUnique as jest.Mock).mockResolvedValueOnce(
        mockDbUser as any
      )

      await detectTravelRule(2000, 'tx-ghi-789', 'OUTBOUND', 'user-123')

      const record = await db.travelRuleRecord.findFirst({
        where: { transactionId: 'tx-ghi-789' },
      })

      expect(record).toBeDefined()
      expect(record?.amountBaseCcy).toBe(2000)
      expect(record?.direction).toBe('OUTBOUND')
      expect(record?.baseCurrency).toBe('USD')
    })

    it('does not create record when amount is below threshold', async () => {
      ;(db.user.findUnique as jest.Mock).mockResolvedValueOnce(
        mockDbUser as any
      )

      await detectTravelRule(500, 'tx-jkl-012', 'INBOUND', 'user-123')

      const record = await db.travelRuleRecord.findFirst({
        where: { transactionId: 'tx-jkl-012' },
      })

      expect(record).toBeNull()
    })
  })
})
