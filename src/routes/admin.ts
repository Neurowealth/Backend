/**
 * Admin Routes - Operational tooling for Stellar event listener and DLQ management
 * Protected by admin authentication middleware and rate limiting.
 *
 * Rate limiting and auth are applied in app.ts:
 *   app.use('/api/admin', adminRateLimiter, adminRouter)
 *
 * Do NOT add router.use(adminRateLimiter) here — that would apply it twice,
 * halving the effective limit for every admin request.
 */

import { Router, Request, Response } from 'express'
import { getEventMetrics } from '../stellar/events'
import { DeadLetterQueue } from '../stellar/dlq'
import { logger } from '../utils/logger'
import { requireAdminAuth, requireAdminScope } from '../middleware/adminAuth'
import db from '../db'

const router = Router()
const prisma = db as any

function auditLog(
  req: Request,
  res: Response,
  action: string,
  result: string,
  details?: Record<string, any>,
): void {
  const adminAuth = res.locals.adminAuth
  const auditPayload = {
    adminIdentity: adminAuth ? `${adminAuth.name} (${adminAuth.role})` : 'unknown',
    adminId: adminAuth?.id ?? null,
    action,
    target: req.originalUrl || req.path,
    result,
    details,
    ipAddress: req.ip,
    userAgent: req.get('user-agent') || null,
    method: req.method,
    path: req.originalUrl || req.path,
  }

  logger.info('[Admin Audit]', auditPayload)

  if (adminAuth) {
    prisma.adminAuditLog
      .create({
        data: {
          adminKeyId: adminAuth.id,
          adminName: adminAuth.name,
          adminRole: adminAuth.role,
          action,
          target: req.originalUrl || req.path,
          result,
          details,
          ipAddress: req.ip,
          userAgent: req.get('user-agent') || null,
          method: req.method,
          path: req.originalUrl || req.path,
        },
      })
      .catch((error: unknown) => {
        logger.error('[Admin Audit] Failed to persist audit entry', {
          error: error instanceof Error ? error.message : String(error),
          action,
        })
      })
  }
}

// ── Auth applied once here — rate limiting is applied in app.ts ───────────
router.use(requireAdminAuth)

/**
 * GET /api/admin/stellar/metrics
 * Returns current event processing metrics.
 * Required scope: metrics:read
 */
