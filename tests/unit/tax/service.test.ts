// Tax lot bookkeeping unit tests (#284). Pin the high-risk invariants:
//   * lot creation is idempotent (P2002 replay is quiet) and NEVER throws —
//     a tax problem must not roll back a confirmed deposit
//   * disposal recording is idempotent via the exists-check
//   * a shortfall writes NOTHING (all-or-nothing), alerts critically, and
//     returns normally so the withdrawal is unaffected
import db from '../../../src/db'
import { alertingService } from '../../../src/services/alerting'
import {
  createLotForDeposit,
  recordDisposalsForWithdrawal,
} from '../../../src/tax/service'
import { logger } from '../../../src/utils/logger'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))
jest.mock('../../../src/services/alerting', () => ({
  alertingService: { emit: jest.fn().mockResolvedValue({ sent: true }) },
}))

jest.mock('@prisma/client', () => {
  const actual = jest.requireActual('@prisma/client')
  return {
    ...actual,
    Prisma: {
      ...actual.Prisma,
      PrismaClientKnownRequestError: class extends Error {
        code: string
        constructor(msg: string, opts: { code: string }) {
          super(msg)
          this.code = opts.code
        }
      },
    },
  }
})

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Prisma } = require('@prisma/client')
function uniqueViolation(): Error {
  return new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002' })
}

const mockDb = db as any
const mockEmit = alertingService.emit as jest.Mock
const mockError = logger.error as jest.Mock

const acquiredAt = new Date('2026-01-15T00:00:00Z')
const disposedAt = new Date('2026-06-15T00:00:00Z')

beforeEach(() => {
  jest.clearAllMocks()
  mockEmit.mockResolvedValue({ sent: true })
  mockDb.costBasisLot = {
    create: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  }
  mockDb.lotDisposal = {
    findFirst: jest.fn(),
    create: jest.fn(),
  }
})

