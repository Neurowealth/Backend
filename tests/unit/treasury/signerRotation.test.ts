import {
  initiateRotation,
  finalizeRotation,
  SignerRotationStateError,
  SignerRotationValidationError,
} from '../../../src/treasury/signerRotation'
import db from '../../../src/db'
import { Keypair } from '@stellar/stellar-sdk'

// Real G... strkeys: the rotation path validates with StrKey, so placeholder
// strings like "GOLD" must be rejected before they reach the database (#671).
const OLD_KEY = Keypair.random().publicKey()
const NEW_KEY = Keypair.random().publicKey()

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
  it.each([
    ['newSignerKey', OLD_KEY, 'not-a-key'],
    ['newSignerKey', OLD_KEY, 'GNEW'],
    ['newSignerKey', OLD_KEY, 'S' + 'A'.repeat(55)],
    ['oldSignerKey', 'not-a-key', NEW_KEY],
  ])(
    'rejects an invalid %s at initiation without creating a row',
    async (field, oldKey, newKey) => {
      await expect(
        initiateRotation('acct-1', oldKey, newKey, 'admin-1')
      ).rejects.toBeInstanceOf(SignerRotationValidationError)
      expect(mockDb.signerRotation.create).not.toHaveBeenCalled()
    }
  )

  it('creates a rotation that enters DUAL_ACTIVE immediately', async () => {
    mockDb.signerRotation.create.mockResolvedValue({
      id: 'r1',
      status: 'DUAL_ACTIVE',
      dualActiveSince: new Date(),
    })

    const rotation = await initiateRotation(
      'acct-1',
      OLD_KEY,
      NEW_KEY,
      'admin-1'
    )

    expect(rotation.status).toBe('DUAL_ACTIVE')
    expect(mockDb.signerRotation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          treasuryAccountId: 'acct-1',
          oldSignerKey: OLD_KEY,
          newSignerKey: NEW_KEY,
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

  it('rejects finalizing a persisted rotation whose new key is invalid', async () => {
    mockDb.signerRotation.findUnique.mockResolvedValue({
      id: 'r1',
      status: 'DUAL_ACTIVE',
      treasuryAccountId: 'acct-1',
      newSignerKey: 'GNEW',
    })

    await expect(finalizeRotation('r1', 'admin-1')).rejects.toBeInstanceOf(
      SignerRotationValidationError
    )
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it('finalizes a DUAL_ACTIVE rotation', async () => {
    mockDb.signerRotation.findUnique.mockResolvedValue({
      id: 'r1',
      status: 'DUAL_ACTIVE',
      treasuryAccountId: 'acct-1',
      newSignerKey: NEW_KEY,
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
            .mockResolvedValue({ id: 'acct-1', publicKey: NEW_KEY }),
        },
      })
    )

    const result = await finalizeRotation('r1', 'admin-1')

    expect(result.status).toBe('FINALIZED')
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1)
  })
})
