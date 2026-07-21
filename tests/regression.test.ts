import db from '../src/db'

const prisma = db as any

describe('Regression Tests - Critical Prisma-Backed Flows', () => {
  beforeAll(async () => {
    await prisma.$connect()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  describe('Session Management', () => {
    it('should create a session and retrieve it', async () => {
      const userId = 'test-user-' + Date.now()
      const token = 'test-token-' + Math.random().toString(36).slice(2)

      const user = await prisma.user.create({
        data: {
          walletAddress: userId,
          network: 'MAINNET',
        },
      })

      const session = await prisma.session.create({
        data: {
          userId: user.id,
          token,
          walletAddress: user.walletAddress,
          network: user.network,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      })

      expect(session).toBeDefined()
      expect(session.token).toBe(token)

      const retrieved = await prisma.session.findUnique({
        where: { id: session.id },
      })
      expect(retrieved).toBeDefined()
      expect(retrieved.token).toBe(token)

      await prisma.user.delete({ where: { id: user.id } })
    })

    it('should delete expired sessions', async () => {
      const userId = 'test-user-expire-' + Date.now()
      const user = await prisma.user.create({
        data: {
          walletAddress: userId,
          network: 'MAINNET',
        },
      })

      const expiredSession = await prisma.session.create({
        data: {
          userId: user.id,
          token: 'expired-' + Math.random().toString(36),
          walletAddress: user.walletAddress,
          network: user.network,
          expiresAt: new Date(Date.now() - 1000),
        },
      })

      const deleted = await prisma.session.deleteMany({
        where: {
          expiresAt: { lt: new Date() },
        },
      })

      expect(deleted.count).toBeGreaterThanOrEqual(1)

      await prisma.user.delete({ where: { id: user.id } })
    })
  })

  describe('Event Persistence', () => {
    it('should persist processed events with cursor updates', async () => {
      const contractId = 'test-contract-' + Date.now()

      const cursor = await prisma.eventCursor.create({
        data: {
          contractId,
          lastProcessedLedger: 100,
        },
      })

      expect(cursor.lastProcessedLedger).toBe(100)

      const event = await prisma.processedEvent.create({
        data: {
          contractId,
          txHash: 'test-tx-' + Math.random().toString(36),
          eventType: 'CONTRACT_TRIGGERED',
          ledger: 101,
        },
      })

      expect(event).toBeDefined()
      expect(event.ledger).toBe(101)

      const updated = await prisma.eventCursor.update({
        where: { id: cursor.id },
        data: { lastProcessedLedger: 101 },
      })

      expect(updated.lastProcessedLedger).toBe(101)

      await prisma.processedEvent.deleteMany({
        where: { contractId },
      })
      await prisma.eventCursor.delete({ where: { id: cursor.id } })
    })

    it('should maintain unique constraint on processed events', async () => {
      const contractId = 'unique-test-' + Date.now()
      const txHash = 'tx-unique-' + Math.random().toString(36)

      const event1 = await prisma.processedEvent.create({
        data: {
          contractId,
          txHash,
          eventType: 'TEST_EVENT',
          ledger: 200,
        },
      })

      expect(event1).toBeDefined()

      const duplicate = prisma.processedEvent.create({
        data: {
          contractId,
          txHash,
          eventType: 'TEST_EVENT',
          ledger: 200,
        },
      })

      await expect(duplicate).rejects.toThrow()

      await prisma.processedEvent.deleteMany({
        where: { contractId },
      })
    })
  })

  describe('Dead Letter Queue', () => {
    it('should create DLQ entries with correct status', async () => {
      const contractId = 'dlq-test-' + Date.now()

      const dlqEvent = await prisma.deadLetterEvent.create({
        data: {
          contractId,
          txHash: 'dlq-tx-' + Math.random().toString(36),
          eventType: 'FAILED_EVENT',
          ledger: 300,
          error: 'Test error',
          payload: { test: true },
          status: 'PENDING',
          retryCount: 0,
        },
      })

      expect(dlqEvent.status).toBe('PENDING')
      expect(dlqEvent.retryCount).toBe(0)

      const retrieved = await prisma.deadLetterEvent.findUnique({
        where: { id: dlqEvent.id },
      })

      expect(retrieved).toBeDefined()
      expect(retrieved.status).toBe('PENDING')
    })

    it('should increment retry count and update status', async () => {
      const contractId = 'dlq-retry-' + Date.now()

      const dlqEvent = await prisma.deadLetterEvent.create({
        data: {
          contractId,
          txHash: 'dlq-tx-retry-' + Math.random().toString(36),
          eventType: 'FAILED_EVENT',
          ledger: 400,
          error: 'Initial error',
          payload: { test: true },
          status: 'PENDING',
          retryCount: 0,
        },
      })

      const updated = await prisma.deadLetterEvent.update({
        where: { id: dlqEvent.id },
        data: {
          retryCount: { increment: 1 },
          status: 'RETRIED',
          error: 'Retry error',
          updatedAt: new Date(),
        },
      })

      expect(updated.retryCount).toBe(1)
      expect(updated.status).toBe('RETRIED')
    })

    it('should resolve DLQ events', async () => {
      const contractId = 'dlq-resolve-' + Date.now()

      const dlqEvent = await prisma.deadLetterEvent.create({
        data: {
          contractId,
          txHash: 'dlq-tx-resolve-' + Math.random().toString(36),
          eventType: 'FAILED_EVENT',
          ledger: 500,
          error: 'Original error',
          payload: { test: true },
          status: 'RETRIED',
          retryCount: 3,
        },
      })

      const resolved = await prisma.deadLetterEvent.update({
        where: { id: dlqEvent.id },
        data: {
          status: 'RESOLVED',
          error: 'Resolved via manual intervention',
          updatedAt: new Date(),
        },
      })

      expect(resolved.status).toBe('RESOLVED')
      expect(resolved.retryCount).toBe(3)
    })

    it('should query DLQ by status and retry count', async () => {
      const contractId = 'dlq-query-' + Date.now()

      await prisma.deadLetterEvent.createMany({
        data: [
          {
            contractId,
            txHash: 'tx-1-' + Math.random().toString(36),
            eventType: 'FAILED_EVENT',
            ledger: 600,
            error: 'Error 1',
            payload: {},
            status: 'PENDING',
            retryCount: 0,
          },
          {
            contractId,
            txHash: 'tx-2-' + Math.random().toString(36),
            eventType: 'FAILED_EVENT',
            ledger: 601,
            error: 'Error 2',
            payload: {},
            status: 'RETRIED',
            retryCount: 2,
          },
          {
            contractId,
            txHash: 'tx-3-' + Math.random().toString(36),
            eventType: 'FAILED_EVENT',
            ledger: 602,
            error: 'Error 3',
            payload: {},
            status: 'RESOLVED',
            retryCount: 5,
          },
        ],
      })

      const pending = await prisma.deadLetterEvent.findMany({
        where: { contractId, status: 'PENDING' },
      })
      expect(pending.length).toBe(1)

      const retried = await prisma.deadLetterEvent.findMany({
        where: { contractId, status: 'RETRIED' },
      })
      expect(retried.length).toBe(1)

      const highRetryCount = await prisma.deadLetterEvent.findMany({
        where: { contractId, retryCount: { gte: 2 } },
      })
      expect(highRetryCount.length).toBeGreaterThanOrEqual(2)

      await prisma.deadLetterEvent.deleteMany({
        where: { contractId },
      })
    })
  })

  describe('Admin Audit Logging', () => {
    it('should create and retrieve audit logs', async () => {
      const adminKey = await prisma.adminApiKey.create({
        data: {
          name: 'test-key-' + Date.now(),
          role: 'admin',
          scopes: ['dlq:read', 'dlq:write'],
          hash: 'test-hash',
          tokenPrefix: 'sha256:test-prefix',
        },
      })

      const auditLog = await prisma.adminAuditLog.create({
        data: {
          adminKeyId: adminKey.id,
          adminName: 'test-admin',
          adminRole: 'admin',
          action: 'DLQ_INSPECT',
          target: '/api/admin/dlq/inspect',
          result: 'success',
          path: '/api/admin/dlq/inspect',
          method: 'GET',
          ipAddress: '127.0.0.1',
        },
      })

      expect(auditLog).toBeDefined()
      expect(auditLog.action).toBe('DLQ_INSPECT')
      expect(auditLog.result).toBe('success')

      const retrieved = await prisma.adminAuditLog.findMany({
        where: { adminKeyId: adminKey.id },
      })

      expect(retrieved.length).toBeGreaterThanOrEqual(1)

      await prisma.adminAuditLog.deleteMany({
        where: { adminKeyId: adminKey.id },
      })
      await prisma.adminApiKey.delete({ where: { id: adminKey.id } })
    })
  })
})
