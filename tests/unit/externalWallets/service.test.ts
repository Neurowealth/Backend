import { Keypair } from '@stellar/stellar-sdk'
import db from '../../../src/db'
import {
  ExternalWalletConflictError,
  linkExternalWallet,
  syncLinkedExternalWallets,
  valueExternalBalanceUsd,
} from '../../../src/externalWallets/service'
import { getExternalWalletBalances } from '../../../src/stellar/client'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/stellar/client', () => ({
  getExternalWalletBalances: jest.fn(),
}))

const mockDb = db as any
const mockReadBalances = getExternalWalletBalances as jest.Mock
const publicKey = Keypair.random().publicKey()

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.user = {
    findUnique: jest.fn().mockResolvedValue({ walletAddress: 'GUSER' }),
  }
  mockDb.custodialWallet = { findFirst: jest.fn().mockResolvedValue(null) }
  mockDb.linkedExternalWallet = {
    count: jest.fn().mockResolvedValue(0),
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({
      id: 'linked-1',
      verificationStatus: 'UNVERIFIED_SELF_REPORTED',
    }),
    findMany: jest.fn().mockResolvedValue([]),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
  }
})

describe('external wallet links', () => {
  it('creates explicitly unverified links and rejects platform-managed addresses', async () => {
    await linkExternalWallet('user-1', { publicKey, label: 'Other wallet' })
    expect(mockDb.linkedExternalWallet.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        publicKey,
        label: 'Other wallet',
        verificationStatus: 'UNVERIFIED_SELF_REPORTED',
      },
    })

    mockDb.custodialWallet.findFirst.mockResolvedValue({ id: 'custody-1' })
    await expect(
      linkExternalWallet('user-1', { publicKey, label: 'Duplicate' })
    ).rejects.toBeInstanceOf(ExternalWalletConflictError)

    mockDb.custodialWallet.findFirst.mockResolvedValue(null)
    mockDb.user.findUnique.mockResolvedValue({ walletAddress: publicKey })
    await expect(
      linkExternalWallet('user-1', { publicKey, label: 'Own auth wallet' })
    ).rejects.toBeInstanceOf(ExternalWalletConflictError)
  })

  it('keeps stale balances on a sync failure while recording the error', async () => {
    mockDb.linkedExternalWallet.findMany.mockResolvedValue([
      { id: 'linked-1', publicKey },
    ])
    mockReadBalances.mockRejectedValue(new Error('RPC unavailable'))

    await expect(syncLinkedExternalWallets()).resolves.toEqual({
      attempted: 1,
      synced: 0,
      failed: 1,
    })
    expect(mockDb.linkedExternalWallet.updateMany).toHaveBeenCalledWith({
      where: { id: 'linked-1' },
      data: expect.objectContaining({
        syncError: 'RPC unavailable',
        lastSyncAttemptAt: expect.any(Date),
      }),
    })
    expect(
      mockDb.linkedExternalWallet.updateMany.mock.calls[0][0].data
    ).not.toHaveProperty('balances')
    expect(mockDb.linkedExternalWallet.findMany).toHaveBeenCalledWith({
      orderBy: [
        { lastSyncAttemptAt: { sort: 'asc', nulls: 'first' } },
        { addedAt: 'asc' },
      ],
      take: 25,
    })
    expect(mockDb.linkedExternalWallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'linked-1', lastSyncAttemptAt: null },
        data: { lastSyncAttemptAt: expect.any(Date) },
      })
    )
  })

  it('values only USDC from the configured issuer', () => {
    const balance = {
      assetType: 'credit_alphanum4',
      assetCode: 'USDC',
      assetIssuer: 'GISSUER',
      amount: '25.50',
    }
    expect(valueExternalBalanceUsd(balance, 'GISSUER')).toBe(25.5)
    expect(valueExternalBalanceUsd(balance, 'GOTHER')).toBeNull()
    expect(
      valueExternalBalanceUsd({ ...balance, assetCode: 'XLM' }, 'GISSUER')
    ).toBeNull()
  })
})
