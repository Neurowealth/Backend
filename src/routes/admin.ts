/**
 * Admin Routes - Operational tooling for Stellar event listener and DLQ management
 * Protected by admin authentication middleware and rate limiting
 */

import { Router, Request, Response } from 'express'
import { getEventMetrics } from '../stellar/events'
import { DeadLetterQueue } from '../stellar/dlq'
import { logger } from '../utils/logger'
import { adminRateLimiter } from '../middleware/rateLimiter'

const router = Router()

// Log admin actions for audit trail
function auditLog(req: Request, action: string, details?: Record<string, any>): void {
  logger.info('[Admin Audit]', {
    action,
    ip: req.ip,
    method: req.method,
    path: req.path,
    ...details,
  })
}

/**
 * Admin auth middleware - checks for admin token or internal access
 * In production, this should validate against a proper admin role/permission system
 */
function requireAdminAuth(req: Request, res: Response, next: Function): void {
    const adminToken = req.headers['x-admin-token']
    const expectedToken = process.env.ADMIN_API_TOKEN

    // Allow internal requests (localhost) in development
    const isInternal = req.ip === '127.0.0.1' || req.ip === '::1'
    const isDev = process.env.NODE_ENV !== 'production'

    if (isDev && isInternal) {
        next()
        return
    }

    // Check admin token
    if (!expectedToken || adminToken !== expectedToken) {
        res.status(403).json({
            success: false,
            error: 'Forbidden: Admin access required',
        })
        return
    }

    next()
}

// Apply admin auth and rate limiting to all routes
router.use(adminRateLimiter)
router.use(requireAdminAuth)

/**
 * GET /api/admin/stellar/metrics
 * Returns current event processing metrics
 */
router.get('/stellar/metrics', (req: Request, res: Response) => {
    try {
        const metrics = getEventMetrics()
        auditLog(req, 'GET_STELLAR_METRICS')

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
        auditLog(req, 'GET_STELLAR_METRICS_FAILED', {
            error: error instanceof Error ? error.message : 'Unknown error',
        })
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve metrics',
        })
    }
})

/**
 * GET /api/admin/dlq/inspect
 * Returns current DLQ contents with optional filtering
 * Query params:
 *   - status: PENDING | RETRIED | RESOLVED (optional)
 *   - limit: max items to return (default 50)
 */
