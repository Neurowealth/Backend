import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const CASE_OPEN_SCORE = 75;

export async function checkAndOpenCase(userId: string, txId: string, score: number) {
  if (score >= CASE_OPEN_SCORE) {
    // Open or attach to case
    const existingCase = await prisma.complianceCase.findFirst({
      where: { userId, status: { not: 'CLOSED_NO_ACTION' } } // simplified condition
    });
    
    if (existingCase) {
      await prisma.caseEvent.create({
        data: {
          caseId: existingCase.id,
          type: 'EVIDENCE',
          actor: 'SYSTEM',
          body: { txId, score }
        }
      });
    } else {
      await prisma.complianceCase.create({
        data: {
          userId,
          priority: 'HIGH',
          openedReason: 'score_threshold',
          triggerScore: score,
          relatedTxnIds: [txId]
        }
      });
    }
  }
}
