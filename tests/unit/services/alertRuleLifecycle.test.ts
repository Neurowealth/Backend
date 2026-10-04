import db from '../../../src/db'
import {
  restoreAlertRule,
  softDeleteAlertRule,
} from '../../../src/services/alertRuleLifecycle'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))

const mockDb = db as any
const mockTransaction = {
  alertRule: { updateMany: jest.fn() },
  userDataAudit: { create: jest.fn() },
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.$transaction = jest.fn(async (callback: (tx: unknown) => unknown) =>
    callback(mockTransaction)
  )
  mockTransaction.alertRule.updateMany.mockResolvedValue({ count: 1 })
  mockTransaction.userDataAudit.create.mockResolvedValue({ id: 'audit-1' })
})

describe('alert rule lifecycle', () => {
  it('soft-deletes only a live rule owned by the requesting tenant and audits it', async () => {
    await expect(softDeleteAlertRule('tenant-a', 'rule-1')).resolves.toBe(true)

    expect(mockTransaction.alertRule.updateMany).toHaveBeenCalledWith({
      where: { id: 'rule-1', userId: 'tenant-a', deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    })
    expect(mockTransaction.userDataAudit.create).toHaveBeenCalledWith({
      data: {
        tenantUserId: 'tenant-a',
        actorUserId: 'tenant-a',
        recordType: 'AlertRule',
        recordId: 'rule-1',
        action: 'DELETE',
      },
    })
  })

  it('does not audit or mutate when the rule is outside the tenant or not live', async () => {
    mockTransaction.alertRule.updateMany.mockResolvedValue({ count: 0 })

    await expect(softDeleteAlertRule('tenant-a', 'rule-1')).resolves.toBe(false)

    expect(mockTransaction.userDataAudit.create).not.toHaveBeenCalled()
  })

  it('restores a deleted tenant-owned rule and records a restore audit event', async () => {
    await expect(restoreAlertRule('tenant-a', 'rule-1')).resolves.toBe(true)

    expect(mockTransaction.alertRule.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'rule-1',
        userId: 'tenant-a',
        deletedAt: { not: null },
      },
      data: { deletedAt: null },
    })
    expect(mockTransaction.userDataAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantUserId: 'tenant-a',
        recordType: 'AlertRule',
        action: 'RESTORE',
      }),
    })
  })
})