router.get('/dlq/inspect', async (req: Request, res: Response) => {
    try {
        const { status, limit = '50' } = req.query
        const maxLimit = Math.min(Number.parseInt(limit as string) || 50, 500)

        const allEvents = await DeadLetterQueue.getAll()

        // Filter by status if provided
        let filtered = allEvents
        if (status && ['PENDING', 'RETRIED', 'RESOLVED'].includes(status as string)) {
            filtered = allEvents.filter(e => e.status === status)
        }

        // Apply limit
        const items = filtered.slice(0, maxLimit)

        auditLog(req, 'INSPECT_DLQ', {
            statusFilter: status,
            totalInQueue: allEvents.length,
            filteredCount: filtered.length,
            returnedCount: items.length,
        })

        res.status(200).json({
            success: true,
            data: {
                totalInQueue: allEvents.length,
                filteredCount: filtered.length,
                returnedCount: items.length,
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
        auditLog(req, 'INSPECT_DLQ_FAILED', {
            error: error instanceof Error ? error.message : 'Unknown error',
        })
        res.status(500).json({
            success: false,
            error: 'Failed to inspect DLQ',
        })
    }
})

/**
 * POST /api/admin/dlq/retry
 * Manually retry all pending DLQ events
 * Body: { dryRun?: boolean }
 */
router.post('/dlq/retry', async (req: Request, res: Response) => {
    try {
        const { dryRun = false } = req.body

        if (dryRun) {
            // Just report what would be retried
            const events = await DeadLetterQueue.getAll()
            const pending = events.filter(e => e.status === 'PENDING' || e.status === 'RETRIED')

            auditLog(req, 'DLQ_RETRY_DRY_RUN', {
                wouldRetry: pending.length,
            })

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

        // Perform actual retry
        logger.info('[Admin] Starting DLQ retry operation')
        auditLog(req, 'DLQ_RETRY_START')

        // Import the retry function from events module
        const { retryDeadLetterEvents } = await import('../stellar/events')
        await retryDeadLetterEvents()

        const result = await DeadLetterQueue.getAll()
        const resolved = result.filter(e => e.status === 'RESOLVED').length
        const failed = result.filter(e => e.status === 'RETRIED').length

        logger.info('[Admin] DLQ retry completed', { resolved, failed })
        auditLog(req, 'DLQ_RETRY_COMPLETED', { resolved, failed, totalRemaining: result.length })

        res.status(200).json({
            success: true,
            data: {
                resolved,
                failed,
                totalRemaining: result.length,
            },
            timestamp: new Date().toISOString(),
        })
    } catch (error) {
        logger.error('[Admin] DLQ retry failed', {
            error: error instanceof Error ? error.message : 'Unknown error',
        })
        auditLog(req, 'DLQ_RETRY_FAILED', {
            error: error instanceof Error ? error.message : 'Unknown error',
        })
        res.status(500).json({
            success: false,
            error: 'DLQ retry operation failed',
        })
    }
})

/**
 * POST /api/admin/dlq/resolve
 * Manually mark a specific DLQ event as resolved
 * Body: { eventId: string }
 */
router.post('/dlq/resolve', async (req: Request, res: Response) => {
    try {
        const { eventId } = req.body

        if (!eventId || typeof eventId !== 'string') {
            auditLog(req, 'DLQ_RESOLVE_INVALID', {
                error: 'Missing or invalid eventId',
            })
            return res.status(400).json({
                success: false,
                error: 'eventId is required and must be a string',
            })
        }

        const resolved = await DeadLetterQueue.resolve(eventId)

        if (!resolved) {
            auditLog(req, 'DLQ_RESOLVE_NOT_FOUND', { eventId })
            return res.status(404).json({
                success: false,
                error: `Event ${eventId} not found in DLQ`,
            })
        }

        logger.info('[Admin] Event manually resolved', { eventId })
        auditLog(req, 'DLQ_RESOLVE_SUCCESS', { eventId })

        res.status(200).json({
            success: true,
            data: {
                eventId,
                status: 'RESOLVED',
            },
            timestamp: new Date().toISOString(),
        })
    } catch (error) {
        logger.error('[Admin] Failed to resolve DLQ event', {
            error: error instanceof Error ? error.message : 'Unknown error',
        })
        auditLog(req, 'DLQ_RESOLVE_FAILED', {
            error: error instanceof Error ? error.message : 'Unknown error',
        })
        res.status(500).json({
            success: false,
            error: 'Failed to resolve event',
        })
    }
})

/**
 * POST /api/admin/stellar/backfill
 * Manually trigger event backfill for a ledger range
 * Body: { startLedger: number, endLedger?: number }
 */
router.post('/stellar/backfill', async (req: Request, res: Response) => {
    try {
        const { startLedger, endLedger } = req.body

        if (!startLedger || typeof startLedger !== 'number' || startLedger < 0) {
            auditLog(req, 'STELLAR_BACKFILL_INVALID', {
                error: 'Invalid startLedger',
            })
            return res.status(400).json({
                success: false,
                error: 'startLedger is required and must be a non-negative number',
            })
        }

        if (endLedger && (typeof endLedger !== 'number' || endLedger < startLedger)) {
            auditLog(req, 'STELLAR_BACKFILL_INVALID', {
                error: 'Invalid endLedger',
            })
            return res.status(400).json({
                success: false,
                error: 'endLedger must be a number >= startLedger',
            })
        }

        logger.info('[Admin] Starting manual backfill', { startLedger, endLedger })
        auditLog(req, 'STELLAR_BACKFILL_START', { startLedger, endLedger })

        // Import backfill function from events module
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
        auditLog(req, 'STELLAR_BACKFILL_FAILED', {
            error: error instanceof Error ? error.message : 'Unknown error',
        })
        res.status(500).json({
            success: false,
            error: 'Backfill operation failed',
        })
    }
})

export default router
