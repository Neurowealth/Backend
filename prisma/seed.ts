// prisma/seed.ts
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding NeuroWealth database...')

  // ── 1. Test User ─────────────────────────────────────────────────────────────
  const user = await prisma.user.upsert({
    where: { walletAddress: 'GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR65HOTVGT3WHCBLZXK' },
    update: {},
    create: {
      walletAddress: 'GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR65HOTVGT3WHCBLZXK',
      network: 'TESTNET',
      displayName: 'Alex Testnet',
      email: 'alex@neurowealth.dev',
      riskTolerance: 6,
      phoneNumber: '+15551234567',
      isActive: true,
      walletSecretEncrypted: Buffer.from('SOMESECRET').toString('base64'),
      // OTP fields left null since user is already active
    },
  })
  console.log(`✅ User: ${user.displayName} (${user.id})`)

  // ── 2. Protocol Rates ─────────────────────────────────────────────────────────
  const blendRate = await prisma.protocolRate.create({
    data: {
      protocolName: 'Blend',
      assetSymbol: 'USDC',
      supplyApy: 0.0842,
      borrowApy: 0.1123,
      tvl: 4200000,
      network: 'TESTNET',
    },
  })

  const aquaRate = await prisma.protocolRate.create({
    data: {
      protocolName: 'Aqua',
      assetSymbol: 'XLM',
      supplyApy: 0.0511,
      network: 'TESTNET',
    },
  })
  console.log(`✅ Protocol rates: Blend ${Number(blendRate.supplyApy) * 100}% APY, Aqua ${Number(aquaRate.supplyApy) * 100}% APY`)

  // ── 3. Position ───────────────────────────────────────────────────────────────
  const position = await prisma.position.create({
    data: {
      userId: user.id,
      protocolName: 'Blend',
      assetSymbol: 'USDC',
      depositedAmount: 5000,
      currentValue: 5187.5,
      yieldEarned: 187.5,
      status: 'ACTIVE',
    },
  })
  console.log(`✅ Position: ${position.depositedAmount} USDC on ${position.protocolName}`)

  // ── 4. Deposit Transaction ────────────────────────────────────────────────────
  const depositTx = await prisma.transaction.create({
    data: {
      userId: user.id,
      positionId: position.id,
      txHash: 'c3f1e2d4a5b6789012345678901234567890abcdef1234567890abcdef123456',
      type: 'DEPOSIT',
      status: 'CONFIRMED',
      assetSymbol: 'USDC',
      amount: 5000,
      fee: 0.00001,
      network: 'TESTNET',
      protocolName: 'Blend',
      memo: 'Initial deposit via NeuroWealth agent',
      confirmedAt: new Date(),
    },
  })
  console.log(`✅ Transaction: ${depositTx.amount} ${depositTx.assetSymbol} (${depositTx.txHash?.slice(0, 16)}...)`)

  // ── 5. Yield Snapshot ─────────────────────────────────────────────────────────
  const snapshot = await prisma.yieldSnapshot.create({
    data: {
      positionId: position.id,
      apy: 0.0842,
      yieldAmount: 187.5,
      principalAmount: 5000,
    },
  })
  console.log(`✅ Yield snapshot: ${Number(snapshot.apy) * 100}% APY`)

  // ── 6. Agent Log ──────────────────────────────────────────────────────────────
  await prisma.agentLog.create({
    data: {
      userId: user.id,
      action: 'DEPOSIT',
      status: 'SUCCESS',
      reasoning: 'Blend USDC offered the highest risk-adjusted APY (8.42%) for risk tolerance 6/10. TVL healthy at $4.2M.',
      inputData: {
        availableBalance: 5000,
        assetSymbol: 'USDC',
        riskTolerance: 6,
        protocols: ['Blend', 'Aqua', 'Phoenix'],
      },
      outputData: {
        selectedProtocol: 'Blend',
        depositAmount: 5000,
        expectedApy: 0.0842,
        txHash: depositTx.txHash,
      },
      durationMs: 1240,
    },
  })
  console.log(`✅ Agent log: DEPOSIT → SUCCESS`)

  // ── 7. Session ────────────────────────────────────────────────────────────────
  await prisma.session.create({
    data: {
      userId: user.id,
      token: 'seed_token_' + Math.random().toString(36).slice(2),
      walletAddress: user.walletAddress,
      network: 'TESTNET',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      ipAddress: '127.0.0.1',
      userAgent: 'NeuroWealth/1.0 Seed',
    },
  })
  console.log(`✅ Session created`)

  console.log('\n🎉 Seed complete! Run: npx prisma studio')
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })