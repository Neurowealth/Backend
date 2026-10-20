import {
  initiateRotation,
  finalizeRotation,
  SignerRotationStateError,
} from '../../../src/treasury/signerRotation'
import db from '../../../src/db'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    signerRotation: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockDb = db as any

beforeEach(() => {
  jest.clearAllMocks()
})

describe('initiateRotation', () => {
  it('creates a rotation that enters DUAL_ACTIVE immediately', async () => {
    mockDb.signerRotation.create.mockResolvedValue({
      id: 'r1',
      status: 'DUAL_ACTIVE',
      dualActiveSince: new Date(),
    })

    const rotation = await initiateRotation('acct-1', 'GOLD', 'GNEW', 'admin-1')

    expect(rotation.status).toBe('DUAL_ACTIVE')
    expect(mockDb.signerRotation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          treasuryAccountId: 'acct-1',
          oldSignerKey: 'GOLD',
          newSignerKey: 'GNEW',
          status: 'DUAL_ACTIVE',
        }),
      })
    )
  })
})

describe('finalizeRotation', () => {
  it('rejects finalizing a rotation not in DUAL_ACTIVE', async () => {
    mockDb.signerRotation.findUnique.mockResolvedValue({
      id: 'r1',
      status: 'PENDING',
    })

    await expect(finalizeRotation('r1', 'admin-1')).rejects.toThrow(
      SignerRotationStateError
    )
  })

  it('rejects finalizing a rotation that does not exist', async () => {
    mockDb.signerRotation.findUnique.mockResolvedValue(null)

    await expect(finalizeRotation('missing', 'admin-1')).rejects.toThrow(
      SignerRotationStateError
    )
  })

  it('finalizes a DUAL_ACTIVE rotation', async () => {
    mockDb.signerRotation.findUnique.mockResolvedValue({
      id: 'r1',
      status: 'DUAL_ACTIVE',
      treasuryAccountId: 'acct-1',
    })
    mockDb.$transaction.mockImplementation(async (fn: any) =>
      fn({
        signerRotation: {
          update: jest
            .fn()
            .mockResolvedValue({ id: 'r1', status: 'FINALIZED' }),
        },
        treasuryAccount: {
          update: jest
            .fn()
            .mockResolvedValue({ id: 'acct-1', publicKey: 'GNEW' }),
        },
      })
    )

    const result = await finalizeRotation('r1', 'admin-1')

    expect(result.status).toBe('FINALIZED')
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1)
  })
})
