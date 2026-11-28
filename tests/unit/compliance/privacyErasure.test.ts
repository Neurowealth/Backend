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
  ErasureGuardError,
} from '../../../src/compliance/privacyErasure'
import { alertingService } from '../../../src/services/alerting'
import { revokeAllUserSessions } from '../../../src/services/refresh-token.service'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}))
jest.mock('../../../src/services/refresh-token.service', () => ({
  revokeAllUserSessions: jest.fn().mockResolvedValue(2),
}))
jest.mock('../../../src/services/alerting', () => ({
  alertingService: {
    emit: jest.fn().mockResolvedValue({ sent: true }),
  },
}))

const mockDb = db as any
let transactionErasureUpdate: jest.Mock
let txMock: any

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
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
  mockDb.referralConversion = { count: jest.fn() }
  // #934 guard inputs: nothing open or outstanding unless a test says so.
  mockDb.complianceCase = { count: jest.fn().mockResolvedValue(0) }
  mockDb.collateralLoan = { count: jest.fn().mockResolvedValue(0) }
  mockDb.kycProfile = { count: jest.fn() }
  transactionErasureUpdate = jest.fn().mockResolvedValue({})
  txMock = {
    session: { count: jest.fn().mockResolvedValue(5) },
    position: {
      count: jest.fn().mockResolvedValue(3),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    transaction: {
      count: jest.fn().mockResolvedValue(50),
      updateMany: jest.fn().mockResolvedValue({ count: 50 }),
    },
    agentLog: { count: jest.fn().mockResolvedValue(100) },
    webhookSubscription: { count: jest.fn().mockResolvedValue(2) },
    fiatOrder: {
      count: jest.fn().mockResolvedValue(1),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    complianceCase: {
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    collateralLoan: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    kycProfile: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
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
    adminAuditLog: { count: jest.fn().mockResolvedValue(4) },
    referralConversion: { count: jest.fn().mockResolvedValue(2) },
    erasureRequest: { update: transactionErasureUpdate },
    user: {
      create: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    // eraseScalarUserRefs touches these scalar-reference models.
    ...Object.fromEntries(
      [
        'idempotencyRecord',
        'custodialWallet',
        'alertAck',
        'notificationPreferenceAuditLog',
        'webAuthnChallenge',
        'messageDelivery',
        'userEvent',
        'userEventSequence',
        'loanLiquidationEvent',
        'platformBadDebt',
        'coverageClaim',
        'outboxOp',
        'ticketMessage',
        'userDataAudit',
      ].map((model) => [
        model,
        {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      ])
    ),
  }
  mockDb.$transaction = jest.fn((callback: any) => callback(txMock))
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

    it('handles unique constraint violation (P2002) from concurrent creation gracefully', async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: 'user-123',
        walletAddress: 'GA...',
      })
      mockDb.erasureRequest.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'racing-request',
          status: 'PENDING',
        })

      const p2002Error: any = new Error('Unique constraint failed')
      p2002Error.code = 'P2002'
      mockDb.erasureRequest.create.mockRejectedValue(p2002Error)

      await expect(
        createErasureRequest('user-123', 'admin', 'test')
      ).rejects.toThrow(
        'Erasure request already exists for user user-123 with status PENDING'
      )
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
        requestedBy: 'admin@example.com',
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

    it('rejects self-approval by the requester', async () => {
      mockDb.erasureRequest.findUnique.mockResolvedValue({
        id: 'request-1',
        status: ErasureRequestStatus.PENDING,
        userId: 'user-123',
        requestedBy: 'admin-a',
      })

      await expect(
        approveErasureRequest('request-1', 'admin-a')
      ).rejects.toThrow('Self-approval is not allowed')
      expect(mockDb.erasureRequest.update).not.toHaveBeenCalled()
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
    function approvedRequest(userId = 'user-123') {
      mockDb.erasureRequest.findUnique.mockResolvedValue({
        id: 'request-1',
        userId,
        status: ErasureRequestStatus.APPROVED,
        approvedBy: 'admin-b',
        user: { id: userId, walletAddress: 'GABC...' },
      })
    }

    // #934: regulated records must survive, and live blockers refuse erasure.
    describe('regulated records and guards (#934)', () => {
      it('refuses erasure while the user has an OPEN compliance case', async () => {
        approvedRequest()
        mockDb.complianceCase.count.mockResolvedValue(1)

        const attempt = executeErasure(
          'request-1',
          'admin-c',
          'DELETE user-123'
        )

        await expect(attempt).rejects.toBeInstanceOf(ErasureGuardError)
        await expect(attempt).rejects.toMatchObject({ httpStatus: 409 })
        await expect(attempt).rejects.toThrow(/open compliance case/)
        expect(mockDb.complianceCase.count).toHaveBeenCalledWith({
          where: {
            userId: 'user-123',
            status: {
              in: [
                'OPEN',
                'TRIAGE',
                'INVESTIGATING',
                'ESCALATED',
                'PENDING_SAR',
              ],
            },
          },
        })
        // Blocked before the request is claimed or any access is revoked.
        expect(mockDb.erasureRequest.updateMany).not.toHaveBeenCalled()
        expect(revokeAllUserSessions).not.toHaveBeenCalled()
        expect(mockDb.$transaction).not.toHaveBeenCalled()
      })

      it('refuses erasure while the user has an ACTIVE collateral loan', async () => {
        approvedRequest()
        mockDb.collateralLoan.count.mockResolvedValue(1)

        const attempt = executeErasure(
          'request-1',
          'admin-c',
          'DELETE user-123'
        )

        await expect(attempt).rejects.toBeInstanceOf(ErasureGuardError)
        await expect(attempt).rejects.toMatchObject({ httpStatus: 409 })
        await expect(attempt).rejects.toThrow(/outstanding collateral loan/)
        expect(mockDb.collateralLoan.count).toHaveBeenCalledWith({
          where: { userId: 'user-123', status: 'ACTIVE' },
        })
        expect(mockDb.$transaction).not.toHaveBeenCalled()
        expect(txMock.user.delete).not.toHaveBeenCalled()
      })

      it('re-points regulated records at a retention stub before deleting the user', async () => {
        approvedRequest()
        txMock.collateralLoan.findMany.mockResolvedValue([
          { positionId: 'pos-1' },
        ])

        const summary = await executeErasure(
          'request-1',
          'admin-c',
          'DELETE user-123'
        )

        const stub = txMock.user.create.mock.calls[0][0].data
        expect(stub.walletAddress).toBe(`erased:${stub.id}`)
        expect(stub.id).not.toBe('user-123')
        expect(stub.isActive).toBe(false)

        const moved = (model: any) => model.updateMany.mock.calls[0][0]
        expect(moved(txMock.transaction).where).toEqual({ userId: 'user-123' })
        expect(moved(txMock.transaction).data.userId).toBe(stub.id)
        expect(moved(txMock.complianceCase).data.userId).toBe(stub.id)
        expect(moved(txMock.fiatOrder).data.userId).toBe(stub.id)
        expect(moved(txMock.collateralLoan).data.userId).toBe(stub.id)
        expect(moved(txMock.kycProfile).data.userId).toBe(stub.id)
        // The loan's collateral position is retained with the loan.
        expect(txMock.position.updateMany).toHaveBeenCalledWith({
          where: { id: { in: ['pos-1'] } },
          data: { userId: stub.id },
        })

        // Records are moved before the user row goes, never deleted.
        const stubCreated = txMock.user.create.mock.invocationCallOrder[0]
        const txnsMoved =
          txMock.transaction.updateMany.mock.invocationCallOrder[0]
        const userDeleted = txMock.user.delete.mock.invocationCallOrder[0]
        expect(stubCreated).toBeLessThan(txnsMoved)
        expect(txnsMoved).toBeLessThan(userDeleted)
        expect(txMock.transaction.deleteMany).toBeUndefined()
        expect(txMock.complianceCase.deleteMany).toBeUndefined()

        expect(summary.anonymizedRecords).toMatchObject({
          transactions: 50,
          fiatOrders: 1,
          complianceCases: 2,
          kycProfiles: 1,
        })
        expect(summary.deletedRecords).not.toHaveProperty('transactions')
      })

      it('hands the request back (not FAILED) when a case opens mid-erasure', async () => {
        approvedRequest()
        txMock.complianceCase.count.mockResolvedValue(1)

        await expect(
          executeErasure('request-1', 'admin-c', 'DELETE user-123')
        ).rejects.toBeInstanceOf(ErasureGuardError)

        expect(txMock.user.delete).not.toHaveBeenCalled()
        expect(mockDb.erasureRequest.updateMany).toHaveBeenLastCalledWith({
          where: { id: 'request-1', status: ErasureRequestStatus.PROCESSING },
          data: { status: ErasureRequestStatus.APPROVED },
        })
      })
    })

    it('executes an approved erasure request successfully', async () => {
      const requestId = 'request-1'
      const userId = 'user-123'

      mockDb.erasureRequest.findUnique.mockResolvedValue({
        id: requestId,
        userId,
        status: ErasureRequestStatus.APPROVED,
        approvedBy: 'admin-b',
        user: {
          id: userId,
          walletAddress: 'GABC...',
        },
      })

      const summary = await executeErasure(
        requestId,
        'admin-c',
        'DELETE user-123'
      )

      expect(revokeAllUserSessions).toHaveBeenCalledWith(userId, 'admin')

      expect(summary.userId).toBe(userId)
      expect(summary.deletedRecords.sessions).toBe(5)
      expect(summary.anonymizedRecords.transactions).toBe(50)
      expect(summary.anonymizedRecords.complianceCases).toBe(2)
      expect(summary.anonymizedRecords.costBasisLots).toBe(10)
      expect(summary.preservedRecords.adminAuditLogs).toBe(4)
      expect(summary.preservedRecords.referralConversionsAsOwner).toBe(2)
      expect(summary.preservedRecords.referralConversionsAsReferred).toBe(2)
      expect(transactionErasureUpdate).toHaveBeenCalledWith({
        where: { id: requestId },
        data: {
          status: ErasureRequestStatus.COMPLETED,
          completedAt: expect.any(Date),
        },
      })
      expect(alertingService.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Privacy erasure completed',
        })
      )
    })

    it('throws when request is not approved', async () => {
      mockDb.erasureRequest.findUnique.mockResolvedValue({
        id: 'request-1',
        status: ErasureRequestStatus.PENDING,
      })

      await expect(
        executeErasure('request-1', 'admin-c', 'DELETE user-123')
      ).rejects.toThrow('Must be APPROVED')
    })

    it('aborts fast when atomic claim fails due to concurrent execution (CAS race)', async () => {
      const requestId = 'request-1'
      const userId = 'user-123'

      mockDb.erasureRequest.findUnique
        .mockResolvedValueOnce({
          id: requestId,
          userId,
          status: ErasureRequestStatus.APPROVED,
          approvedBy: 'admin-b',
          user: { id: userId, walletAddress: 'GABC...' },
        })
        .mockResolvedValueOnce({
          status: ErasureRequestStatus.PROCESSING,
        })

      // Another execution claimed it first
      mockDb.erasureRequest.updateMany.mockResolvedValue({ count: 0 })

      await expect(
        executeErasure(requestId, 'admin-c', 'DELETE user-123')
      ).rejects.toThrow(
        'Cannot execute request in status PROCESSING. Must be APPROVED.'
      )

      // Losing execution MUST NOT revoke sessions or mark status as FAILED
      expect(revokeAllUserSessions).not.toHaveBeenCalled()
      expect(mockDb.$transaction).not.toHaveBeenCalled()
      expect(mockDb.erasureRequest.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ErasureRequestStatus.FAILED,
          }),
        })
      )
    })

    it('marks request as failed on error and alerts', async () => {
      const requestId = 'request-1'
      mockDb.erasureRequest.findUnique.mockResolvedValue({
        id: requestId,
        userId: 'user-123',
        status: ErasureRequestStatus.APPROVED,
        approvedBy: 'admin-b',
        user: { id: 'user-123', walletAddress: 'GA...' },
      })

      mockDb.$transaction.mockRejectedValue(new Error('Database error'))

      await expect(
        executeErasure(requestId, 'admin-c', 'DELETE user-123')
      ).rejects.toThrow('Database error')

      expect(mockDb.erasureRequest.updateMany).toHaveBeenCalledWith({
        where: { id: requestId, status: ErasureRequestStatus.PROCESSING },
        data: {
          status: ErasureRequestStatus.FAILED,
          errorMessage: 'Database error',
        },
      })
      expect(alertingService.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Privacy erasure failed',
          severity: 'critical',
        })
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
      mockDb.adminAuditLog.count.mockResolvedValue(4)
      mockDb.referralConversion.count
        .mockResolvedValueOnce(3) // referralConversionsAsOwner
        .mockResolvedValueOnce(1) // referralConversionsAsReferred

      const preview = await previewErasure(userId)

      expect(preview.deletedRecords.sessions).toBe(5)
      expect(preview.anonymizedRecords.transactions).toBe(50)
      expect(preview.anonymizedRecords.costBasisLots).toBe(10)
      expect(preview.preservedRecords.adminAuditLogs).toBe(4)
      expect(preview.preservedRecords.referralConversionsAsOwner).toBe(3)
      expect(preview.preservedRecords.referralConversionsAsReferred).toBe(1)
      expect(mockDb.adminAuditLog.count).toHaveBeenCalledWith({
        where: {
          OR: [
            { target: userId },
            { details: { path: ['userId'], equals: userId } },
          ],
        },
      })
      expect(mockDb.referralConversion.count).toHaveBeenCalledWith({
        where: {
          referralCode: {
            ownerUserId: userId,
          },
        },
      })
      expect(mockDb.referralConversion.count).toHaveBeenCalledWith({
        where: {
          referredUserId: userId,
        },
      })
    })
  })
})
