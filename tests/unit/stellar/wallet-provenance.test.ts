/**
 * CustodialWallet key-provenance unit tests (#323).
 *
 * getKeypairForUser has two read paths:
 *   1. Deterministic: wallet.encryptionKeyId is set — look up which key
 *      encrypted the row, decrypt with exactly that key. No guessing.
 *   2. Legacy compatibility shim: encryptionKeyId is null (pre-provenance
 *      row) — try-primary-then-fallback, then opportunistically backfill
 *      encryptionKeyId so the next read takes path 1.
 *
 * These tests exercise both paths against a mocked db, plus the "operator
 * hasn't configured the right key" and "row belongs to neither active nor
 * fallback key" failure modes, since those are exactly the cases a real
 * rotation can hit.
 */

import * as crypto from 'crypto'
import { Keypair } from '@stellar/stellar-sdk'

const ACTIVE_KEY =
  'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
const OLD_KEY =
  'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3'
const UNKNOWN_KEY =
  'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'

function hashHex(keyHex: string): string {
  return crypto.createHash('sha256').update(keyHex, 'hex').digest('hex')
}

function encryptWithKey(
  secret: string,
  keyHex: string
): { encrypted: string; iv: string; authTag: string } {
  const key = Buffer.from(keyHex, 'hex')
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  let encrypted = cipher.update(secret, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  }
}

const mockWalletFindUnique = jest.fn()
const mockWalletUpdate = jest.fn()
const mockWalletCreate = jest.fn()
const mockKeyFindUnique = jest.fn()
const mockKeyCreate = jest.fn()

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    custodialWallet: {
      findUnique: (...args: unknown[]) => mockWalletFindUnique(...args),
      update: (...args: unknown[]) => mockWalletUpdate(...args),
      create: (...args: unknown[]) => mockWalletCreate(...args),
    },
    walletEncryptionKey: {
      findUnique: (...args: unknown[]) => mockKeyFindUnique(...args),
      create: (...args: unknown[]) => mockKeyCreate(...args),
    },
  },
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

import {
  getKeypairForUser,
  createCustodialWallet,
} from '../../../src/stellar/wallet'

const realUser = Keypair.random()

beforeEach(() => {
  jest.clearAllMocks()
  process.env.WALLET_ENCRYPTION_KEY = ACTIVE_KEY
  delete process.env.WALLET_ENCRYPTION_KEY_OLD
})

describe('getKeypairForUser — deterministic (encryptionKeyId set)', () => {
  it('decrypts with exactly the key recorded for the row, matching the active env key', async () => {
    const { encrypted, iv, authTag } = encryptWithKey(
      realUser.secret(),
      ACTIVE_KEY
    )
    mockWalletFindUnique.mockResolvedValue({
      id: 'wallet-1',
      userId: 'user-1',
      publicKey: realUser.publicKey(),
      encryptedSecret: encrypted,
      iv,
      authTag,
      keyVersion: 2,
      encryptionKeyId: 'key-active',
    })
    mockKeyFindUnique.mockResolvedValue({
      id: 'key-active',
      hash: hashHex(ACTIVE_KEY),
    })

    const keypair = await getKeypairForUser('user-1')

    expect(keypair.publicKey()).toBe(realUser.publicKey())
    // Deterministic path never touches the write path.
    expect(mockWalletUpdate).not.toHaveBeenCalled()
  })

  it('decrypts with the fallback env key when the recorded key matches it instead of the active key', async () => {
    process.env.WALLET_ENCRYPTION_KEY_OLD = OLD_KEY
    const { encrypted, iv, authTag } = encryptWithKey(
      realUser.secret(),
      OLD_KEY
    )
    mockWalletFindUnique.mockResolvedValue({
      id: 'wallet-2',
      userId: 'user-2',
      publicKey: realUser.publicKey(),
      encryptedSecret: encrypted,
      iv,
      authTag,
      keyVersion: 2,
      encryptionKeyId: 'key-old',
    })
    mockKeyFindUnique.mockResolvedValue({
      id: 'key-old',
      hash: hashHex(OLD_KEY),
    })

    const keypair = await getKeypairForUser('user-2')

    expect(keypair.publicKey()).toBe(realUser.publicKey())
  })

  it("throws a clear, actionable error when no configured env key matches the row's recorded key", async () => {
    const { encrypted, iv, authTag } = encryptWithKey(
      realUser.secret(),
      UNKNOWN_KEY
    )
    mockWalletFindUnique.mockResolvedValue({
      id: 'wallet-3',
      userId: 'user-3',
      publicKey: realUser.publicKey(),
      encryptedSecret: encrypted,
      iv,
      authTag,
      keyVersion: 2,
      encryptionKeyId: 'key-unknown',
    })
    mockKeyFindUnique.mockResolvedValue({
      id: 'key-unknown',
      hash: hashHex(UNKNOWN_KEY),
    })

    await expect(getKeypairForUser('user-3')).rejects.toThrow(
      /No key material available in this environment/
    )
  })

  it('throws when the recorded encryptionKeyId no longer exists in the registry', async () => {
    const { encrypted, iv, authTag } = encryptWithKey(
      realUser.secret(),
      ACTIVE_KEY
    )
    mockWalletFindUnique.mockResolvedValue({
      id: 'wallet-4',
      userId: 'user-4',
      publicKey: realUser.publicKey(),
      encryptedSecret: encrypted,
      iv,
      authTag,
      keyVersion: 2,
      encryptionKeyId: 'missing-key-id',
    })
    mockKeyFindUnique.mockResolvedValue(null)

    await expect(getKeypairForUser('user-4')).rejects.toThrow(
      /No key material available in this environment/
    )
  })
})

