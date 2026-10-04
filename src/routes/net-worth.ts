import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/authenticate'
import { requireScope } from '../middleware/apiKeyAuth'
import { validate } from '../middleware/validate'
import { logger } from '../utils/logger'
import { sendError, sendNotFound } from '../utils/errors'
import {
  ExternalWalletConflictError,
  ExternalWalletValidationError,
  linkExternalWallet,
  listExternalWallets,
  removeExternalWallet,
} from '../externalWallets/service'
import {
  EXTERNAL_WALLET_STALE_AFTER_MS,
  getNetWorth,
} from '../netWorth/service'

const router = Router()
const createExternalWalletSchema = z.object({
  publicKey: z.string().min(1),
  label: z.string().trim().min(1).max(60),
})
const walletIdSchema = z.object({ id: z.string().uuid() })

router.use(requireAuth)

router.get('/', async (req: Request, res: Response) => {
  try {
    return res.status(200).json(await getNetWorth(req.auth!.userId))
  } catch (error) {
    logger.error('[NetWorth] Failed to aggregate holdings', {
      error: error instanceof Error ? error.message : String(error),
    })
    return sendError(res, 500, 'Failed to retrieve net worth')
  }
})

router.get('/external-wallets', async (req: Request, res: Response) => {
  try {
    const wallets = await listExternalWallets(req.auth!.userId)
    return res.status(200).json({
      wallets: wallets.map((wallet) => ({
        id: wallet.id,
        publicKey: wallet.publicKey,
        label: wallet.label,
        verificationStatus: wallet.verificationStatus,
        verified: false,
        addedAt: wallet.addedAt,
        lastSyncedAt: wallet.lastSyncedAt,
        stale:
          !wallet.lastSyncedAt ||
          Boolean(wallet.syncError) ||
          Boolean(
            wallet.lastSyncAttemptAt &&
            wallet.lastSyncedAt &&
            wallet.lastSyncAttemptAt > wallet.lastSyncedAt
          ) ||
          Date.now() - wallet.lastSyncedAt.getTime() >
            EXTERNAL_WALLET_STALE_AFTER_MS,
      })),
    })
  } catch (error) {
    logger.error('[NetWorth] Failed to list external wallets', {
      error: error instanceof Error ? error.message : String(error),
    })
    return sendError(res, 500, 'Failed to list external wallets')
  }
})

router.post(
  '/external-wallets',
  requireScope('portfolio:write'),
  validate({ body: createExternalWalletSchema }),
  async (req: Request, res: Response) => {
    try {
      const wallet = await linkExternalWallet(req.auth!.userId, req.body)
      return res.status(201).json({
        id: wallet.id,
        publicKey: wallet.publicKey,
        label: wallet.label,
        verificationStatus: wallet.verificationStatus,
        verified: false,
        notice:
          'Unverified self-reported address. It is read-only and only appears in your private net-worth view.',
      })
    } catch (error) {
      if (error instanceof ExternalWalletConflictError) {
        return sendError(res, 409, error.message)
      }
      if (error instanceof ExternalWalletValidationError) {
        return sendError(res, 400, error.message)
      }
      logger.error('[NetWorth] Failed to link external wallet', {
        error: error instanceof Error ? error.message : String(error),
      })
      return sendError(res, 500, 'Failed to link external wallet')
    }
  }
)

router.delete(
  '/external-wallets/:id',
  requireScope('portfolio:write'),
  validate({ params: walletIdSchema }),
  async (req: Request, res: Response) => {
    try {
      const removed = await removeExternalWallet(
        req.auth!.userId,
        req.params.id
      )
      if (!removed) return sendNotFound(res, 'External wallet')
      return res.status(204).send()
    } catch (error) {
      logger.error('[NetWorth] Failed to remove external wallet', {
        error: error instanceof Error ? error.message : String(error),
      })
      return sendError(res, 500, 'Failed to remove external wallet')
    }
  }
)

export default router
