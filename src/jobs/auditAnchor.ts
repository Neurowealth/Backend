import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

export async function runAuditAnchorJob() {
  // Read current chain tip
  const tip = await prisma.auditBlock.findFirst({
    orderBy: { height: 'desc' },
  })

  if (tip) {
    // Example: Enqueue to outbox
    // await prisma.outboxOp.create({ ... })
  }
}
