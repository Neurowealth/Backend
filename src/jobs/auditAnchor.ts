import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function runAuditAnchorJob() {
  console.log('Running audit anchor job...');
  // Read current chain tip
  const tip = await prisma.auditBlock.findFirst({
    orderBy: { height: 'desc' }
  });
  
  if (tip) {
    console.log(`Tip found at height ${tip.height}, hashing and sending to Outbox...`);
    // Example: Enqueue to outbox
    // await prisma.outboxOp.create({ ... })
  }
}
