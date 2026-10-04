/**
 * User settings API (#534).
 *
 * PUT /api/v1/settings — update user preferences (displayCurrency).
 */

import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import { sendError } from '../utils/errors'
import { logger } from '../utils/logger'
import { db } from '../db'
import { isCurrencySupported } from '../utils/fxConvert'
import { z } from 'zod'

const router = Router()

const updateSettingsSchema = z.object({
  displayCurrency: z.string().min(3).max(3).optional(),
})

router.put(
  '/',
  requireAuth,
  validate({ body: updateSettingsSchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response) => {
    try {
      const { displayCurrency } = req.body as { displayCurrency?: string }

      if (displayCurrency && !isCurrencySupported(displayCurrency)) {
        return sendError(res, 400, `Unsupported currency: ${displayCurrency}`)
      }

      const updated = await db.user.update({
        where: { id: req.auth!.userId },
        data: {
          ...(displayCurrency && { displayCurrency }),
        },
      })

      return res.json({
        userId: updated.id,
        displayCurrency: updated.displayCurrency,
      })
    } catch (err) {
      logger.error('[Settings] Update failed', { error: err instanceof Error ? err.message : String(err) })
      return sendError(res, 500, 'Failed to update settings')
    }
  }
)

export default router