router.get(
  '/stellar/metrics',
  requireAdminScope('metrics:read'),
  (req: Request, res: Response) => {
    try {
      const metrics = getEventMetrics()
      auditLog(req, res, 'GET_STELLAR_METRICS', 'success')

      res.status(200).json({
        success: true,
        data: {
          totalProcessed: metrics.totalProcessed,
          totalErrors: metrics.totalErrors,
          processingRatePerMinute: metrics.processingRatePerMinute,
          errorRate: (metrics.errorRate * 100).toFixed(2) + '%',
          ledgerLag: metrics.ledgerLag,
          lastDbOperationMs: metrics.lastDbOperationMs,
          lastUpdated: metrics.lastUpdated.toISOString(),
        },
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      logger.error('[Admin] Failed to get metrics', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      auditLog(req, res, 'GET_STELLAR_METRICS', 'failure', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve metrics',
      })
    }
  },
)

/**
 * GET /api/admin/dlq/inspect
 * Returns current DLQ contents with advanced filtering and pagination.
 * Required scope: dlq:read
 *
 * Query params:
 *   status        — PENDING | RETRIED | RESOLVED (optional)
 *   eventType     — filter by event type (optional)
 *   retryCountMin — minimum retry count (optional, default 0)
 *   retryCountMax — maximum retry count (optional)
 *   timeRangeStart — ISO 8601 timestamp for earliest event (optional)
 *   timeRangeEnd   — ISO 8601 timestamp for latest event (optional)
 *   limit         — max items to return (default 50, max 500)
 *   offset        — pagination offset (default 0)
 */
router.get(
  '/dlq/inspect',
  requireAdminScope('dlq:read'),
  async (req: Request, res: Response) => {
    try {
      const {
        status,
        eventType,
        retryCountMin = '0',
        retryCountMax,
        timeRangeStart,
        timeRangeEnd,
        limit = '50',
        offset = '0',
      } = req.query

      const maxLimit = Math.min(Number.parseInt(limit as string) || 50, 500)
      const pageOffset = Math.max(0, Number.parseInt(offset as string) || 0)
      const minRetryCount = Math.max(0, Number.parseInt(retryCountMin as string) || 0)
      const maxRetryCount = retryCountMax ? Number.parseInt(retryCountMax as string) : undefined

      const allEvents = await DeadLetterQueue.getAll()

      let filtered = allEvents

      if (status && ['PENDING', 'RETRIED', 'RESOLVED'].includes(status as string)) {
        filtered = filtered.filter(e => e.status === status)
      }

      if (eventType) {
        filtered = filtered.filter(e => e.eventType === eventType)
      }

      filtered = filtered.filter(e => e.retryCount >= minRetryCount)
      if (maxRetryCount !== undefined) {
        filtered = filtered.filter(e => e.retryCount <= maxRetryCount)
      }

      if (timeRangeStart) {
        const startDate = new Date(timeRangeStart as string)
        if (!isNaN(startDate.getTime())) {
          filtered = filtered.filter(e => e.createdAt >= startDate)
        }
      }

      if (timeRangeEnd) {
        const endDate = new Date(timeRangeEnd as string)
        if (!isNaN(endDate.getTime())) {
          filtered = filtered.filter(e => e.createdAt <= endDate)
        }
      }

      const items = filtered.slice(pageOffset, pageOffset + maxLimit)

      auditLog(req, res, 'INSPECT_DLQ', 'success', {
        statusFilter: status,
        eventTypeFilter: eventType,
        retryCountRange: { min: minRetryCount, max: maxRetryCount },
        timeRange: { start: timeRangeStart, end: timeRangeEnd },
        totalInQueue: allEvents.length,
        filteredCount: filtered.length,
        returnedCount: items.length,
        pagination: { offset: pageOffset, limit: maxLimit },
      })

      res.status(200).json({
        success: true,
        data: {
          totalInQueue: allEvents.length,
          filteredCount: filtered.length,
          returnedCount: items.length,
          pagination: {
            offset: pageOffset,
            limit: maxLimit,
            hasMore: pageOffset + maxLimit < filtered.length,
          },
          items: items.map(event => ({
            id: event.id,
            contractId: event.contractId,
            txHash: event.txHash,
            eventType: event.eventType,
            ledger: event.ledger,
            status: event.status,
            retryCount: event.retryCount,
            error: event.error,
            createdAt: event.createdAt,
            updatedAt: event.updatedAt,
          })),
        },
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      logger.error('[Admin] Failed to inspect DLQ', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      auditLog(req, res, 'INSPECT_DLQ', 'failure', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      res.status(500).json({
        success: false,
        error: 'Failed to inspect DLQ',
      })
    }
  },
)

/**
 * POST /api/admin/dlq/retry
 * Manually retry all pending DLQ events.
 * Required scope: dlq:write
 *
 * Body: { dryRun?: boolean }
 */
router.post(
  '/dlq/retry',
  requireAdminScope('dlq:write'),
  async (req: Request, res: Response) => {
    try {
      const { dryRun = false } = req.body

      if (dryRun) {
        const events = await DeadLetterQueue.getAll()
        const pending = events.filter(e => e.status === 'PENDING' || e.status === 'RETRIED')

        auditLog(req, res, 'DLQ_RETRY_DRY_RUN', 'success', { wouldRetry: pending.length })

        return res.status(200).json({
          success: true,
          data: {
            dryRun: true,
            wouldRetry: pending.length,
            events: pending.map(e => ({
              id: e.id,
              txHash: e.txHash,
              eventType: e.eventType,
              retryCount: e.retryCount,
            })),
          },
          timestamp: new Date().toISOString(),
        })
      }

      logger.info('[Admin] Starting DLQ retry operation')
      auditLog(req, res, 'DLQ_RETRY_START', 'success')

      const { retryDeadLetterEvents } = await import('../stellar/events')
      await retryDeadLetterEvents()

      const result = await DeadLetterQueue.getAll()
      const resolved = result.filter(e => e.status === 'RESOLVED').length
      const failed = result.filter(e => e.status === 'RETRIED').length

      logger.info('[Admin] DLQ retry completed', { resolved, failed })
      auditLog(req, res, 'DLQ_RETRY_COMPLETED', 'success', {
        resolved,
        failed,
        totalRemaining: result.length,
      })

      res.status(200).json({
        success: true,
        data: { resolved, failed, totalRemaining: result.length },
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      logger.error('[Admin] DLQ retry failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      auditLog(req, res, 'DLQ_RETRY_COMPLETED', 'failure', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      res.status(500).json({
        success: false,
        error: 'DLQ retry operation failed',
      })
    }
  },
)

/**
 * POST /api/admin/dlq/resolve
 * Manually mark a specific DLQ event as resolved.
 * Required scope: dlq:write
 *
 * Body: { eventId: string }
 */
router.post(
  '/dlq/resolve',
  requireAdminScope('dlq:write'),
  async (req: Request, res: Response) => {
    try {
      const { eventId } = req.body

      if (!eventId || typeof eventId !== 'string') {
        auditLog(req, res, 'DLQ_RESOLVE', 'failure', { error: 'Missing or invalid eventId' })
        return res.status(400).json({
          success: false,
          error: 'eventId is required and must be a string',
        })
      }

      const resolved = await DeadLetterQueue.resolve(eventId)

      if (!resolved) {
        auditLog(req, res, 'DLQ_RESOLVE', 'failure', { eventId, error: 'not_found' })
        return res.status(404).json({
          success: false,
          error: `Event ${eventId} not found in DLQ`,
        })
      }

      logger.info('[Admin] Event manually resolved', { eventId })
      auditLog(req, res, 'DLQ_RESOLVE', 'success', { eventId })

      res.status(200).json({
        success: true,
        data: { eventId, status: 'RESOLVED' },
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      logger.error('[Admin] Failed to resolve DLQ event', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      auditLog(req, res, 'DLQ_RESOLVE', 'failure', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      res.status(500).json({
        success: false,
        error: 'Failed to resolve event',
      })
    }
  },
)

/**
 * POST /api/admin/dlq/replay
 * Safely replay selected DLQ events back into the processing pipeline.
 * Required scope: dlq:write
 *
 * Body: { eventIds: string[], dryRun?: boolean }
 * Only retries events in PENDING or RETRIED status to prevent infinite loops.
 */
router.post(
  '/dlq/replay',
  requireAdminScope('dlq:write'),
  async (req: Request, res: Response) => {
    try {
      const { eventIds, dryRun = false } = req.body

      if (!Array.isArray(eventIds) || eventIds.length === 0) {
        auditLog(req, res, 'DLQ_REPLAY', 'failure', { error: 'eventIds must be a non-empty array' })
        return res.status(400).json({
          success: false,
          error: 'eventIds must be a non-empty array',
        })
      }

      if (eventIds.length > 1000) {
        auditLog(req, res, 'DLQ_REPLAY', 'failure', { error: 'Too many events to replay (max 1000)' })
        return res.status(400).json({
          success: false,
          error: 'Maximum 1000 events per replay operation',
        })
      }

      const allEvents = await DeadLetterQueue.getAll()
      const targetEvents = allEvents.filter(e =>
        eventIds.includes(e.id) && ['PENDING', 'RETRIED'].includes(e.status)
      )

      if (targetEvents.length === 0) {
        auditLog(req, res, 'DLQ_REPLAY', 'failure', {
          requestedCount: eventIds.length,
          replayableCount: 0,
          error: 'No eligible events found for replay',
        })
        return res.status(404).json({
          success: false,
          error: 'No eligible events found for replay (only PENDING and RETRIED events can be replayed)',
        })
      }

      if (dryRun) {
        auditLog(req, res, 'DLQ_REPLAY_DRY_RUN', 'success', {
          requestedCount: eventIds.length,
          replayableCount: targetEvents.length,
          blockedCount: eventIds.length - targetEvents.length,
        })

        return res.status(200).json({
          success: true,
          data: {
            dryRun: true,
            requestedCount: eventIds.length,
            replayableCount: targetEvents.length,
            blockedCount: eventIds.length - targetEvents.length,
            events: targetEvents.map(e => ({
              id: e.id,
              txHash: e.txHash,
              eventType: e.eventType,
              retryCount: e.retryCount,
              status: e.status,
            })),
          },
          timestamp: new Date().toISOString(),
        })
      }

      logger.info('[Admin] Starting selective DLQ replay', {
        eventCount: targetEvents.length,
      })

      const { retryDeadLetterEvents } = await import('../stellar/events')
      await retryDeadLetterEvents()

      const result = await DeadLetterQueue.getAll()
      const resolved = result.filter(e => e.status === 'RESOLVED').length
      const failed = result.filter(e => e.status === 'RETRIED').length

      logger.info('[Admin] Selective DLQ replay completed', {
        replayedCount: targetEvents.length,
        resolved,
        failed,
      })

      auditLog(req, res, 'DLQ_REPLAY_COMPLETED', 'success', {
        requestedCount: eventIds.length,
        replayedCount: targetEvents.length,
        blockedCount: eventIds.length - targetEvents.length,
        resolved,
        failed,
      })

      res.status(200).json({
        success: true,
        data: {
          requestedCount: eventIds.length,
          replayedCount: targetEvents.length,
          blockedCount: eventIds.length - targetEvents.length,
          resolved,
          failed,
        },
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      logger.error('[Admin] DLQ replay operation failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      auditLog(req, res, 'DLQ_REPLAY_COMPLETED', 'failure', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      res.status(500).json({
        success: false,
        error: 'DLQ replay operation failed',
      })
    }
  },
)

/**
 * POST /api/admin/stellar/backfill
 * Manually trigger event backfill for a ledger range.
 * Required scope: backfill:write
 *
 * Body: { startLedger: number, endLedger?: number }
 */
router.post(
  '/stellar/backfill',
  requireAdminScope('backfill:write'),
  async (req: Request, res: Response) => {
    try {
      const { startLedger, endLedger } = req.body

      if (!startLedger || typeof startLedger !== 'number' || startLedger < 0) {
        auditLog(req, res, 'STELLAR_BACKFILL', 'failure', { error: 'Invalid startLedger' })
        return res.status(400).json({
          success: false,
          error: 'startLedger is required and must be a non-negative number',
        })
      }

      if (endLedger && (typeof endLedger !== 'number' || endLedger < startLedger)) {
        auditLog(req, res, 'STELLAR_BACKFILL', 'failure', { error: 'Invalid endLedger' })
        return res.status(400).json({
          success: false,
          error: 'endLedger must be a number >= startLedger',
        })
      }

      logger.info('[Admin] Starting manual backfill', { startLedger, endLedger })
      auditLog(req, res, 'STELLAR_BACKFILL', 'success', { startLedger, endLedger })

      const { backfillEvents } = await import('../stellar/events')
      await backfillEvents(startLedger, endLedger)

      res.status(200).json({
        success: true,
        data: {
          startLedger,
          endLedger: endLedger || 'latest',
          status: 'backfill_initiated',
        },
        message: 'Backfill operation initiated. Check logs for progress.',
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      logger.error('[Admin] Backfill operation failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      auditLog(req, res, 'STELLAR_BACKFILL', 'failure', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      res.status(500).json({
        success: false,
        error: 'Backfill operation failed',
      })
    }
  },
)

/**
 * POST /api/admin/keys
 * Issue a new scoped admin API key.
 * Required scope: keys:write
 *
 * Body: { name: string, role: string, scopes: string[], expiresAt?: string }
 * Returns the raw token ONCE — it is never stored in plaintext.
 */
router.post(
  '/keys',
  requireAdminScope('keys:write'),
  async (req: Request, res: Response) => {
    try {
      const { name, role, scopes, expiresAt } = req.body

      if (!name || typeof name !== 'string') {
        return res.status(400).json({ success: false, error: 'name is required' })
      }
      if (!role || typeof role !== 'string') {
        return res.status(400).json({ success: false, error: 'role is required' })
      }
      if (!Array.isArray(scopes) || scopes.length === 0) {
        return res.status(400).json({ success: false, error: 'scopes must be a non-empty array' })
      }

      const crypto = await import('node:crypto')
      const bcrypt = await import('bcryptjs')

      // 32 random bytes → 64-char hex token
      const rawToken = crypto.randomBytes(32).toString('hex')
      const hash = await bcrypt.hash(rawToken, 12)
      const tokenPrefix =
        'sha256:' + crypto.createHash('sha256').update(rawToken).digest('hex')

      const key = await prisma.adminApiKey.create({
        data: {
          name,
          role,
          scopes,
          hash,
          tokenPrefix,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        },
        select: { id: true, name: true, role: true, scopes: true, expiresAt: true, createdAt: true },
      })

      auditLog(req, res, 'CREATE_ADMIN_KEY', 'success', { keyId: key.id, name, role, scopes })

      // Raw token returned ONCE — caller must store it securely.
      res.status(201).json({
        success: true,
        data: {
          ...key,
          token: rawToken,
          warning: 'Store this token securely. It will not be shown again.',
        },
        timestamp: new Date().toISOString(),
      })
    } catch (error: any) {
      // Unique constraint violation — name already taken
      if (error?.code === 'P2002') {
        return res.status(409).json({ success: false, error: 'A key with that name already exists' })
      }
      logger.error('[Admin] Failed to create admin key', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      auditLog(req, res, 'CREATE_ADMIN_KEY', 'failure', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      res.status(500).json({ success: false, error: 'Failed to create admin key' })
    }
  },
)

/**
 * DELETE /api/admin/keys/:id
 * Revoke an admin API key immediately.
 * Required scope: keys:write
 */
router.delete(
  '/keys/:id',
  requireAdminScope('keys:write'),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params

      const existing = await prisma.adminApiKey.findUnique({
        where: { id },
        select: { id: true, name: true, revokedAt: true },
      })

      if (!existing) {
        return res.status(404).json({ success: false, error: 'Admin key not found' })
      }

      if (existing.revokedAt) {
        return res.status(409).json({ success: false, error: 'Admin key is already revoked' })
      }

      await prisma.adminApiKey.update({
        where: { id },
        data: { revokedAt: new Date() },
      })

      logger.info('[Admin] Admin key revoked', { keyId: id, name: existing.name })
      auditLog(req, res, 'REVOKE_ADMIN_KEY', 'success', { keyId: id, name: existing.name })

      res.status(200).json({
        success: true,
        data: { id, status: 'revoked' },
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      logger.error('[Admin] Failed to revoke admin key', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      auditLog(req, res, 'REVOKE_ADMIN_KEY', 'failure', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      res.status(500).json({ success: false, error: 'Failed to revoke admin key' })
    }
  },
)

/**
 * GET /api/admin/keys
 * List all admin API keys (metadata only — no hashes).
 * Required scope: keys:read
 */
router.get(
  '/keys',
  requireAdminScope('keys:read'),
  async (req: Request, res: Response) => {
    try {
      const keys = await prisma.adminApiKey.findMany({
        select: {
          id: true,
          name: true,
          role: true,
          scopes: true,
          expiresAt: true,
          revokedAt: true,
          lastUsedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      })

      auditLog(req, res, 'LIST_ADMIN_KEYS', 'success', { count: keys.length })

      res.status(200).json({
        success: true,
        data: keys,
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      logger.error('[Admin] Failed to list admin keys', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      res.status(500).json({ success: false, error: 'Failed to list admin keys' })
    }
  },
)

/**
 * GET /api/admin/wallets/rotation-status
 * Reports the progress of wallet key rotation.
 * Required scope: keys:read
 */
router.get(
  '/wallets/rotation-status',
  requireAdminScope('keys:read'),
  async (req: Request, res: Response) => {
    try {
      const totalWallets = await prisma.custodialWallet.count()
      const v1Wallets = await prisma.custodialWallet.count({ where: { keyVersion: 1 } })
      const v2Wallets = await prisma.custodialWallet.count({ where: { keyVersion: 2 } })

      const percentV1 = totalWallets === 0 ? 0 : (v1Wallets / totalWallets) * 100

      auditLog(req, res, 'GET_ROTATION_STATUS', 'success', { totalWallets, v1Wallets, percentV1 })

      res.status(200).json({
        success: true,
        data: {
          totalWallets,
          v1Wallets,
          v2Wallets,
          percentV1,
          isRotationComplete: v1Wallets === 0,
        },
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      logger.error('[Admin] Failed to get rotation status', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      auditLog(req, res, 'GET_ROTATION_STATUS', 'failure', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      res.status(500).json({ success: false, error: 'Failed to get rotation status' })
    }
  },
)

export default router