import db from '../db'

const TRAVEL_RULE_THRESHOLD = 1000 // e.g. USD

export async function detectTravelRule(
  amountInBaseCurrency: number,
  outboxOpId: string,
  direction: 'INBOUND' | 'OUTBOUND',
  userId: string
) {
  if (amountInBaseCurrency >= TRAVEL_RULE_THRESHOLD) {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        walletAddress: true,
        displayName: true,
        email: true,
        network: true,
      },
    })

    const originator = user
      ? {
          name: user.displayName || 'Unknown User',
          accountOrWallet: user.walletAddress,
          address: user.walletAddress,
          idType: 'wallet',
        }
      : {}

    const beneficiary = user
      ? {
          name: user.displayName || 'Unknown User',
          accountOrWallet: user.walletAddress,
        }
      : {}

    const status = user ? 'READY' : 'PENDING_DATA'

    await db.travelRuleRecord.create({
      data: {
        transactionId: outboxOpId,
        direction,
        amountBaseCcy: amountInBaseCurrency,
        baseCurrency: 'USD',
        originator,
        beneficiary,
        counterpartyVasp: null,
        dataSource: user ? 'USER_ATTESTED' : 'SYSTEM',
        status,
      },
    })
  }
}
