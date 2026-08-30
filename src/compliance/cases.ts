import { PrismaClient, CaseStatus } from '@prisma/client'

const prisma = new PrismaClient()
const CASE_OPEN_SCORE = 75

/**
 * Terminal CaseStatus values (#393) — a case in one of these is resolved and
 * must never receive new evidence; a fresh high-score event opens a new case
 * instead. Everything else in the enum (OPEN, TRIAGE, INVESTIGATING,
 * ESCALATED, PENDING_SAR) is still active work, so new evidence attaches to
 * it. Keep this in sync with prisma/schema.prisma's CaseStatus enum.
 */
const TERMINAL_CASE_STATUSES: CaseStatus[] = [
  CaseStatus.SAR_FILED,
  CaseStatus.CLEARED,
  CaseStatus.CLOSED_NO_ACTION,
]

export async function checkAndOpenCase(
  userId: string,
  txId: string,
  score: number
) {
  if (score >= CASE_OPEN_SCORE) {
    // Open or attach to case
    const existingCase = await prisma.complianceCase.findFirst({
      where: { userId, status: { notIn: TERMINAL_CASE_STATUSES } },
    })

    if (existingCase) {
      await prisma.caseEvent.create({
        data: {
          caseId: existingCase.id,
          type: 'EVIDENCE',
          actor: 'SYSTEM',
          body: { txId, score },
        },
      })
    } else {
      await prisma.complianceCase.create({
        data: {
          userId,
          priority: 'HIGH',
          openedReason: 'score_threshold',
          triggerScore: score,
          relatedTxnIds: [txId],
        },
      })
    }
  }
}
