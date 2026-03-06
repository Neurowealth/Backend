import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { requireAuth } from '../middleware/auth'
import { whatsappFormatters } from '../whatsapp/formatters'
import { logger } from '../utils/logger'
import { Decimal } from '@prisma/client/runtime/library'

const router = Router()

// Validation schema
const depositSchema = z.object({
  userId: z.string().uuid(),
  amount: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, {
    message: 'Amount must be a positive number'
  }),
  assetSymbol: z.string().min(1).max(20),
  protocolName: z.string().min(1).max(100),
  txHash: z.string().min(40).max(140),
  memo: z.string().optional()
})

/**
 * POST /api/deposit
 * Initiate a deposit transaction
 * Returns 409 if duplicate txHash is detected
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId, amount, assetSymbol, protocolName, txHash, memo } = depositSchema.parse(req.body)

    // Verify user can only deposit to their own account
    if (req.userId !== userId) {
      res.status(403).json({ error: 'Forbidden', message: 'Cannot create deposit for other users' })
      return
    }

    const user = await db.user.findUnique({
      where: { id: userId }
    })

    if (!user) {
      res.status(404).json({ error: 'Not Found', message: 'User not found' })
      return
    }

    // Check for duplicate txHash
    const existingTx = await db.transaction.findUnique({
      where: { txHash: txHash }
    })

    if (existingTx) {
      res.status(409).json({
        error: 'Conflict',
        message: 'Transaction with this hash already exists',
        existingTxId: existingTx.id
      })
      return
    }

    // Try to find or create position
    let position = await db.position.findFirst({
      where: {
        userId: userId,
        protocolName: protocolName,
        assetSymbol: assetSymbol,
        status: 'ACTIVE'
      }
    })

    // Create new position if it doesn't exist
    if (!position) {
      position = await db.position.create({
        data: {
          userId: userId,
          protocolName: protocolName,
          assetSymbol: assetSymbol,
          depositedAmount: new Decimal(amount),
          currentValue: new Decimal(amount),
          status: 'ACTIVE'
        }
      })
    } else {
      // Update existing position with new deposit
      position = await db.position.update({
        where: { id: position.id },
        data: {
          depositedAmount: position.depositedAmount.plus(new Decimal(amount)),
          currentValue: position.currentValue.plus(new Decimal(amount))
        }
      })
    }

    // Create deposit transaction
    const transaction = await db.transaction.create({
      data: {
        userId: userId,
        positionId: position.id,
        type: 'DEPOSIT',
        status: 'PENDING',
        assetSymbol: assetSymbol,
        amount: new Decimal(amount),
        network: user.network,
        protocolName: protocolName,
        txHash: txHash,
        memo: memo
      }
    })

    // Log agent action
    await db.agentLog.create({
      data: {
        userId: userId,
        action: 'DEPOSIT',
        status: 'SUCCESS',
        inputData: {
          amount,
          assetSymbol,
          protocolName,
          txHash
        },
        outputData: {
          positionId: position.id,
          transactionId: transaction.id
        }
      }
    })

    const depositData = {
      transactionId: transaction.id,
      positionId: position.id,
      userId: userId,
      type: 'DEPOSIT',
      amount: amount,
      assetSymbol: assetSymbol,
      protocolName: protocolName,
      txHash: txHash,
      status: 'PENDING',
      createdAt: transaction.createdAt.toISOString(),
      whatsappReply: whatsappFormatters.formatDepositConfirmation(amount, assetSymbol, txHash)
    }

    res.status(201).json(depositData)
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation Error',
        message: 'Invalid deposit parameters',
        details: error.issues
      })
      return
    }

    logger.error('Deposit endpoint error', { error, body: req.body })
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
