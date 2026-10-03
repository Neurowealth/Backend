/**
 * Privacy erasure service tests (#489).
 *
 * Validates the complete erasure workflow:
 * - Request creation and validation
 * - Approval/rejection workflow
 * - Complete data deletion with audit trail
 * - Edge cases and error handling
 */

import db from '../../../src/db'
import {
  createErasureRequest,
  approveErasureRequest,
  rejectErasureRequest,
  executeErasure,
  listErasureRequests,
  previewErasure,
  ErasureRequestStatus,
} from '../../../src/compliance/privacyErasure'
import { alertingService } from '../../../src/services/alerting'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}))
jest.mock('../../../src/services/alerting', () => ({
  alertingService: {
    emit: jest.fn().mockResolvedValue({ sent: true }),
  },
}))

const mockDb = db as any

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.user = {
    findUnique: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  }
  mockDb.erasureRequest = {
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  }
  mockDb.session = { count: jest.fn() }
  mockDb.position = { count: jest.fn() }
  mockDb.transaction = { count: jest.fn() }
  mockDb.agentLog = { count: jest.fn() }
  mockDb.webhookSubscription = { count: jest.fn() }
  mockDb.fiatOrder = { count: jest.fn() }
  mockDb.recurringDepositPlan = { count: jest.fn() }
  mockDb.alertRule = { count: jest.fn() }
  mockDb.savingsGoal = { count: jest.fn() }
  mockDb.subAccount = { count: jest.fn() }
  mockDb.publishedStrategy = { count: jest.fn() }
  mockDb.strategyFollow = { count: jest.fn() }
  mockDb.costBasisLot = { count: jest.fn(), updateMany: jest.fn() }
  mockDb.lotDisposal = { count: jest.fn(), updateMany: jest.fn() }
  mockDb.portfolioAttribution = { count: jest.fn(), updateMany: jest.fn() }
  mockDb.adminAuditLog = { count: jest.fn() }
  mockDb.$transaction = jest.fn((callback: any) =>
    callback({
      session: { count: jest.fn().mockResolvedValue(5) },
      position: { count: jest.fn().mockResolvedValue(3) },
      transaction: { count: jest.fn().mockResolvedValue(50) },
      agentLog: { count: jest.fn().mockResolvedValue(100) },
      webhookSubscription: { count: jest.fn().mockResolvedValue(2) },
      fiatOrder: { count: jest.fn().mockResolvedValue(1) },
      recurringDepositPlan: { count: jest.fn().mockResolvedValue(0) },
      alertRule: { count: jest.fn().mockResolvedValue(1) },
      savingsGoal: { count: jest.fn().mockResolvedValue(0) },
      subAccount: { count: jest.fn().mockResolvedValue(0) },
      publishedStrategy: { count: jest.fn().mockResolvedValue(1) },
      strategyFollow: { count: jest.fn().mockResolvedValue(0) },
      costBasisLot: {
        count: jest.fn().mockResolvedValue(10),
        updateMany: jest.fn().mockResolvedValue({ count: 10 }),
      },
      lotDisposal: {
        count: jest.fn().mockResolvedValue(5),
        updateMany: jest.fn().mockResolvedValue({ count: 5 }),
      },
      portfolioAttribution: {
        count: jest.fn().mockResolvedValue(2),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      adminAuditLog: { count: jest.fn().mockResolvedValue(0) },
      user: { delete: jest.fn().mockResolvedValue({}) },
    })
  )
})

