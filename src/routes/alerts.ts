import { Router, Request, Response } from 'express';
import db from '../db';
import { requireAuth, enforceUserAccess } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { sendNotFound } from '../utils/errors';
import {
  createAlertRuleSchema,
  updateAlertRuleSchema,
  alertIdParamSchema,
  alertUserParamSchema,
} from '../validators/alert-validators';

const router = Router();

// All alert routes require auth.
router.use(requireAuth);

// Fields returned to clients. `threshold` is Decimal in the DB; serialize it as
// a string via Prisma's default JSON handling to avoid float precision loss.
const alertSelect = {
  id: true,
  userId: true,
  metric: true,
  protocolName: true,
  comparator: true,
  threshold: true,
  deliveryChannel: true,
  cooldownMinutes: true,
  lastFiredAt: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * POST /api/alerts
 * Create a new alert rule owned by the authenticated user.
 */
router.post(
  '/',
  validate({ body: createAlertRuleSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId;
    const {
      metric,
      protocolName,
      comparator,
      threshold,
      deliveryChannel,
      cooldownMinutes,
    } = req.body;

    const rule = await (db as any).alertRule.create({
      data: {
        userId,
        metric,
        protocolName: protocolName ?? null,
        comparator,
        threshold,
        deliveryChannel,
        cooldownMinutes,
      },
      select: alertSelect,
    });

    return res.status(201).json(rule);
  },
);

/**
 * GET /api/alerts/:userId
 * List all alert rules for the given user. Owner-scoped: a caller may only
 * read their own rules (enforceUserAccess compares :userId to req.auth.userId).
 */
router.get(
  '/:userId',
  validate({ params: alertUserParamSchema }),
  enforceUserAccess,
  async (req: Request, res: Response) => {
    const userId = req.params.userId as string;

    const rules = await (db as any).alertRule.findMany({
      where: { userId },
      select: alertSelect,
      orderBy: { createdAt: 'desc' },
    });

    return res.status(200).json({ rules });
  },
);

/**
 * PATCH /api/alerts/:id
 * Update an alert rule. Ownership is enforced by scoping the lookup to the
 * caller's userId, matching the pattern used by the other :id-keyed resources.
 */
router.patch(
  '/:id',
  validate({ params: alertIdParamSchema, body: updateAlertRuleSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId;

    const existing = await (db as any).alertRule.findFirst({
      where: { id: req.params.id, userId },
      select: { id: true, metric: true, protocolName: true },
    });
    if (!existing) return sendNotFound(res, 'Alert rule');

    // Enforce the PROTOCOL_APY/protocolName pairing against the effective
    // (post-update) state, since a PATCH may change either field alone.
    const nextMetric = req.body.metric ?? existing.metric;
    const nextProtocolName =
      req.body.protocolName !== undefined
        ? req.body.protocolName
        : existing.protocolName;

    if (nextMetric === 'PROTOCOL_APY' && !nextProtocolName) {
      return res.status(400).json({
        error: 'Validation failed',
        details: [
          {
            path: 'protocolName',
            message: 'protocolName is required when metric is PROTOCOL_APY',
          },
        ],
      });
    }
    if (nextMetric !== 'PROTOCOL_APY' && nextProtocolName) {
      return res.status(400).json({
        error: 'Validation failed',
        details: [
          {
            path: 'protocolName',
            message: 'protocolName is only valid when metric is PROTOCOL_APY',
          },
        ],
      });
    }

    const updated = await (db as any).alertRule.update({
      where: { id: req.params.id },
      data: req.body,
      select: alertSelect,
    });

    return res.status(200).json(updated);
  },
);

/**
 * DELETE /api/alerts/:id
 * Delete an alert rule owned by the caller.
 */
router.delete(
  '/:id',
  validate({ params: alertIdParamSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId;

    const existing = await (db as any).alertRule.findFirst({
      where: { id: req.params.id, userId },
      select: { id: true },
    });
    if (!existing) return sendNotFound(res, 'Alert rule');

    await (db as any).alertRule.delete({ where: { id: req.params.id } });

    return res.status(204).send();
  },
);

export default router;
