import { Router } from 'express'
import {
  requireAdminAuth,
  requireAdminScope,
} from '../middleware/adminAuth'
import {
  listDeadOutboundNotifications,
  retryDeadOutboundNotification,
} from '../services/outboundNotifications'
import { logger } from '../utils/logger'

const router = Router()

router.get(
  '/',
  requireAdminAuth,
  requireAdminScope('dlq:read'),
  async (_req, res) => {
  try {
    const items = await listDeadOutboundNotifications()
    res.status(200).json({ items, count: items.length })
  } catch (error) {
    logger.error('[Admin] Failed to inspect outbound notification DLQ', {
      error: error instanceof Error ? error.message : String(error),
    })
    res.status(500).json({ error: 'Failed to inspect notification queue' })
  }
  }
)

router.post(
  '/:id/retry',
  requireAdminAuth,
  requireAdminScope('dlq:write'),
  async (req, res) => {
    try {
      const retried = await retryDeadOutboundNotification(req.params.id)
      if (!retried) {
        res.status(404).json({ error: 'Dead-letter notification not found' })
        return
      }
      res.status(202).json({ id: req.params.id, status: 'PENDING' })
    } catch (error) {
      logger.error('[Admin] Failed to retry outbound notification', {
        notificationId: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      })
      res.status(500).json({ error: 'Failed to retry notification' })
    }
  }
)

export default router