// Referral rewards program unit tests. These pin the safety-critical invariants:
//   * signup attribution is blocked for self-referral and duplicate users
//   * activation happens ONLY against a real, confirmed deposit crossing the
//     threshold — never on a client claim, and sub-threshold deposits no-op
//   * activation never throws (a referral problem must not roll back a deposit)
//   * payout is idempotent: an already-paid leg is skipped, a failed leg leaves
//     the conversion ACTIVATED + retriable, and REWARDED requires every leg paid
import db from '../../../src/db'
import { alertingService } from '../../../src/services/alerting'
import { getWalletByUserId } from '../../../src/stellar/wallet'
import {
  attributeSignup,
  checkAndActivateOnDeposit,
  payoutActivatedConversions,
} from '../../../src/referral/service'

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
jest.mock('../../../src/stellar/wallet', () => ({
  getWalletByUserId: jest.fn(),
}))
jest.mock('../../../src/config', () => ({
  config: {
    referral: {
      minActivationDeposit: 10,
      ownerReward: 5,
      referredReward: 5,
      rewardAsset: 'USDC',
      rewardContractMethod: 'transfer_reward',
      payoutIntervalMs: 120000,
    },
  },
}))

// The outbox is a separate module with its own unit/integration coverage
// (tests/unit/outbox/, tests/integration/outbox/) — here it is mocked as the
// dependency boundary so this suite stays focused on referral bookkeeping:
// did we enqueue/dispatch a durable op, not "does the dispatcher's retry
// machinery work."
const mockEnqueueOutboxOp = jest.fn()
const mockDispatchOne = jest.fn()
jest.mock('../../../src/outbox/service', () => ({
  enqueueOutboxOp: (...args: unknown[]) => mockEnqueueOutboxOp(...args),
}))
jest.mock('../../../src/outbox/dispatcher', () => ({
  dispatchOne: (...args: unknown[]) => mockDispatchOne(...args),
}))

const mockDb = db as any
const mockEmit = alertingService.emit as jest.Mock
const mockGetWallet = getWalletByUserId as jest.Mock

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

// Re-import the mocked Prisma to build errors the service will recognise.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Prisma } = require('@prisma/client')
function uniqueViolation(): Error {
  return new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002' })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.referralCode = {
    findUnique: jest.fn(),
    create: jest.fn(),
  }
  mockDb.referralConversion = {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  }
  mockDb.user = { findUnique: jest.fn() }
  mockDb.transaction = { create: jest.fn(), update: jest.fn() }
  mockDb.$transaction = jest.fn((fn: (tx: any) => unknown) => fn(mockDb))
})

describe('attributeSignup', () => {
  it('creates a PENDING conversion for a valid code', async () => {
    mockDb.referralCode.findUnique.mockResolvedValue({
      id: 'rc-1',
      ownerUserId: 'owner-1',
    })
    mockDb.referralConversion.create.mockResolvedValue({ id: 'conv-1' })

    const id = await attributeSignup('referred-1', 'abc123xy')

    expect(id).toBe('conv-1')
    const createArg = mockDb.referralConversion.create.mock.calls[0][0]
    expect(createArg.data.status).toBe('PENDING')
    expect(createArg.data.referredUserId).toBe('referred-1')
  })

  it('normalises the code (trim + uppercase) before lookup', async () => {
    mockDb.referralCode.findUnique.mockResolvedValue({
      id: 'rc-1',
      ownerUserId: 'owner-1',
    })
    mockDb.referralConversion.create.mockResolvedValue({ id: 'conv-1' })

    await attributeSignup('referred-1', '  abc123xy  ')

    expect(mockDb.referralCode.findUnique).toHaveBeenCalledWith({
      where: { code: 'ABC123XY' },
    })
  })

  it('returns null (no throw) for an unknown code', async () => {
    mockDb.referralCode.findUnique.mockResolvedValue(null)
    const id = await attributeSignup('referred-1', 'nope')
    expect(id).toBeNull()
    expect(mockDb.referralConversion.create).not.toHaveBeenCalled()
  })

  it('blocks self-referral', async () => {
    mockDb.referralCode.findUnique.mockResolvedValue({
      id: 'rc-1',
      ownerUserId: 'same-user',
    })
    const id = await attributeSignup('same-user', 'abc123xy')
    expect(id).toBeNull()
    expect(mockDb.referralConversion.create).not.toHaveBeenCalled()
  })

  it('ignores a duplicate attribution (referredUserId unique violation)', async () => {
    mockDb.referralCode.findUnique.mockResolvedValue({
      id: 'rc-1',
      ownerUserId: 'owner-1',
    })
    mockDb.referralConversion.create.mockRejectedValue(uniqueViolation())
    const id = await attributeSignup('referred-1', 'abc123xy')
    expect(id).toBeNull()
  })

  it('returns null for an empty code', async () => {
    const id = await attributeSignup('referred-1', '   ')
    expect(id).toBeNull()
    expect(mockDb.referralCode.findUnique).not.toHaveBeenCalled()
  })
})