describe('getKeypairForUser — legacy rows (encryptionKeyId null)', () => {
  it('decrypts via the dual-key heuristic and backfills provenance for a v2 row', async () => {
    const { encrypted, iv, authTag } = encryptWithKey(
      realUser.secret(),
      ACTIVE_KEY
    )
    mockWalletFindUnique.mockResolvedValue({
      id: 'wallet-5',
      userId: 'user-5',
      publicKey: realUser.publicKey(),
      encryptedSecret: encrypted,
      iv,
      authTag,
      keyVersion: 2,
      encryptionKeyId: null,
    })
    // Registry: active key not yet registered -> create it.
    mockKeyFindUnique.mockResolvedValue(null)
    mockKeyCreate.mockResolvedValue({ id: 'new-active-key' })

    const keypair = await getKeypairForUser('user-5')

    expect(keypair.publicKey()).toBe(realUser.publicKey())
    expect(mockKeyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ACTIVE' }),
      })
    )
    expect(mockWalletUpdate).toHaveBeenCalledWith({
      where: { id: 'wallet-5' },
      data: { encryptionKeyId: 'new-active-key' },
    })
  })

  it('lazily re-encrypts a v1 row under the active key and sets provenance directly', async () => {
    const { encrypted, iv, authTag } = encryptWithKey(
      realUser.secret(),
      ACTIVE_KEY
    )
    mockWalletFindUnique.mockResolvedValue({
      id: 'wallet-6',
      userId: 'user-6',
      publicKey: realUser.publicKey(),
      encryptedSecret: encrypted,
      iv,
      authTag,
      keyVersion: 1,
      encryptionKeyId: null,
    })
    mockKeyFindUnique.mockResolvedValue(null)
    mockKeyCreate.mockResolvedValue({ id: 'new-active-key' })

    const keypair = await getKeypairForUser('user-6')

    expect(keypair.publicKey()).toBe(realUser.publicKey())
    expect(mockWalletUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wallet-6' },
        data: expect.objectContaining({
          keyVersion: 2,
          encryptionKeyId: 'new-active-key',
        }),
      })
    )
  })

  it('does not fail the read if provenance backfill itself fails', async () => {
    const { encrypted, iv, authTag } = encryptWithKey(
      realUser.secret(),
      ACTIVE_KEY
    )
    mockWalletFindUnique.mockResolvedValue({
      id: 'wallet-7',
      userId: 'user-7',
      publicKey: realUser.publicKey(),
      encryptedSecret: encrypted,
      iv,
      authTag,
      keyVersion: 2,
      encryptionKeyId: null,
    })
    mockKeyFindUnique.mockResolvedValue(null)
    mockKeyCreate.mockRejectedValue(new Error('db unavailable'))

    const keypair = await getKeypairForUser('user-7')

    expect(keypair.publicKey()).toBe(realUser.publicKey())
  })
})

describe('createCustodialWallet', () => {
  it('registers the active key and stamps the new wallet with its registry id', async () => {
    mockWalletFindUnique.mockResolvedValue(null) // no existing wallet for user
    mockKeyFindUnique.mockResolvedValue(null) // active key not yet registered
    mockKeyCreate.mockResolvedValue({ id: 'active-key-id' })
    mockWalletCreate.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'new-wallet-id', ...data })
    )

    const wallet = await createCustodialWallet('user-8')

    expect(wallet.encryptionKeyId).toBe('active-key-id')
    expect(mockWalletCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-8',
          encryptionKeyId: 'active-key-id',
        }),
      })
    )
  })
})
