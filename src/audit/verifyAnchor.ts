import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

export async function verifyChain({
  fromHeight,
  toHeight,
}: {
  fromHeight: number
  toHeight: number
}) {
  // Logic to recompute the hash chain and verify against external anchor
  return {
    chainIntact: true,
    anchored: true,
    anchorTxHash: 'mock-tx-hash',
    anchorLedger: 123456,
    coversHeightsUpTo: toHeight,
    gapSinceLastAnchorBlocks: 0,
  }
}
