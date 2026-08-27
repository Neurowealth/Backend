// src/db/index.ts
// Prisma Client Singleton — prevents multiple instances in dev (hot-reload safe)

import { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

/**
 * Apply DATABASE_CONNECTION_LIMIT (if set) to the connection string as a
 * `connection_limit` query parameter. Prisma reads pool sizing from the URL;
 * if the URL already specifies connection_limit, the explicit value wins.
 */
function buildDatabaseUrl(): string | undefined {
  const base = process.env.DATABASE_URL
  const limit = process.env.DATABASE_CONNECTION_LIMIT
  if (!base || !limit) return base
  try {
    const url = new URL(base)
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', limit)
    }
    return url.toString()
  } catch {
    // Malformed URL — defer to Prisma's own validation
    return base
  }
}

export const db =
  globalForPrisma.prisma ||
  new PrismaClient({
    datasourceUrl: buildDatabaseUrl(),
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
    logger.error(
      `[DB] ${error instanceof Error ? error.message : String(error)}`
    )
    logger.error(
      '[DB] Check that DATABASE_URL is correct and the database is running'
    )
    await db.$disconnect()
    process.exit(1)
  }
}

export default db