describe('Privacy Erasure Workflow', () => {
  describe('createErasureRequest', () => {
    it('creates a new erasure request when user exists', async () => {
      const userId = 'user-123'
      const requestedBy = 'admin@example.com'
      const reason = 'GDPR right to be forgotten request'

      mockDb.user.findUnique.mockResolvedValue({
        id: userId,
        walletAddress: 'GA...',
        email: 'user@example.com',
      })
      mockDb.erasureRequest.findFirst.mockResolvedValue(null)
      mockDb.erasureRequest.create.mockResolvedValue({
        id: 'request-1',
        userId,
        requestedBy,
        reason,
        status: ErasureRequestStatus.PENDING,
      })

      const result = await createErasureRequest(userId, requestedBy, reason)

      expect(result.status).toBe(ErasureRequestStatus.PENDING)
      expect(mockDb.erasureRequest.create).toHaveBeenCalledWith({
        data: {
          userId,
          requestedBy,
          reason,
          status: ErasureRequestStatus.PENDING,
        },
      })
      expect(alertingService.emit).toHaveBeenCalled()
    })

    it('throws when user does not exist', async () => {
      mockDb.user.findUnique.mockResolvedValue(null)

      await expect(
        createErasureRequest('nonexistent', 'admin', 'test')
      ).rejects.toThrow('User nonexistent not found')
    })

    it('throws when pending request already exists', async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: 'user-123',
        walletAddress: 'GA...',
      })
      mockDb.erasureRequest.findFirst.mockResolvedValue({
        id: 'existing-request',
        status: 'PENDING',
      })

      await expect(
        createErasureRequest('user-123', 'admin', 'test')
      ).rejects.toThrow('Erasure request already exists')
    })
  })

  describe('approveErasureRequest', () => {
    it('approves a pending request', async () => {
      const requestId = 'request-1'
      const approvedBy = 'senior-admin'

      mockDb.erasureRequest.findUnique.mockResolvedValue({
        id: requestId,
        status: ErasureRequestStatus.PENDING,
        userId: 'user-123',
      })
      mockDb.erasureRequest.update.mockResolvedValue({
        id: requestId,
        status: ErasureRequestStatus.APPROVED,
        approvedBy,
        approvedAt: new Date(),
      })

      const result = await approveErasureRequest(requestId, approvedBy)

      expect(result.status).toBe(ErasureRequestStatus.APPROVED)
      expect(result.approvedBy).toBe(approvedBy)
    })

    it('throws when request not found', async () => {
      mockDb.erasureRequest.findUnique.mockResolvedValue(null)

      await expect(
        approveErasureRequest('nonexistent', 'admin')
      ).rejects.toThrow('not found')
    })

    it('throws when request is not pending', async () => {
      mockDb.erasureRequest.findUnique.mockResolvedValue({
        id: 'request-1',
        status: ErasureRequestStatus.APPROVED,
      })

      await expect(approveErasureRequest('request-1', 'admin')).rejects.toThrow(
        'Must be PENDING'
      )
    })
  })

  describe('rejectErasureRequest', () => {
    it('rejects a pending request', async () => {
      const requestId = 'request-1'
      const rejectedBy = 'admin'
      const rejectionReason = 'Duplicate request'

      mockDb.erasureRequest.findUnique.mockResolvedValue({
        id: requestId,
        status: ErasureRequestStatus.PENDING,
      })
      mockDb.erasureRequest.update.mockResolvedValue({
        id: requestId,
        status: ErasureRequestStatus.REJECTED,
        rejectedBy,
        rejectionReason,
      })

      const result = await rejectErasureRequest(
        requestId,
        rejectedBy,
        rejectionReason
      )

      expect(result.status).toBe(ErasureRequestStatus.REJECTED)
    })
  })

  describe('executeErasure', () => {
    it('executes an approved erasure request successfully', async () => {
      const requestId = 'request-1'
      const userId = 'user-123'

      mockDb.erasureRequest.findUnique.mockResolvedValue({
        id: requestId,
        userId,
        status: ErasureRequestStatus.APPROVED,
        user: {
          id: userId,
          walletAddress: 'GABC...',
        },
      })

      const summary = await executeErasure(requestId)

      expect(summary.userId).toBe(userId)
      expect(summary.deletedRecords.sessions).toBe(5)
      expect(summary.deletedRecords.transactions).toBe(50)
      expect(summary.anonymizedRecords.costBasisLots).toBe(10)
      expect(mockDb.erasureRequest.update).toHaveBeenCalledWith({
        where: { id: requestId },
        data: {
          status: ErasureRequestStatus.COMPLETED,
          completedAt: expect.any(Date),
        },
      })
      expect(alertingService.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Privacy erasure completed',
        }),
        expect.any(Number)
      )
    })

    it('throws when request is not approved', async () => {
      mockDb.erasureRequest.findUnique.mockResolvedValue({
        id: 'request-1',
        status: ErasureRequestStatus.PENDING,
      })

      await expect(executeErasure('request-1')).rejects.toThrow(
        'Must be APPROVED'
      )
    })

    it('marks request as failed on error and alerts', async () => {
      const requestId = 'request-1'
      mockDb.erasureRequest.findUnique.mockResolvedValue({
        id: requestId,
        userId: 'user-123',
        status: ErasureRequestStatus.APPROVED,
        user: { id: 'user-123', walletAddress: 'GA...' },
      })

      mockDb.$transaction.mockRejectedValue(new Error('Database error'))

      await expect(executeErasure(requestId)).rejects.toThrow('Database error')

      expect(mockDb.erasureRequest.update).toHaveBeenCalledWith({
        where: { id: requestId },
        data: {
          status: ErasureRequestStatus.FAILED,
          errorMessage: 'Database error',
        },
      })
      expect(alertingService.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Privacy erasure failed',
          severity: 'error',
        }),
        expect.any(Number)
      )
    })
  })

  describe('listErasureRequests', () => {
    it('lists all erasure requests with pagination', async () => {
      mockDb.erasureRequest.findMany.mockResolvedValue([
        { id: 'req-1', status: ErasureRequestStatus.PENDING },
        { id: 'req-2', status: ErasureRequestStatus.APPROVED },
      ])
      mockDb.erasureRequest.count.mockResolvedValue(2)

      const result = await listErasureRequests({ limit: 10, offset: 0 })

      expect(result.requests).toHaveLength(2)
      expect(result.total).toBe(2)
    })

    it('filters by status', async () => {
      mockDb.erasureRequest.findMany.mockResolvedValue([
        { id: 'req-1', status: ErasureRequestStatus.PENDING },
      ])
      mockDb.erasureRequest.count.mockResolvedValue(1)

      const result = await listErasureRequests({
        status: ErasureRequestStatus.PENDING,
      })

      expect(result.requests).toHaveLength(1)
      expect(mockDb.erasureRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: ErasureRequestStatus.PENDING },
        })
      )
    })
  })

  describe('previewErasure', () => {
    it('returns count of records that would be deleted', async () => {
      const userId = 'user-123'

      mockDb.session.count.mockResolvedValue(5)
      mockDb.position.count.mockResolvedValue(3)
      mockDb.transaction.count.mockResolvedValue(50)
      mockDb.agentLog.count.mockResolvedValue(100)
      mockDb.webhookSubscription.count.mockResolvedValue(2)
      mockDb.fiatOrder.count.mockResolvedValue(1)
      mockDb.costBasisLot.count.mockResolvedValue(10)

      const preview = await previewErasure(userId)

      expect(preview.deletedRecords.sessions).toBe(5)
      expect(preview.deletedRecords.transactions).toBe(50)
      expect(preview.anonymizedRecords.costBasisLots).toBe(10)
    })
  })
})
