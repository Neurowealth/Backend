import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TRAVEL_RULE_THRESHOLD = 1000; // e.g. USD

export async function detectTravelRule(amountInBaseCurrency: number, outboxOpId: string, direction: 'INBOUND' | 'OUTBOUND') {
  if (amountInBaseCurrency >= TRAVEL_RULE_THRESHOLD) {
    await prisma.travelRuleRecord.create({
      data: {
        transactionId: outboxOpId,
        direction,
        amountBaseCcy: amountInBaseCurrency,
        baseCurrency: 'USD',
        originator: {}, // pull from KycProfile
        beneficiary: {},
        dataSource: 'SYSTEM',
        status: 'PENDING_DATA'
      }
    });
  }
}
