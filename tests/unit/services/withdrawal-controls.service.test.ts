jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    complianceCase: { findFirst: jest.fn() },
    transaction: { findMany: jest.fn() },
    outboxOp: { findMany: jest.fn() },
    savingsGoal: { findMany: jest.fn() },
    position: { findMany: jest.fn() },
  },
}))
import { Keypair } from '@stellar/stellar-sdk'
import db from '../../../src/db'
import { assessWithdrawal } from '../../../src/services/withdrawal-controls.service'
describe('shared withdrawal controls', () => {
  const address = Keypair.random().publicKey()
  beforeEach(() => {
    jest.clearAllMocks()
    ;(db.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'user',
      isActive: true,
      walletAddress: address,
      createdAt: new Date('2020-01-01'),
    })
    ;(db.complianceCase.findFirst as jest.Mock).mockResolvedValue(null)
    ;(db.transaction.findMany as jest.Mock).mockResolvedValue([])
    ;(db.outboxOp.findMany as jest.Mock).mockResolvedValue([])
    ;(db.savingsGoal.findMany as jest.Mock).mockResolvedValue([])
    ;(db.position.findMany as jest.Mock).mockResolvedValue([
      { currentValue: 100 },
    ])
  })
  it('holds malformed destinations before loading financial history', async () => {
    expect((await assessWithdrawal('user', 'invalid', 'USDC', 10)).reason).toBe(
      'invalid_destination'
    )
    expect(db.transaction.findMany).not.toHaveBeenCalled()
  })
  it('holds inactive users and active compliance cases', async () => {
    ;(db.user.findUnique as jest.Mock).mockResolvedValue({ isActive: false })
    expect((await assessWithdrawal('user', address, 'USDC', 10)).reason).toBe(
      'compliance_freeze'
    )
    ;(db.user.findUnique as jest.Mock).mockResolvedValue({ isActive: true })
    ;(db.complianceCase.findFirst as jest.Mock).mockResolvedValue({
      id: 'case',
    })
    expect((await assessWithdrawal('user', address, 'USDC', 10)).reason).toBe(
      'compliance_freeze'
    )
  })
  it('scores new destinations and holds them without sending', async () => {
    const result = await assessWithdrawal(
      'user',
      Keypair.random().publicKey(),
      'USDC',
      10
    )
    expect(result.held).toBe(true)
    expect(result.score?.reasonCodes).toContain('NEW_DESTINATION_NO_HISTORY')
  })
  it('uses confirmed outbox destinations as exact history rather than memo text', async () => {
    const external = Keypair.random().publicKey()
    ;(db.outboxOp.findMany as jest.Mock).mockResolvedValue([
      { payload: { userAddress: external } },
    ])
    expect((await assessWithdrawal('user', external, 'USDC', 10)).held).toBe(
      false
    )
  })
  it('requires explicit manual goal acknowledgement and never relaxes destination risk', async () => {
    ;(db.savingsGoal.findMany as jest.Mock).mockResolvedValue([
      { targetAmount: 95 },
    ])
    expect((await assessWithdrawal('user', address, 'USDC', 10)).reason).toBe(
      'goal_guardrail'
    )
    expect(
      (await assessWithdrawal('user', address, 'USDC', 10, true)).held
    ).toBe(false)
    expect(
      (
        await assessWithdrawal(
          'user',
          Keypair.random().publicKey(),
          'USDC',
          10,
          true
        )
      ).held
    ).toBe(true)
  })
})
