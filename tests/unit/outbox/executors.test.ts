/**
 * Comprehensive executor coverage (#528, #693).
 * Pins that every money-moving outbox method resolves a signer and dispatches,
 * rather than silently failing or falling through the switch.
 */

import {
  resolveSignerPublicKey,
  executeOutboxPayload,
} from '../../../src/outbox/executors'
import { OutboxPayload } from '../../../src/outbox/types'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    treasuryAccount: { findFirst: jest.fn() },
    reserveSponsorship: { create: jest.fn(), updateMany: jest.fn() },
  },
}))

jest.mock('../../../src/stellar/wallet', () => ({
  getWalletByUserId: jest.fn(),
}))

jest.mock('../../../src/stellar/client', () => ({
  getAgentKeypair: () => ({ publicKey: () => 'GAGENT_KEY' }),
  submitTransaction: jest.fn().mockResolvedValue('sponsored-tx-hash'),
  waitForConfirmation: jest
    .fn()
    .mockResolvedValue({ status: 'success', hash: 'sponsored-tx-hash' }),
  prepareTransaction: jest.fn().mockResolvedValue({ sign: jest.fn() }),
  simulateTransaction: jest.fn().mockResolvedValue({}),
  getAccount: jest.fn().mockResolvedValue({}),
  getNetworkPassphrase: jest
    .fn()
    .mockReturnValue('Test SDF Network ; September 2015'),
}))

jest.mock('../../../src/stellar/sponsorship', () => ({
  buildSponsoredCreateAccount: jest.fn().mockReturnValue({}),
  buildSponsoredTrustline: jest.fn().mockReturnValue({}),
  buildRevokeSponsorship: jest.fn().mockReturnValue({}),
  getSponsorKeypairs: () => [{ publicKey: () => 'GSPONSOR_ACCOUNT' }],
}))

jest.mock('../../../src/stellar/contract', () => ({
  depositForUser: jest
    .fn()
    .mockResolvedValue({ hash: 'deposit-hash', status: 'success' }),
  withdrawForUser: jest
    .fn()
    .mockResolvedValue({ hash: 'withdraw-hash', status: 'success' }),
  triggerRebalance: jest
    .fn()
    .mockResolvedValue({ hash: 'rebalance-hash', status: 'success' }),
  payReferralReward: jest
    .fn()
    .mockResolvedValue({ hash: 'referral-hash', status: 'success' }),
}))

import db from '../../../src/db'
import { getWalletByUserId } from '../../../src/stellar/wallet'
import {
  depositForUser,
  withdrawForUser,
  triggerRebalance,
  payReferralReward,
} from '../../../src/stellar/contract'

const onSubmitted = jest.fn().mockResolvedValue(undefined)

beforeEach(() => {
  jest.clearAllMocks()
  ;(getWalletByUserId as jest.Mock).mockResolvedValue({
    publicKey: 'GCUSTODIAL_WALLET',
  })
})

describe('resolveSignerPublicKey', () => {
  it('resolves custodial wallet for deposit, withdraw, loan_disburse, loan_repayment', async () => {
    const methods = [
      'deposit',
      'withdraw',
      'loan_disburse',
      'loan_repayment',
    ] as const
    for (const method of methods) {
      const key = await resolveSignerPublicKey({ method } as any, 'user-123')
      expect(key).toBe('GCUSTODIAL_WALLET')
    }
  })

  it('resolves agent key for rebalance, referral_reward, loan_liquidation, protection_fund_payout', async () => {
    const methods = [
      'rebalance',
      'referral_reward',
      'loan_liquidation',
      'protection_fund_payout',
    ] as const
    for (const method of methods) {
      const key = await resolveSignerPublicKey({ method } as any, 'user-123')
      expect(key).toBe('GAGENT_KEY')
    }
  })

  it('resolves sponsorAccount for sponsorship operations', async () => {
    const key = await resolveSignerPublicKey(
      {
        method: 'sponsor_create_account',
        sponsorAccount: 'GSPONSOR_ACCOUNT',
      } as any,
      'user-123'
    )
    expect(key).toBe('GSPONSOR_ACCOUNT')
  })

  it('resolves treasury account for treasury_sweep', async () => {
    ;(db.treasuryAccount.findFirst as jest.Mock).mockResolvedValue({
      publicKey: 'GHOT_TREASURY',
    })
    const key = await resolveSignerPublicKey(
      {
        method: 'treasury_sweep',
        fromTier: 'HOT',
      } as any,
      'SYSTEM'
    )
    expect(key).toBe('GHOT_TREASURY')
  })

  it('throws for unsupported outbox method', async () => {
    await expect(
      resolveSignerPublicKey({ method: 'invalid_method' } as any, 'user-1')
    ).rejects.toThrow('Unsupported outbox method')
  })
})

