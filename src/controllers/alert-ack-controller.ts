import { Request, Response } from 'express'
import db from '../db'
import { logger } from '../utils/logger'
import { publishUserEvent } from '../events/publisher'
import { verifyAckToken } from '../utils/ackToken'

export const ALERT_MAX_SNOOZE_DAYS = 30

export async function snoozeAlertRule(
  req: Request,
  res: Response
): Promise<void> {
  const userId = (req as any).user?.id || (req as any).userId
  const { id } = req.params
  const { durationMinutes, until, reason } = req.body

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  try {
    const rule = await db.alertRule.findFirst({ where: { id, userId } })
    if (!rule) {
      res.status(404).json({ error: 'Alert rule not found' })
      return
    }

    let snoozedUntilDate: Date
    const maxSnoozeMs = ALERT_MAX_SNOOZE_DAYS * 24 * 60 * 60 * 1000
    const maxAllowedDate = new Date(Date.now() + maxSnoozeMs)

    if (until) {
      snoozedUntilDate = new Date(until)
    } else if (durationMinutes && typeof durationMinutes === 'number') {
      snoozedUntilDate = new Date(Date.now() + durationMinutes * 60 * 1000)
    } else {
      res
        .status(400)
        .json({ error: 'Must provide durationMinutes or until date' })
      return
    }

    if (isNaN(snoozedUntilDate.getTime())) {
      res.status(400).json({ error: 'Invalid date provided for snooze' })
      return
    }

    if (snoozedUntilDate > maxAllowedDate) {
      snoozedUntilDate = maxAllowedDate
    }

    const updated = await db.alertRule.update({
      where: { id },
      data: {
        snoozedUntil: snoozedUntilDate,
        snoozeReason: reason || 'User requested snooze',
      },
    })

    await publishUserEvent(userId, 'alerts', 'alert_rule.snoozed' as any, {
      ruleId: id,
      snoozedUntil: snoozedUntilDate.toISOString(),
      reason: updated.snoozeReason,
    })

    res.json({
      success: true,
      ruleId: id,
      snoozedUntil: updated.snoozedUntil,
      snoozeReason: updated.snoozeReason,
    })
  } catch (err: any) {
    logger.error('[AlertAckController] Failed to snooze alert rule', {
      error: err.message,
    })
    res.status(500).json({ error: 'Failed to snooze alert rule' })
  }
}

export async function acknowledgeAlert(
  req: Request,
  res: Response
): Promise<void> {
  const userId = (req as any).user?.id || (req as any).userId
  const { id } = req.params
  const { fireId, note, ackToken, source = 'API' } = req.body

  let targetUserId = userId
  let targetRuleId = id
  let targetFireId = fireId

  // Handle token-based ack (e.g. from WhatsApp/Telegram reply button)
  if (ackToken) {
    const verifiedToken = verifyAckToken(ackToken)
    if (verifiedToken) {
      targetUserId = verifiedToken.userId
      targetRuleId = verifiedToken.ruleId
      targetFireId = verifiedToken.fireId
    }
  }

  if (!targetUserId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  try {
    const rule = await db.alertRule.findFirst({
      where: { id: targetRuleId, userId: targetUserId },
    })
    if (!rule) {
      res.status(404).json({ error: 'Alert rule not found' })
      return
    }

    // Create AlertAck record
    const ack = await db.alertAck.create({
      data: {
        ruleId: targetRuleId,
        userId: targetUserId,
        fireId: targetFireId || undefined,
        source,
        note: note || undefined,
      },
    })

    // Update unacked AlertFire records for this rule to set ackId
    if (targetFireId) {
      await db.alertFire.updateMany({
        where: { id: targetFireId, ruleId: targetRuleId },
        data: { ackId: ack.id },
      })
    } else {
      await db.alertFire.updateMany({
        where: { ruleId: targetRuleId, ackId: null },
        data: { ackId: ack.id },
      })
    }

    await publishUserEvent(
      targetUserId,
      'alerts',
      'alert_rule.acknowledged' as any,
      {
        ruleId: targetRuleId,
        fireId: targetFireId,
        ackId: ack.id,
        acknowledgedAt: ack.createdAt.toISOString(),
      }
    )

    res.json({
      success: true,
      ackId: ack.id,
      ruleId: targetRuleId,
      fireId: targetFireId,
      acknowledgedAt: ack.createdAt,
    })
  } catch (err: any) {
    logger.error('[AlertAckController] Failed to acknowledge alert', {
      error: err.message,
    })
    res.status(500).json({ error: 'Failed to acknowledge alert' })
  }
}

export async function listAlertFires(
  req: Request,
  res: Response
): Promise<void> {
  const userId = (req as any).user?.id || (req as any).userId
  const { id } = req.params
  const limit = parseInt((req.query.limit as string) || '20', 10)
  const page = parseInt((req.query.page as string) || '1', 10)
  const skip = (page - 1) * limit

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  try {
    const rule = await db.alertRule.findFirst({ where: { id, userId } })
    if (!rule) {
      res.status(404).json({ error: 'Alert rule not found' })
      return
    }

    const [fires, totalCount] = await Promise.all([
      db.alertFire.findMany({
        where: { ruleId: id },
        orderBy: { firedAt: 'desc' },
        skip,
        take: limit,
      }),
      db.alertFire.count({ where: { ruleId: id } }),
    ])

    res.json({
      fires,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    })
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list alert fires' })
  }
}
