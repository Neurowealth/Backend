process.env.NODE_ENV = 'test'

import { cleanupAdminAuditLogs } from '../../../src/jobs/adminAuditRetention'
import { config } from '../../../src/config/env'
import * as metrics from '../../../src/utils/metrics'
import * as jobMetrics from '../../../src/utils/job-metrics'

const mockCount = jest.fn()
const mockQueryRaw = jest.fn()
const mockTransaction = jest.fn()
const mockAuditBlockCreate = jest.fn().mockResolvedValue({})
const mockAuditBlockFindFirst = jest
  .fn()
  .mockResolvedValue({ height: 1, hash: 'h1' })

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    adminAuditLog: {
      count: (...args: unknown[]) => mockCount(...args),
    },
    auditBlock: {
      findFirst: (...args: unknown[]) => mockAuditBlockFindFirst(...args),
      create: (...args: unknown[]) => mockAuditBlockCreate(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  logBackgroundJob: jest.fn(),
}))

jest.mock('../../../src/utils/metrics', () => ({
  recordBackgroundJob: jest.fn(),
  recordRetentionDeletes: jest.fn(),
}))

jest.mock('../../../src/utils/job-metrics', () => ({
  recordJobSuccess: jest.fn(),
  recordJobFailure: jest.fn(),
}))

describe('cleanupAdminAuditLogs (#682)', () => {
  const originalLegalHold = config.retention.adminAuditLegalHold
  const originalDays = config.retention.adminAuditLogsDays
  const originalDryRun = process.env.DATA_RETENTION_DRY_RUN

  beforeEach(() => {
    jest.clearAllMocks()
    config.retention.adminAuditLegalHold = false
    config.retention.adminAuditLogsDays = 365
    delete process.env.DATA_RETENTION_DRY_RUN
    mockQueryRaw.mockImplementation(async (parts: TemplateStringsArray) => {
      const query = parts.join('')
      return query.includes('purge_admin_audit_logs') ? [{ id: 'old-1' }] : []
    })

    mockTransaction.mockImplementation(async (callback: any) => {
      const tx = {
        $queryRaw: mockQueryRaw,
        auditBlock: {
          findFirst: (...args: unknown[]) => mockAuditBlockFindFirst(...args),
          create: (...args: unknown[]) => mockAuditBlockCreate(...args),
        },
      }
      return callback(tx)
    })
  })

  afterAll(() => {
    config.retention.adminAuditLegalHold = originalLegalHold
    config.retention.adminAuditLogsDays = originalDays
    if (originalDryRun !== undefined) {
      process.env.DATA_RETENTION_DRY_RUN = originalDryRun
    } else {
      delete process.env.DATA_RETENTION_DRY_RUN
    }
  })

  it('skips deletion when adminAuditLegalHold is active', async () => {
    config.retention.adminAuditLegalHold = true

    await cleanupAdminAuditLogs()

    expect(mockCount).not.toHaveBeenCalled()
    expect(mockTransaction).not.toHaveBeenCalled()
    expect(mockQueryRaw).not.toHaveBeenCalled()
    expect(metrics.recordBackgroundJob).toHaveBeenCalledWith(
      'retention_admin_audit_logs',
      'skipped',
      expect.any(Number)
    )
    expect(jobMetrics.recordJobSuccess).toHaveBeenCalled()
  })

  it('runs dry run without executing transaction or deletes when DATA_RETENTION_DRY_RUN=true', async () => {
    process.env.DATA_RETENTION_DRY_RUN = 'true'
    mockCount.mockResolvedValue(1)

    await cleanupAdminAuditLogs()

    expect(mockCount).toHaveBeenCalledWith({
      where: { createdAt: { lt: expect.any(Date) } },
    })
    expect(mockTransaction).not.toHaveBeenCalled()
    expect(metrics.recordBackgroundJob).toHaveBeenCalledWith(
      'retention_admin_audit_logs',
      'dry_run',
      expect.any(Number)
    )
  })

  it('anchors expired records and deletes them inside an authorized transaction', async () => {
    const expiredLogs = [
      {
        id: 'old-1',
        adminKeyId: 'k-1',
        action: 'INSPECT',
        result: 'success',
        createdAt: new Date('2024-01-01'),
      },
    ]
    mockQueryRaw
      .mockResolvedValueOnce(expiredLogs)
      .mockResolvedValueOnce([{ id: 'old-1' }])

    await cleanupAdminAuditLogs()

    expect(mockQueryRaw).toHaveBeenCalledTimes(2)
    expect(mockQueryRaw.mock.calls[0][0].join('')).toContain('LIMIT 500')
    expect(mockQueryRaw.mock.calls[1][0].join('')).toContain(
      'purge_admin_audit_logs'
    )

    expect(mockAuditBlockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blockType: 'ANCHOR',
        }),
      })
    )

    // The narrow database function authorizes the bounded purge.
    expect(mockQueryRaw.mock.calls[1][0].join('')).toContain(
      'purge_admin_audit_logs'
    )

    expect(metrics.recordRetentionDeletes).toHaveBeenCalledWith(
      'admin_audit_logs',
      1
    )
    expect(metrics.recordBackgroundJob).toHaveBeenCalledWith(
      'retention_admin_audit_logs',
      'success',
      expect.any(Number)
    )
    expect(jobMetrics.recordJobSuccess).toHaveBeenCalled()
  })

  it('handles and reports failures cleanly', async () => {
    mockQueryRaw.mockRejectedValue(new Error('Database connection failed'))

    await cleanupAdminAuditLogs()

    expect(metrics.recordBackgroundJob).toHaveBeenCalledWith(
      'retention_admin_audit_logs',
      'failed',
      expect.any(Number)
    )
    expect(jobMetrics.recordJobFailure).toHaveBeenCalledWith(
      'retention_admin_audit_logs',
      expect.any(Number),
      expect.any(Error)
    )
  })

  it('treats a database legal hold as a skipped purge, not a job failure', async () => {
    mockQueryRaw.mockRejectedValue(
      new Error(
        'AdminAuditLog is protected by legal hold: DELETE operations are prohibited'
      )
    )

    await cleanupAdminAuditLogs()

    expect(metrics.recordBackgroundJob).toHaveBeenCalledWith(
      'retention_admin_audit_logs',
      'skipped',
      expect.any(Number)
    )
    expect(jobMetrics.recordJobFailure).not.toHaveBeenCalled()
  })
})
