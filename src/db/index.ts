// src/db/index.ts
// Prisma Client Singleton — prevents multiple instances in dev (hot-reload safe)

import { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const db =
  globalForPrisma.prisma ||
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db
}

/**
 * Verify the database is reachable before the server accepts traffic.
 * Calls process.exit(1) with a clear message if the connection fails.
 */
export async function connectDb(): Promise<void> {
  try {
    await db.$connect()
    logger.info('[DB] Connected to database')
  } catch (error) {
    logger.error('[DB] Cannot connect to database — server will not start')
    logger.error(`[DB] ${error instanceof Error ? error.message : String(error)}`)
    logger.error('[DB] Check that DATABASE_URL is correct and the database is running')
    await db.$disconnect()
    process.exit(1)
  }
}

export default db