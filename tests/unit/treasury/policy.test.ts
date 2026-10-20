import {
  enablePolicy,
  validatePolicyInput,
  TreasuryPolicyValidationError,
} from '../../../src/treasury/policy'

describe('validatePolicyInput', () => {
  const base = {
    fromTier: 'HOT' as const,
    toTier: 'WARM' as const,
    maxHotBalance: '10000',
    sweepIntervalMinutes: 60,
    minSweepAmount: '10',
    requiresApprovalAbove: '5000',
  }

  it('accepts a sane policy', () => {
    expect(() => validatePolicyInput(base)).not.toThrow()
  })

  it('rejects sweepIntervalMinutes <= 0', () => {
    expect(() =>
      validatePolicyInput({ ...base, sweepIntervalMinutes: 0 })
    ).toThrow(TreasuryPolicyValidationError)
  })

  it('rejects minSweepAmount >= maxHotBalance', () => {
    expect(() =>
      validatePolicyInput({ ...base, minSweepAmount: '10000' })
    ).toThrow(TreasuryPolicyValidationError)
  })

  it('rejects fromTier === toTier', () => {
    expect(() => validatePolicyInput({ ...base, toTier: 'HOT' })).toThrow(
      TreasuryPolicyValidationError
    )
  })

  it('rejects requiresApprovalAbove greater than maxHotBalance', () => {
    expect(() =>
      validatePolicyInput({ ...base, requiresApprovalAbove: '99999' })
    ).toThrow(TreasuryPolicyValidationError)
  })
})

describe('enablePolicy (#620)', () => {
  const makeDb = (policy: any) =>
    ({
      treasurySweepPolicy: {
        findUnique: jest.fn().mockResolvedValue(policy),
        update: jest.fn().mockResolvedValue({ ...policy, sweepsEnabled: true }),
      },
    }) as any

  it('rejects anything but the exact text SWEEP', async () => {
    const database = makeDb({ id: 'p1', isActive: true })
    for (const bad of ['sweep', 'SWEEP ', '', undefined as any]) {
      await expect(enablePolicy('p1', bad, 'admin', database)).rejects.toThrow(
        TreasuryPolicyValidationError
      )
    }
    expect(database.treasurySweepPolicy.update).not.toHaveBeenCalled()
  })

  it('rejects an inactive (superseded) policy version', async () => {
    const database = makeDb({ id: 'p1', isActive: false })
    await expect(
      enablePolicy('p1', 'SWEEP', 'admin', database)
    ).rejects.toThrow('active policy')
  })

  it('enables the policy and records who enabled it', async () => {
    const database = makeDb({ id: 'p1', isActive: true })
    await enablePolicy('p1', 'SWEEP', 'admin', database)
    expect(database.treasurySweepPolicy.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: {
        sweepsEnabled: true,
        enabledBy: 'admin',
        enabledAt: expect.any(Date),
      },
    })
  })
})
