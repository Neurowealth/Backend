const mockCall = jest.fn(() => ({ type: 'contract-call-op' }))
const mockBuild = jest.fn(() => mockBuiltTx)
const mockBuilder: any = {}
const mockAddOperation = jest.fn(() => mockBuilder)
const mockSetTimeout = jest.fn(() => mockBuilder)
const mockPrepareTransaction = jest.fn()
const mockGetAccount = jest.fn()
const mockScValToNative = jest.fn()
const mockNativeToScVal = jest.fn((value: unknown, options?: unknown) => ({
  value,
  options,
}))

const mockBuiltTx = { built: true } as any
const mockPreparedTx = {
  sign: jest.fn(),
} as any
Object.assign(mockBuilder, {
  addOperation: mockAddOperation,
  setTimeout: mockSetTimeout,
  build: mockBuild,
})
const mockServer = {
  getAccount: mockGetAccount,
  simulateTransaction: jest.fn(),
  prepareTransaction: mockPrepareTransaction,
}

jest.mock('@stellar/stellar-sdk', () => ({
  Contract: jest.fn().mockImplementation(() => ({
    call: mockCall,
  })),
  rpc: {
    Api: {
      isSimulationError: jest.fn(() => false),
    },
  },
  TransactionBuilder: jest.fn().mockImplementation(() => mockBuilder),
  BASE_FEE: '100',
  scValToNative: mockScValToNative,
  nativeToScVal: mockNativeToScVal,
}))

jest.mock('../../../src/stellar/client', () => ({
  getRpcServer: jest.fn(() => mockServer),
  getNetworkPassphrase: jest.fn(() => 'Test SDF Network ; September 2015'),
  getAgentKeypair: jest.fn(() => ({
    publicKey: () => 'GAGENTPUBLICKEY',
  })),
  submitTransaction: jest.fn(() => Promise.resolve('submitted-hash')),
  waitForConfirmation: jest.fn(() =>
    Promise.resolve({ hash: 'submitted-hash', status: 'success', ledger: 77 }),
  ),
}))

jest.mock('../../../src/stellar/wallet', () => ({
  getKeypairForUser: jest.fn(() =>
    Promise.resolve({
      publicKey: () => 'GUSERPUBLICKEY',
      sign: jest.fn(),
    }),
  ),
}))

import { Contract, TransactionBuilder, nativeToScVal } from '@stellar/stellar-sdk'
import { submitTransaction, waitForConfirmation } from '../../../src/stellar/client'
import { getKeypairForUser } from '../../../src/stellar/wallet'
import {
  deposit,
  depositForUser,
  withdraw,
  withdrawForUser,
} from '../../../src/stellar/contract'

describe('stellar contract write wrappers', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAccount.mockResolvedValue({ accountId: 'GACCOUNT' })
    mockPrepareTransaction.mockResolvedValue(mockPreparedTx)
  })

  it('builds, signs, submits, and confirms deposit transactions with the user keypair', async () => {
    const result = await depositForUser(
      '550e8400-e29b-41d4-a716-446655440003',
      'GUSERWALLETADDRESS',
      12.5,
    )

    expect(getKeypairForUser).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440003',
    )
    expect(mockGetAccount).toHaveBeenCalledWith('GUSERPUBLICKEY')
    expect(Contract).toHaveBeenCalled()
    expect(mockCall).toHaveBeenCalledWith(
      'deposit',
      expect.anything(),
      expect.anything(),
    )
    expect(nativeToScVal).toHaveBeenCalledWith('GUSERWALLETADDRESS', {
      type: 'address',
    })
    expect(nativeToScVal).toHaveBeenCalledWith(125000000n, { type: 'i128' })
    expect(mockPreparedTx.sign).toHaveBeenCalled()
    expect(submitTransaction).toHaveBeenCalledWith(mockPreparedTx)
    expect(waitForConfirmation).toHaveBeenCalledWith('submitted-hash')
    expect(result).toEqual({
      hash: 'submitted-hash',
      status: 'success',
      ledger: 77,
    })
  })

  it('builds withdraw transactions against the vault contract', async () => {
    const result = await withdrawForUser(
      '550e8400-e29b-41d4-a716-446655440003',
      'GUSERWALLETADDRESS',
      3,
    )

    expect(mockGetAccount).toHaveBeenCalledWith('GUSERPUBLICKEY')
    expect(mockCall).toHaveBeenCalledWith(
      'withdraw',
      expect.anything(),
      expect.anything(),
    )
    expect(nativeToScVal).toHaveBeenCalledWith(30000000n, { type: 'i128' })
    expect(result.hash).toBe('submitted-hash')
  })

  it('throws when confirmation returns a failed status', async () => {
    ;(waitForConfirmation as jest.Mock).mockResolvedValueOnce({
      hash: 'submitted-hash',
      status: 'failed',
    })

    await expect(
      deposit(
        '550e8400-e29b-41d4-a716-446655440003',
        'GUSERWALLETADDRESS',
        1,
      ),
    ).rejects.toThrow('Transaction deposit failed on-chain')
  })

  it('keeps the legacy deposit/withdraw exports wired to the typed helpers', async () => {
    await deposit('550e8400-e29b-41d4-a716-446655440003', 'GUSERWALLETADDRESS', 2)
    await withdraw('550e8400-e29b-41d4-a716-446655440003', 'GUSERWALLETADDRESS', 4)

    expect(mockCall).toHaveBeenNthCalledWith(
      1,
      'deposit',
      expect.anything(),
      expect.anything(),
    )
    expect(mockCall).toHaveBeenNthCalledWith(
      2,
      'withdraw',
      expect.anything(),
      expect.anything(),
    )
  })
})
