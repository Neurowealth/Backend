import {
  evaluateAbuseSignals,
  detectCircularReferral,
  checkDepositThenWithdraw,
} from '../../../src/referral/abuseSignals'

describe('Referral Sybil & Abuse Signals (#363)', () => {
  const now = new Date('2026-10-27T12:00:00.000Z')

  function createMockDb(overrides: Record<string, any> = {}) {
    return {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      transaction: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      referralConversion: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      session: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      fiatPurchasePlan: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      ...overrides,
    }
  }

  describe('1. self_funding_chain', () => {
    it('triggers when referrer withdrawal matches referred deposit within 72h', async () => {
      const db = createMockDb({
        user: {
          findUnique: jest
            .fn()
            .mockImplementation(({ where }: any) =>
              where.id === 'owner-1'
                ? { walletAddress: 'GOWNERWALLET111' }
                : { walletAddress: 'GREFERREDWALLET222' }
            ),
        },
        transaction: {
          findMany: jest.fn().mockImplementation(({ where }: any) => {
            if (where.userId === 'owner-1' && where.type === 'WITHDRAWAL') {
              return Promise.resolve([
                {
                  id: 'w-1',
                  amount: 500,
                  memo: 'to:GREFERREDWALLET222',
                  txHash: 'hash-w1',
                },
              ])
            }
            if (where.userId === 'referred-1' && where.type === 'DEPOSIT') {
              return Promise.resolve([
                {
                  id: 'd-1',
                  amount: 500,
                  memo: 'from:GOWNERWALLET111',
                  txHash: 'hash-d1',
                },
              ])
            }
            return Promise.resolve([])
          }),
        },
      })

      const res = await evaluateAbuseSignals({
        referralCodeId: 'rc-1',
        ownerUserId: 'owner-1',
        referredUserId: 'referred-1',
        qualifyingDepositAmount: 500,
        now,
        database: db,
      })

      expect(res.abuseReasons).toContain('self_funding_chain')
      expect(res.abuseRiskScore).toBe(50)
      expect(res.payoutHold).toBe('AUTO_REVIEW')
    })
  })

  describe('2. deposit_then_withdraw', () => {
    it('triggers when >= 80% of qualifying deposit is withdrawn inside hold window', async () => {
      const db = createMockDb({
        transaction: {
          findMany: jest.fn().mockImplementation(({ where }: any) => {
            if (where.userId === 'referred-1' && where.type === 'WITHDRAWAL') {
              return Promise.resolve([{ amount: 85 }])
            }
            return Promise.resolve([])
          }),
        },
      })

      const dtw = await checkDepositThenWithdraw({
        referredUserId: 'referred-1',
        qualifyingDepositAmount: 100,
        since: new Date(now.getTime() - 3600_000),
        database: db,
      })
      expect(dtw.triggered).toBe(true)
      expect(dtw.withdrawnRatio).toBeCloseTo(0.85, 2)

      const res = await evaluateAbuseSignals({
        referralCodeId: 'rc-1',
        ownerUserId: 'owner-1',
        referredUserId: 'referred-1',
        qualifyingDepositAmount: 100,
        now,
        database: db,
      })

      expect(res.abuseReasons).toContain('deposit_then_withdraw')
      expect(res.abuseRiskScore).toBe(60)
      expect(res.payoutHold).toBe('AUTO_REVIEW')
    })
  })

  describe('3. burst_activations', () => {
    it('triggers when >= 5 activations occur in 60 minutes with near-identical deposits', async () => {
      const db = createMockDb({
        referralConversion: {
          findUnique: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockImplementation(({ where }: any) => {
            if (where.activatedAt) {
              return Promise.resolve([
                { id: 'c1', qualifyingDepositAmount: 10 },
                { id: 'c2', qualifyingDepositAmount: 10 },
                { id: 'c3', qualifyingDepositAmount: 10 },
                { id: 'c4', qualifyingDepositAmount: 10 },
              ])
            }
            return Promise.resolve([])
          }),
        },
      })

      const res = await evaluateAbuseSignals({
        referralCodeId: 'rc-1',
        ownerUserId: 'owner-1',
        referredUserId: 'referred-5',
        qualifyingDepositAmount: 10,
        now,
        database: db,
      })

      expect(res.abuseReasons).toContain('burst_activations')
      expect(res.abuseRiskScore).toBe(45)
      expect(res.payoutHold).toBe('AUTO_REVIEW')
    })
  })

  describe('4. shared_fingerprint', () => {
    it('triggers on shared IPv4 /24 subnet or shared paymentMethodRef', async () => {
      const db = createMockDb({
        fiatPurchasePlan: {
          findMany: jest.fn().mockImplementation(({ where }: any) => {
            if (where.userId === 'owner-1' || where.userId === 'referred-1') {
              return Promise.resolve([{ paymentMethodRef: 'pm_shared_card_99' }])
            }
            return Promise.resolve([])
          }),
        },
      })

      const res = await evaluateAbuseSignals({
        referralCodeId: 'rc-1',
        ownerUserId: 'owner-1',
        referredUserId: 'referred-1',
        qualifyingDepositAmount: 50,
        preloadedSessions: {
          ownerSessions: [{ ipAddress: '192.0.2.10', userAgent: 'ua-1' }],
          referredSessions: [{ ipAddress: '192.0.2.250', userAgent: 'ua-2' }],
        },
        now,
        database: db,
      })

      expect(res.abuseReasons).toContain('shared_fingerprint')
      expect(res.abuseRiskScore).toBe(40)
      expect(res.payoutHold).toBe('AUTO_REVIEW')
    })
  })

  describe('5. circular_referral', () => {
    it('detects length-2 (A -> B -> A) and length-3 (A -> B -> C -> A) referral cycles', async () => {
      const graph: Record<string, string> = {
        'user-b': 'user-a',
        'user-c': 'user-b',
      }
      const db = createMockDb({
        referralConversion: {
          findUnique: jest.fn().mockImplementation(({ where }: any) => {
            const owner = graph[where.referredUserId]
            if (!owner) return Promise.resolve(null)
            return Promise.resolve({
              referredUserId: where.referredUserId,
              referralCode: { ownerUserId: owner },
            })
          }),
          findMany: jest.fn().mockResolvedValue([]),
        },
      })

      // Cycle of length 3: user-a -> user-b -> user-c -> user-a
      const cycle = await detectCircularReferral('user-c', 'user-a', db)
      expect(cycle.isCircular).toBe(true)
      expect(cycle.chain).toEqual(['user-a', 'user-c', 'user-b', 'user-a'])

      const res = await evaluateAbuseSignals({
        referralCodeId: 'rc-c',
        ownerUserId: 'user-c',
        referredUserId: 'user-a',
        qualifyingDepositAmount: 100,
        now,
        database: db,
      })

      expect(res.abuseReasons).toContain('circular_referral')
      expect(res.abuseRiskScore).toBe(85)
      expect(res.payoutHold).toBe('DENIED')
    })
  })

  describe('6. fresh_wallet_cohort', () => {
    it('triggers when >= 3 referred accounts under same referrer are created within 10 minutes', async () => {
      const db = createMockDb({
        user: {
          findUnique: jest.fn().mockResolvedValue({
            createdAt: new Date('2026-10-27T11:55:00.000Z'),
          }),
        },
        referralConversion: {
          findUnique: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockImplementation(({ where }: any) => {
            if (where.referredUser?.createdAt) {
              return Promise.resolve([
                { referredUserId: 'referred-1' },
                { referredUserId: 'referred-2' },
                { referredUserId: 'referred-3' },
              ])
            }
            return Promise.resolve([])
          }),
        },
      })

      const res = await evaluateAbuseSignals({
        referralCodeId: 'rc-1',
        ownerUserId: 'owner-1',
        referredUserId: 'referred-1',
        qualifyingDepositAmount: 50,
        now,
        database: db,
      })

      expect(res.abuseReasons).toContain('fresh_wallet_cohort')
      expect(res.abuseRiskScore).toBe(45)
      expect(res.payoutHold).toBe('AUTO_REVIEW')
    })
  })

  describe('Composite score bands (< 40 NONE, 40-79 AUTO_REVIEW, >= 80 DENIED)', () => {
    it('returns score 0 and payoutHold = NONE when no signals fire', async () => {
      const db = createMockDb()
      const res = await evaluateAbuseSignals({
        referralCodeId: 'rc-1',
        ownerUserId: 'owner-1',
        referredUserId: 'referred-1',
        qualifyingDepositAmount: 100,
        now,
        database: db,
      })

      expect(res.abuseRiskScore).toBe(0)
      expect(res.abuseReasons).toEqual([])
      expect(res.payoutHold).toBe('NONE')
    })

    it('combines multiple signals into >= 80 DENIED and clamps score at 100', async () => {
      const db = createMockDb({
        user: {
          findUnique: jest.fn().mockResolvedValue({
            walletAddress: 'GWALLET',
            createdAt: new Date('2026-10-27T11:55:00.000Z'),
          }),
        },
        transaction: {
          findMany: jest.fn().mockImplementation(({ where }: any) => {
            if (where.type === 'WITHDRAWAL') {
              return Promise.resolve([{ id: 'w1', amount: 100, memo: 'funder:1' }])
            }
            if (where.type === 'DEPOSIT') {
              return Promise.resolve([{ id: 'd1', amount: 100, memo: 'funder:1' }])
            }
            return Promise.resolve([])
          }),
        },
        referralConversion: {
          findUnique: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([
            { referredUserId: 'referred-1' },
            { referredUserId: 'referred-2' },
            { referredUserId: 'referred-3' },
          ]),
        },
      })

      const res = await evaluateAbuseSignals({
        referralCodeId: 'rc-1',
        ownerUserId: 'owner-1',
        referredUserId: 'referred-1',
        qualifyingDepositAmount: 100,
        now,
        database: db,
      })

      expect(res.abuseRiskScore).toBe(100)
      expect(res.payoutHold).toBe('DENIED')
      expect(res.abuseReasons).toEqual(
        expect.arrayContaining([
          'self_funding_chain',
          'deposit_then_withdraw',
          'fresh_wallet_cohort',
        ])
      )
    })
  })
})
