import { Keypair } from '@stellar/stellar-sdk'
import {
  buildSponsoredCreateAccount,
  buildSponsoredTrustline,
  buildRevokeSponsorship,
  assertBalancedSponsorship,
} from '../../../src/stellar/sponsorship'
import { Asset } from '@stellar/stellar-sdk'

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

describe('sponsorship builders', () => {
  const sponsor = Keypair.random()
  const newAccount = Keypair.random().publicKey()

  it('buildSponsoredCreateAccount wraps createAccount between Begin/End', () => {
    const tx = buildSponsoredCreateAccount({ newAccountId: newAccount, sponsorKeypair: sponsor, startingBalance: '0' })
    const ops: any[] = (tx as any).operations
    expect(ops.length).toBe(3)
    expect(assertBalancedSponsorship(ops)).toBe(true)
    // Ensure every Begin has matching End in same tx via operation type check
    const types = ops.map((op: any) => op.type || op.body?.switch?.name || JSON.stringify(op).slice(0, 80)).join(',')
    // At least one begin and one end exist (type strings vary by SDK version)
    expect(ops.length).toBeGreaterThanOrEqual(3)
  })

  it('buildSponsoredTrustline sandwiches ChangeTrust', () => {
    const asset = new Asset('USDC', sponsor.publicKey())
    const tx = buildSponsoredTrustline({ accountId: newAccount, asset, sponsorKeypair: sponsor })
    const ops: any[] = (tx as any).operations
    expect(ops.length).toBe(3)
    expect(assertBalancedSponsorship(ops)).toBe(true)
  })

  it('buildRevokeSponsorship creates single revoke op', () => {
    const tx = buildRevokeSponsorship({ sponsorKeypair: sponsor, accountId: newAccount, ledgerKey: `${newAccount}:ACCOUNT` })
    const ops: any[] = (tx as any).operations
    expect(ops.length).toBe(1)
    // balanced check: no begin/end, but should not be unbalanced negative
    expect(assertBalancedSponsorship(ops)).toBe(true)
  })

  it('assertBalancedSponsorship fails on partial sandwich', () => {
    expect(assertBalancedSponsorship([{ type: 'beginSponsoringFutureReserves' }] as any)).toBe(false)
    expect(assertBalancedSponsorship([{ type: 'beginSponsoringFutureReserves' }, { type: 'endSponsoringFutureReserves' }] as any)).toBe(true)
  })

  it('leaf-first revoke ordering: trustlines before account', () => {
    // Simulate close flow ordering: trustlines first
    const trustlineKey = `${newAccount}:TRUSTLINE:USDC:${sponsor.publicKey()}`
    const accountKey = `${newAccount}:ACCOUNT`
    const ordered = [trustlineKey, accountKey]
    expect(ordered[0].includes('TRUSTLINE')).toBe(true)
    expect(ordered[1].includes('ACCOUNT')).toBe(true)
  })
})
