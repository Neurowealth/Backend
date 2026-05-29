/**
 * smoke-test.ts — Minimal connectivity and schema smoke test.
 *
 * Connects to the database specified by DATABASE_URL, runs a handful of
 * cheap read queries across core models, and exits 0 on success or 1 on
 * any error.  Used by the `migration-smoke` CI job (issue #100) to gate
 * deployments.
 *
 * Run with:  npm run smoke
 */

import { PrismaClient } from '@prisma/client'

async function main(): Promise<void> {
  const prisma = new PrismaClient()

  try {
    await prisma.$connect()
    console.log('[smoke] ✓ DB connection established')

    const [userCount, sessionCount, cursorCount, eventCount, dlqCount] = await Promise.all([
      prisma.user.count(),
      prisma.session.count(),
      prisma.eventCursor.count(),
      prisma.processedEvent.count(),
      prisma.deadLetterEvent.count(),
    ])

    console.log('[smoke] ✓ Core table counts:', {
      users: userCount,
      sessions: sessionCount,
      eventCursors: cursorCount,
      processedEvents: eventCount,
      deadLetterEvents: dlqCount,
    })

    console.log('[smoke] ✓ All smoke checks passed')
  } catch (err) {
    console.error('[smoke] ✗ Smoke test FAILED:', err instanceof Error ? err.message : err)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

main()
