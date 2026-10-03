/**
 * Referral fraud detection tests (#490).
 *
 * Validates fraud detection and manual review workflow:
 * - Fraud pattern detection (duplicate identifiers, IP sharing, velocity)
 * - Risk scoring and blocking logic
 * - Manual review queue
 * - Approval/rejection workflow
 */

import db from '../../../src/db'
import {
  checkReferralFraud,
  attributeSignup,
  approveReferralConversion,
  rejectReferralConversion,
  listConversionsForReview,
  ReferralFraudFlag,
} from '../../../src/referral/service'
import { alertingService } from '../../../src/services/alerting'
import { ReferralStatus } from '@prisma/client'

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
    count: jest.fn(),
  }
  mockDb.referralCode = {
    findUnique: jest.fn(),
  }
  mockDb.referralConversion = {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  }
})

describe('Referral Fraud Detection', () => {
  describe('checkReferralFraud', () => {
    const referredUserId = 'user-referred'
    const referralCodeId = 'code-123'

    beforeEach(() => {
      mockDb.user.findUnique.mockImplementation((query: any) => {
        if (query.where.id === referredUserId) {
          return Promise.resolve({
            walletAddress: 'GABC...',
            email: 'referred@example.com',
            phone: '+1234567890',
            createdAt: new Date(),
            sessions: [{ ipAddress: '192.168.1.100' }],
          })
        }
        return null
      })

      mockDb.referralCode.findUnique.mockResolvedValue({
        id: referralCodeId,
        ownerUserId: 'user-owner',
        code: 'ABC12345',
        owner: {
          walletAddress: 'GXYZ...',
          email: 'owner@example.com',
          phone: '+0987654321',
          sessions: [{ ipAddress: '192.168.1.1' }],
        },
      })

      mockDb.user.count.mockResolvedValue(0)
      mockDb.referralConversion.count.mockResolvedValue(0)
    })

    it('passes clean referral with low risk score', async () => {
      const result = await checkReferralFraud(referredUserId, referralCodeId)

      expect(result.passed).toBe(true)
      expect(result.riskScore).toBeLessThan(80)
      expect(result.requiresManualReview).toBe(false)
      expect(result.flags).toHaveLength(0)
    })

    it('detects duplicate email address', async () => {
      mockDb.user.count.mockImplementation((query: any) => {
        if (query.where?.email) return Promise.resolve(1)
        return Promise.resolve(0)
      })

      const result = await checkReferralFraud(referredUserId, referralCodeId)

      expect(result.flags).toContain(ReferralFraudFlag.DUPLICATE_EMAIL)
      expect(result.riskScore).toBeGreaterThan(0)
      expect(result.details.duplicateEmail).toBe(true)
    })

    it('detects duplicate phone number', async () => {
      mockDb.user.count.mockImplementation((query: any) => {
        if (query.where?.phone) return Promise.resolve(1)
        return Promise.resolve(0)
      })

      const result = await checkReferralFraud(referredUserId, referralCodeId)

      expect(result.flags).toContain(ReferralFraudFlag.DUPLICATE_PHONE)
      expect(result.riskScore).toBeGreaterThan(0)
    })

    it('detects shared IP address between referrer and referred', async () => {
      mockDb.user.findUnique.mockImplementation((query: any) => {
        if (query.where.id === referredUserId) {
          return Promise.resolve({
            walletAddress: 'GABC...',
            sessions: [{ ipAddress: '192.168.1.100' }],
          })
        }
        return null
      })

      mockDb.referralCode.findUnique.mockResolvedValue({
        id: referralCodeId,
        ownerUserId: 'user-owner',
        owner: {
          sessions: [
            { ipAddress: '192.168.1.100' }, // Same IP!
          ],
        },
      })

      const result = await checkReferralFraud(referredUserId, referralCodeId)

      expect(result.flags).toContain(ReferralFraudFlag.SAME_IP_ADDRESS)
      expect(result.riskScore).toBeGreaterThanOrEqual(40)
      expect(result.details.sharedIps).toEqual(['192.168.1.100'])
    })

    it('detects suspicious velocity - many recent conversions', async () => {
      mockDb.referralConversion.count.mockImplementation((query: any) => {
        if (query.where?.createdAt) return Promise.resolve(6) // High velocity
        return Promise.resolve(0)
      })

      const result = await checkReferralFraud(referredUserId, referralCodeId)

      expect(result.flags).toContain(ReferralFraudFlag.SUSPICIOUS_VELOCITY)
      expect(result.details.recentConversions).toBe(6)
    })

    it('detects rapid activation pattern', async () => {
      mockDb.referralConversion.count.mockImplementation((query: any) => {
        if (
          query.where?.status === ReferralStatus.ACTIVATED &&
          query.where?.activatedAt
        ) {
          return Promise.resolve(4) // Rapid activations
        }
        return Promise.resolve(0)
      })

      const result = await checkReferralFraud(referredUserId, referralCodeId)

      expect(result.flags).toContain(ReferralFraudFlag.RAPID_ACTIVATION)
      expect(result.details.rapidActivations).toBe(4)
    })

    it('requires manual review when risk score >= 80', async () => {
      // Trigger multiple flags to reach threshold
      mockDb.user.count.mockImplementation((query: any) => {
        if (query.where?.email) return Promise.resolve(1) // +50
        if (query.where?.phone) return Promise.resolve(1) // +50
        return Promise.resolve(0)
      })

      const result = await checkReferralFraud(referredUserId, referralCodeId)

      expect(result.riskScore).toBeGreaterThanOrEqual(80)
      expect(result.requiresManualReview).toBe(true)
      expect(result.passed).toBe(true) // Still passes, just flagged
    })

    it('blocks referral when risk score >= 100', async () => {
      mockDb.user.count.mockImplementation((query: any) => {
        if (query.where?.walletAddress) return Promise.resolve(1) // +100
        return Promise.resolve(0)
      })

      const result = await checkReferralFraud(referredUserId, referralCodeId)

      expect(result.riskScore).toBeGreaterThanOrEqual(100)
      expect(result.passed).toBe(false) // Blocked!
    })
  })

  describe('attributeSignup with fraud detection', () => {
    it('blocks attribution when fraud check fails', async () => {
      const referredUserId = 'user-referred'
      const code = 'ABC12345'

      mockDb.referralCode.findUnique.mockResolvedValue({
        id: 'code-123',
        ownerUserId: 'user-owner',
        code,
      })

      // Simulate high risk score (duplicate wallet)
      mockDb.user.findUnique.mockResolvedValue({
        walletAddress: 'GABC...',
        sessions: [],
      })
      mockDb.user.count.mockImplementation((query: any) => {
        if (query.where?.walletAddress) return Promise.resolve(1) // Duplicate!
        return Promise.resolve(0)
      })
      mockDb.referralConversion.count.mockResolvedValue(0)

      const result = await attributeSignup(referredUserId, code)

      expect(result).toBeNull() // Attribution blocked
      expect(alertingService.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Referral fraud detected',
        }),
        expect.any(Number)
      )
    })

    it('creates conversion with fraud flags when manual review required', async () => {
      const referredUserId = 'user-referred'
      const code = 'ABC12345'

      mockDb.referralCode.findUnique.mockResolvedValue({
        id: 'code-123',
        ownerUserId: 'user-owner',
        code,
      })

      // Simulate moderate risk (email + phone duplicate = 100 points, but < 100 threshold)
      mockDb.user.findUnique.mockResolvedValue({
        walletAddress: 'GABC...',
        email: 'test@example.com',
        phone: '+1234567890',
        sessions: [],
      })
      mockDb.user.count.mockImplementation((query: any) => {
        if (query.where?.email) return Promise.resolve(1) // +50
        if (query.where?.phone) return Promise.resolve(1) // +50
        return Promise.resolve(0)
      })
      mockDb.referralConversion.count.mockResolvedValue(0)
      mockDb.referralConversion.create.mockResolvedValue({
        id: 'conversion-1',
        status: ReferralStatus.PENDING,
        fraudCheckScore: 100,
        manualReviewRequired: true,
      })

      const result = await attributeSignup(referredUserId, code)

      expect(result).toBe('conversion-1')
      expect(mockDb.referralConversion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fraudCheckScore: 100,
          manualReviewRequired: true,
          fraudCheckFlags: expect.any(Array),
        }),
      })
      expect(alertingService.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Referral requires manual review',
        }),
        expect.any(Number)
      )
    })
  })

  describe('Manual review workflow', () => {
    describe('approveReferralConversion', () => {
      it('approves a conversion flagged for manual review', async () => {
        const conversionId = 'conversion-1'
        const reviewedBy = 'admin@example.com'

        mockDb.referralConversion.findUnique.mockResolvedValue({
          id: conversionId,
          manualReviewRequired: true,
          manualReviewRejected: false,
        })
        mockDb.referralConversion.update.mockResolvedValue({
          id: conversionId,
          manualReviewRequired: false,
          reviewedBy,
        })

        await approveReferralConversion(conversionId, reviewedBy)

        expect(mockDb.referralConversion.update).toHaveBeenCalledWith({
          where: { id: conversionId },
          data: {
            manualReviewRequired: false,
            reviewedBy,
            reviewedAt: expect.any(Date),
          },
        })
      })

      it('throws when conversion does not require review', async () => {
        mockDb.referralConversion.findUnique.mockResolvedValue({
          id: 'conversion-1',
          manualReviewRequired: false,
        })

        await expect(
          approveReferralConversion('conversion-1', 'admin')
        ).rejects.toThrow('does not require manual review')
      })
    })

    describe('rejectReferralConversion', () => {
      it('rejects a conversion with reason', async () => {
        const conversionId = 'conversion-1'
        const reviewedBy = 'admin@example.com'
        const reason = 'Confirmed fraud - duplicate accounts'

        mockDb.referralConversion.findUnique.mockResolvedValue({
          id: conversionId,
          manualReviewRequired: true,
        })
        mockDb.referralConversion.update.mockResolvedValue({
          id: conversionId,
          manualReviewRejected: true,
        })

        await rejectReferralConversion(conversionId, reviewedBy, reason)

        expect(mockDb.referralConversion.update).toHaveBeenCalledWith({
          where: { id: conversionId },
          data: {
            manualReviewRequired: false,
            manualReviewRejected: true,
            reviewedBy,
            reviewedAt: expect.any(Date),
            rejectionReason: reason,
          },
        })
      })
    })

    describe('listConversionsForReview', () => {
      it('returns conversions flagged for manual review', async () => {
        mockDb.referralConversion.findMany.mockResolvedValue([
          {
            id: 'conv-1',
            manualReviewRequired: true,
            fraudCheckScore: 90,
            fraudCheckFlags: ['DUPLICATE_EMAIL'],
          },
          {
            id: 'conv-2',
            manualReviewRequired: true,
            fraudCheckScore: 85,
            fraudCheckFlags: ['SAME_IP_ADDRESS', 'SUSPICIOUS_VELOCITY'],
          },
        ])

        const result = await listConversionsForReview()

        expect(result).toHaveLength(2)
        expect(mockDb.referralConversion.findMany).toHaveBeenCalledWith({
          where: {
            manualReviewRequired: true,
            manualReviewRejected: false,
          },
          include: expect.any(Object),
          orderBy: { createdAt: 'desc' },
        })
      })
    })
  })
})