describe('createLotForDeposit', () => {
  it('creates a priced lot for USDC with remaining = original', async () => {
    mockDb.costBasisLot.create.mockResolvedValue({ id: 'lot-1' })

    await createLotForDeposit('user-1', 'tx-1', 'USDC', '100', acquiredAt)

    const arg = mockDb.costBasisLot.create.mock.calls[0][0]
    expect(arg.data.transactionId).toBe('tx-1')
    expect(arg.data.originalAmount.toString()).toBe('100')
    expect(arg.data.remainingAmount.toString()).toBe('100')
    expect(arg.data.acquisitionPrice.toString()).toBe('1')
    expect(arg.data.priceSource).toBe('STABLECOIN_ASSUMPTION')
  })

  it('creates an unpriced lot (null price, null source) for non-USDC assets', async () => {
    mockDb.costBasisLot.create.mockResolvedValue({ id: 'lot-1' })

    await createLotForDeposit('user-1', 'tx-1', 'XLM', '100', acquiredAt)

    const arg = mockDb.costBasisLot.create.mock.calls[0][0]
    expect(arg.data.acquisitionPrice).toBeNull()
    expect(arg.data.priceSource).toBeNull()
  })

  it('treats P2002 as a benign replay: no error log, no alert, no throw', async () => {
    mockDb.costBasisLot.create.mockRejectedValue(uniqueViolation())

    await expect(
      createLotForDeposit('user-1', 'tx-1', 'USDC', '100', acquiredAt)
    ).resolves.toBeUndefined()

    expect(mockError).not.toHaveBeenCalled()
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('swallows generic errors but logs and alerts', async () => {
    mockDb.costBasisLot.create.mockRejectedValue(new Error('db down'))

    await expect(
      createLotForDeposit('user-1', 'tx-1', 'USDC', '100', acquiredAt)
    ).resolves.toBeUndefined()

    expect(mockError).toHaveBeenCalled()
    expect(mockEmit).toHaveBeenCalledTimes(1)
    expect(mockEmit.mock.calls[0][0].severity).toBe('warning')
  })

  it('uses the provided database handle (transaction client)', async () => {
    const tx = { costBasisLot: { create: jest.fn().mockResolvedValue({}) } }

    await createLotForDeposit(
      'user-1',
      'tx-1',
      'USDC',
      '100',
      acquiredAt,
      tx as any
    )

    expect(tx.costBasisLot.create).toHaveBeenCalled()
    expect(mockDb.costBasisLot.create).not.toHaveBeenCalled()
  })
})

describe('recordDisposalsForWithdrawal', () => {
  it('records FIFO disposals and decrements lots', async () => {
    mockDb.lotDisposal.findFirst.mockResolvedValue(null)
    mockDb.costBasisLot.findMany.mockResolvedValue([
      {
        id: 'lot-old',
        remainingAmount: '40',
        acquisitionPrice: '1',
        acquiredAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 'lot-new',
        remainingAmount: '100',
        acquisitionPrice: '1',
        acquiredAt: new Date('2026-02-01T00:00:00Z'),
      },
    ])
    mockDb.costBasisLot.update.mockResolvedValue({})
    mockDb.lotDisposal.create.mockResolvedValue({})

    await recordDisposalsForWithdrawal(
      'user-1',
      'wtx-1',
      'USDC',
      '60',
      disposedAt
    )

    expect(mockDb.costBasisLot.update).toHaveBeenCalledTimes(2)
    expect(mockDb.lotDisposal.create).toHaveBeenCalledTimes(2)
    const first = mockDb.lotDisposal.create.mock.calls[0][0].data
    expect(first.lotId).toBe('lot-old')
    expect(first.amount.toString()).toBe('40')
    expect(first.realizedGain.toString()).toBe('0')
    const second = mockDb.lotDisposal.create.mock.calls[1][0].data
    expect(second.lotId).toBe('lot-new')
    expect(second.amount.toString()).toBe('20')
  })

  it('skips silently when disposals already exist (idempotent replay)', async () => {
    mockDb.lotDisposal.findFirst.mockResolvedValue({ id: 'existing' })

    await recordDisposalsForWithdrawal(
      'user-1',
      'wtx-1',
      'USDC',
      '60',
      disposedAt
    )

    expect(mockDb.costBasisLot.findMany).not.toHaveBeenCalled()
    expect(mockDb.lotDisposal.create).not.toHaveBeenCalled()
  })

  it('writes NOTHING on insufficient lots, alerts critically, does not throw', async () => {
    mockDb.lotDisposal.findFirst.mockResolvedValue(null)
    mockDb.costBasisLot.findMany.mockResolvedValue([
      {
        id: 'lot-1',
        remainingAmount: '10',
        acquisitionPrice: '1',
        acquiredAt: new Date('2026-01-01T00:00:00Z'),
      },
    ])

    await expect(
      recordDisposalsForWithdrawal('user-1', 'wtx-1', 'USDC', '60', disposedAt)
    ).resolves.toBeUndefined()

    expect(mockDb.costBasisLot.update).not.toHaveBeenCalled()
    expect(mockDb.lotDisposal.create).not.toHaveBeenCalled()
    expect(mockError).toHaveBeenCalled()
    const logMeta = mockError.mock.calls[0][1]
    expect(logMeta.requested).toBe('60')
    expect(logMeta.available).toBe('10')
    expect(logMeta.shortfall).toBe('50')
    expect(mockEmit).toHaveBeenCalledTimes(1)
    expect(mockEmit.mock.calls[0][0].severity).toBe('critical')
  })

  it('swallows generic db errors with an alert (withdrawal unaffected)', async () => {
    mockDb.lotDisposal.findFirst.mockRejectedValue(new Error('db down'))

    await expect(
      recordDisposalsForWithdrawal('user-1', 'wtx-1', 'USDC', '60', disposedAt)
    ).resolves.toBeUndefined()

    expect(mockError).toHaveBeenCalled()
    expect(mockEmit).toHaveBeenCalledTimes(1)
  })

  it('propagates null cost basis for unpriced assets (never zero)', async () => {
    mockDb.lotDisposal.findFirst.mockResolvedValue(null)
    mockDb.costBasisLot.findMany.mockResolvedValue([
      {
        id: 'lot-1',
        remainingAmount: '50',
        acquisitionPrice: null,
        acquiredAt: new Date('2026-01-01T00:00:00Z'),
      },
    ])
    mockDb.costBasisLot.update.mockResolvedValue({})
    mockDb.lotDisposal.create.mockResolvedValue({})

    await recordDisposalsForWithdrawal(
      'user-1',
      'wtx-1',
      'XLM',
      '50',
      disposedAt
    )

    const data = mockDb.lotDisposal.create.mock.calls[0][0].data
    expect(data.costBasis).toBeNull()
    expect(data.realizedGain).toBeNull()
    expect(data.disposalPrice).toBeNull()
    expect(data.proceeds).toBeNull()
  })
})