describe('checkAndActivateOnDeposit', () => {
  it('activates a PENDING conversion when a confirmed deposit crosses the threshold', async () => {
    mockDb.referralConversion.findUnique.mockResolvedValue({
      id: 'conv-1',
      status: 'PENDING',
    })
    mockDb.referralConversion.update.mockResolvedValue({})

    await checkAndActivateOnDeposit('referred-1', 'tx-1', '25')

    const updateArg = mockDb.referralConversion.update.mock.calls[0][0]
    expect(updateArg.data.status).toBe('ACTIVATED')
    expect(updateArg.data.activationTxId).toBe('tx-1')
    expect(updateArg.data.activatedAt).toBeInstanceOf(Date)
  })

  it('does NOT activate on a sub-threshold deposit', async () => {
    mockDb.referralConversion.findUnique.mockResolvedValue({
      id: 'conv-1',
      status: 'PENDING',
    })
    await checkAndActivateOnDeposit('referred-1', 'tx-1', '5')
    expect(mockDb.referralConversion.update).not.toHaveBeenCalled()
  })

  it('does nothing when there is no conversion for the depositor', async () => {
    mockDb.referralConversion.findUnique.mockResolvedValue(null)
    await checkAndActivateOnDeposit('referred-1', 'tx-1', '100')
    expect(mockDb.referralConversion.update).not.toHaveBeenCalled()
  })

  it('does not re-activate an already ACTIVATED conversion', async () => {
    mockDb.referralConversion.findUnique.mockResolvedValue({
      id: 'conv-1',
      status: 'ACTIVATED',
    })
    await checkAndActivateOnDeposit('referred-1', 'tx-2', '100')
    expect(mockDb.referralConversion.update).not.toHaveBeenCalled()
  })

  it('never throws — a referral error must not roll back the deposit', async () => {
    mockDb.referralConversion.findUnique.mockRejectedValue(new Error('db down'))
    await expect(
      checkAndActivateOnDeposit('referred-1', 'tx-1', '100')
    ).resolves.toBeUndefined()
  })

  it('uses the provided transaction client', async () => {
    const txClient = {
      referralConversion: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'conv-1', status: 'PENDING' }),
        update: jest.fn().mockResolvedValue({}),
      },
    } as any
    await checkAndActivateOnDeposit('referred-1', 'tx-1', '25', txClient)
    expect(txClient.referralConversion.update).toHaveBeenCalled()
    expect(mockDb.referralConversion.update).not.toHaveBeenCalled()
  })
})

describe('payoutActivatedConversions', () => {
  function activatedConversion(overrides: Record<string, unknown> = {}) {
    return {
      id: 'conv-1',
      referredUserId: 'referred-1',
      ownerRewardTxId: null,
      referredRewardTxId: null,
      referralCode: { ownerUserId: 'owner-1' },
      ...overrides,
    }
  }

  beforeEach(() => {
    mockGetWallet.mockResolvedValue({ publicKey: 'GADDRESS' })
    mockDb.user.findUnique.mockResolvedValue({ network: 'MAINNET' })
    mockEnqueueOutboxOp.mockResolvedValue({ id: 'op-1' })
    mockDispatchOne.mockResolvedValue({
      hash: 'onchainhash',
      status: 'success',
    })
    mockDb.transaction.create.mockImplementation(({ data }: any) => ({
      id: `tx-${data.userId}`,
    }))
    mockDb.transaction.update.mockResolvedValue({})
    mockDb.referralConversion.update.mockResolvedValue({})
  })

  it('pays both legs and advances to REWARDED', async () => {
    mockDb.referralConversion.findMany.mockResolvedValue([
      activatedConversion(),
    ])

    const res = await payoutActivatedConversions()

    expect(res.rewarded).toBe(1)
    expect(mockDispatchOne).toHaveBeenCalledTimes(2)
    const finalUpdate = mockDb.referralConversion.update.mock.calls.at(-1)[0]
    expect(finalUpdate.data.status).toBe('REWARDED')
  })

  it('enqueues a distinct REFERRAL_REWARD transaction, then confirms it via the outbox', async () => {
    mockDb.referralConversion.findMany.mockResolvedValue([
      activatedConversion(),
    ])
    await payoutActivatedConversions()

    const createArg = mockDb.transaction.create.mock.calls[0][0]
    expect(createArg.data.type).toBe('REFERRAL_REWARD')
    expect(createArg.data.status).toBe('PENDING')

    const updateArg = mockDb.transaction.update.mock.calls[0][0]
    expect(updateArg.data.status).toBe('CONFIRMED')
    expect(updateArg.data.txHash).toBe('onchainhash')
  })

  it('is idempotent — skips a leg already paid', async () => {
    mockDb.referralConversion.findMany.mockResolvedValue([
      activatedConversion({ ownerRewardTxId: 'already-paid' }),
    ])
    await payoutActivatedConversions()
    // Only the referred leg should be dispatched.
    expect(mockDispatchOne).toHaveBeenCalledTimes(1)
  })

  it('leaves conversion ACTIVATED + retriable when a leg fails, and does NOT reward', async () => {
    mockDb.referralConversion.findMany.mockResolvedValue([
      activatedConversion(),
    ])
    mockDispatchOne.mockRejectedValueOnce(new Error('rpc timeout'))

    const res = await payoutActivatedConversions()

    expect(res.rewarded).toBe(0)
    // No update should set status to REWARDED.
    const rewardedUpdate = mockDb.referralConversion.update.mock.calls.find(
      (c: any) => c[0].data?.status === 'REWARDED'
    )
    expect(rewardedUpdate).toBeUndefined()
    // payoutError recorded and an alert emitted.
    const errorUpdate = mockDb.referralConversion.update.mock.calls.find(
      (c: any) => typeof c[0].data?.payoutError === 'string'
    )
    expect(errorUpdate).toBeDefined()
    expect(mockEmit).toHaveBeenCalled()
  })

  it('fails the leg (retriable) when the recipient has no wallet address', async () => {
    mockDb.referralConversion.findMany.mockResolvedValue([
      activatedConversion(),
    ])
    mockGetWallet.mockResolvedValue(null)
    mockDb.user.findUnique.mockResolvedValue({
      network: 'MAINNET',
      walletAddress: null,
    })

    const res = await payoutActivatedConversions()

    expect(res.rewarded).toBe(0)
    expect(mockDispatchOne).not.toHaveBeenCalled()
  })
})