describe('executeOutboxPayload — table-driven dispatch (#693)', () => {
  const testCases: {
    name: string
    payload: OutboxPayload
    expectedCall: () => void
  }[] = [
    {
      name: 'deposit',
      payload: {
        method: 'deposit',
        userId: 'u1',
        userAddress: 'GUSER1',
        amount: 100,
        assetSymbol: 'USDC',
        transactionId: 'tx-dep',
      },
      expectedCall: () => {
        expect(depositForUser).toHaveBeenCalledWith(
          'u1',
          'GUSER1',
          100,
          'USDC',
          1,
          onSubmitted
        )
      },
    },
    {
      name: 'withdraw',
      payload: {
        method: 'withdraw',
        userId: 'u1',
        userAddress: 'GUSER1',
        amount: 50,
        assetSymbol: 'USDC',
        transactionId: 'tx-with',
      },
      expectedCall: () => {
        expect(withdrawForUser).toHaveBeenCalledWith(
          'u1',
          'GUSER1',
          50,
          'USDC',
          1,
          onSubmitted
        )
      },
    },
    {
      name: 'loan_disburse',
      payload: {
        method: 'loan_disburse',
        userId: 'u1',
        userAddress: 'GUSER1',
        amount: 250,
        assetSymbol: 'USDC',
        transactionId: 'tx-loan-disb',
        loanId: 'loan-1',
      },
      expectedCall: () => {
        expect(withdrawForUser).toHaveBeenCalledWith(
          'u1',
          'GUSER1',
          250,
          'USDC',
          1,
          onSubmitted
        )
      },
    },
    {
      name: 'loan_repayment',
      payload: {
        method: 'loan_repayment',
        userId: 'u1',
        userAddress: 'GUSER1',
        amount: 100,
        assetSymbol: 'USDC',
        transactionId: 'tx-loan-rep',
        loanId: 'loan-1',
      },
      expectedCall: () => {
        expect(depositForUser).toHaveBeenCalledWith(
          'u1',
          'GUSER1',
          100,
          'USDC',
          1,
          onSubmitted
        )
      },
    },
    {
      name: 'rebalance',
      payload: {
        method: 'rebalance',
        toProtocol: 'Blend',
        expectedApyBasisPoints: 450,
        transactionId: 'tx-reb',
      },
      expectedCall: () => {
        expect(triggerRebalance).toHaveBeenCalledWith(
          'Blend',
          450,
          1,
          onSubmitted
        )
      },
    },
    {
      name: 'referral_reward',
      payload: {
        method: 'referral_reward',
        recipientAddress: 'GRECIPIENT',
        amount: 25,
        assetSymbol: 'USDC',
        transactionId: 'tx-ref',
        conversionId: 'conv-1',
        leg: 'owner',
      },
      expectedCall: () => {
        expect(payReferralReward).toHaveBeenCalledWith(
          'GRECIPIENT',
          25,
          'USDC',
          1,
          onSubmitted
        )
      },
    },
    {
      name: 'protection_fund_payout',
      payload: {
        method: 'protection_fund_payout',
        userId: 'u1',
        amount: 500,
        assetSymbol: 'USDC',
        claimId: 'claim-1',
        eventId: 'event-1',
      } as any,
      expectedCall: () => {
        expect(withdrawForUser).toHaveBeenCalledWith(
          'u1',
          'GCUSTODIAL_WALLET',
          500,
          'USDC',
          1,
          onSubmitted
        )
      },
    },
  ]

  for (const tc of testCases) {
    it(`correctly dispatches ${tc.name}`, async () => {
      const result = await executeOutboxPayload(tc.payload, 1, onSubmitted)
      expect(result.status).toBe('success')
      tc.expectedCall()
    })
  }

  it('executes loan_liquidation as an internal protective netting entry', async () => {
    const result = await executeOutboxPayload(
      {
        method: 'loan_liquidation',
        userId: 'u1',
        loanId: 'loan-1',
        positionId: 'pos-1',
        collateralAmount: 10,
        collateralAssetSymbol: 'XLM',
        debtOutstanding: 50,
        borrowedAsset: 'USDC',
        trigger: 'scheduled',
        transactionId: 'tx-liq',
        sequence: 1,
      },
      1,
      onSubmitted
    )

    expect(result.status).toBe('success')
    expect(result.hash).toContain('liquidation-loan-1-1')
    expect(onSubmitted).toHaveBeenCalledWith(result.hash)
  })

  it('throws explicitly for unhandled outbox payload method', async () => {
    await expect(
      executeOutboxPayload(
        { method: 'unsupported_test_method' } as any,
        1,
        onSubmitted
      )
    ).rejects.toThrow('Unsupported outbox method: unsupported_test_method')
  })
})
