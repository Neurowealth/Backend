import { Prisma } from '@prisma/client'
import db from '../../../src/db'
import {
  executeInternalTransfer,
  InternalTransferError,
} from '../../../src/services/internal-transfer.service'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
}))
jest.mock('../../../src/referral/service', () => ({
  getOrCreateReferralCode: jest.fn().mockResolvedValue({
    code: 'SEND2345',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }),
}))

const mockDb = db as unknown as { $transaction: jest.Mock }

function transactionClient(balance = '10', lots: object[] = []) {
  let transactionCount = 0
  const tx = {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    referralCode: {
      findUnique: jest.fn().mockResolvedValue({
        owner: {
          id: 'recipient',
          network: 'MAINNET',
          isActive: true,
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
        },
      }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'sender',
        network: 'MAINNET',
        isActive: true,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      }),
      findMany: jest.fn().mockResolvedValue([
        { id: 'sender', isActive: true },
        { id: 'recipient', isActive: true },
      ]),
    },
    complianceCase: { findMany: jest.fn().mockResolvedValue([]) },
    subAccount: { findUnique: jest.fn().mockResolvedValue(null) },
    transaction: {
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
      create: jest.fn().mockImplementation(() => ({
        id: `transaction-${++transactionCount}`,
      })),
    },
    internalTransfer: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'transfer-1' }),
    },
    position: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'sender-position',
          protocolName: 'Test Protocol',
          assetAddress: null,
          currentValue: new Prisma.Decimal(balance),
          depositedAmount: new Prisma.Decimal(balance),
          yieldEarned: new Prisma.Decimal(0),
        },
      ]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'recipient-position' }),
      update: jest.fn().mockResolvedValue({}),
    },
    savingsGoal: { findMany: jest.fn().mockResolvedValue([]) },
    costBasisLot: {
      findMany: jest.fn().mockResolvedValue(lots),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
    adminAuditLog: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
  }
  return tx
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('executeInternalTransfer', () => {
  it('moves an existing position balance atomically and audits both sides', async () => {
    const acquiredAt = new Date('2025-06-01T00:00:00.000Z')
    const tx = transactionClient('10', [
      {
        id: 'sender-lot',
        remainingAmount: new Prisma.Decimal('10'),
        acquisitionPrice: new Prisma.Decimal('1'),
        priceSource: 'STABLECOIN_ASSUMPTION',
        acquiredAt,
      },
    ])
    mockDb.$transaction.mockImplementation((work) => work(tx))

    await expect(
      executeInternalTransfer({
        senderUserId: 'sender',
        recipientHandle: 'abcd2345',
        amount: '3',
        assetSymbol: 'USDC',
      })
    ).resolves.toMatchObject({
      transferId: 'transfer-1',
      transactionId: 'transaction-1',
      recipientHandle: 'ABCD2345',
      amount: '3',
    })

    expect(tx.position.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'sender-position',
          currentValue: { gte: new Prisma.Decimal('3') },
        },
        data: {
          currentValue: { decrement: new Prisma.Decimal('3') },
          depositedAmount: { decrement: new Prisma.Decimal('3') },
          yieldEarned: { decrement: new Prisma.Decimal('0') },
        },
      })
    )
    expect(tx.position.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'recipient-position' },
        data: expect.objectContaining({
          currentValue: { increment: new Prisma.Decimal('3') },
        }),
      })
    )
    expect(tx.adminAuditLog.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ action: 'P2P_TRANSFER_SENT' }),
        expect.objectContaining({ action: 'P2P_TRANSFER_RECEIVED' }),
      ]),
    })
    expect(tx.internalTransfer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ riskScore: expect.any(Number) }),
      })
    )
    expect(tx.costBasisLot.update).toHaveBeenCalledWith({
      where: { id: 'sender-lot' },
      data: { remainingAmount: { decrement: new Prisma.Decimal('3') } },
    })
    expect(tx.costBasisLot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'recipient',
        transactionId: 'transaction-2',
        originalAmount: new Prisma.Decimal('3'),
        remainingAmount: new Prisma.Decimal('3'),
        acquisitionPrice: new Prisma.Decimal('1'),
        priceSource: 'STABLECOIN_ASSUMPTION',
        acquiredAt,
      }),
    })
  })

  it('rejects an amount exceeding unlocked balance before creating transfer records', async () => {
    const tx = transactionClient('1')
    mockDb.$transaction.mockImplementation((work) => work(tx))

    await expect(
      executeInternalTransfer({
        senderUserId: 'sender',
        recipientHandle: 'ABCD2345',
        amount: '2',
        assetSymbol: 'USDC',
      })
    ).rejects.toMatchObject<Partial<InternalTransferError>>({
      message:
        'Insufficient available balance after pending withdrawal reservations',
      statusCode: 409,
    })

    expect(tx.internalTransfer.create).not.toHaveBeenCalled()
  })

  it('rejects a frozen recipient before debiting the sender', async () => {
    const tx = transactionClient()
    tx.complianceCase.findMany.mockResolvedValue([{ userId: 'recipient' }])
    mockDb.$transaction.mockImplementation((work) => work(tx))

    await expect(
      executeInternalTransfer({
        senderUserId: 'sender',
        recipientHandle: 'ABCD2345',
        amount: '2',
        assetSymbol: 'USDC',
      })
    ).rejects.toMatchObject({ statusCode: 423 })

    expect(tx.position.updateMany).not.toHaveBeenCalled()
    expect(tx.internalTransfer.create).not.toHaveBeenCalled()
  })

  it('rejects a parent transfer when the recipient sub-account lacks deposit permission', async () => {
    const tx = transactionClient()
    tx.subAccount.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      permissions: ['WITHDRAW'],
    })
    mockDb.$transaction.mockImplementation((work) => work(tx))

    await expect(
      executeInternalTransfer({
        senderUserId: 'sender',
        recipientHandle: 'ABCD2345',
        amount: '2',
        assetSymbol: 'USDC',
      })
    ).rejects.toMatchObject({ statusCode: 403 })

    expect(tx.position.updateMany).not.toHaveBeenCalled()
  })
})
