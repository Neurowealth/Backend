import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { requireAuth } from '../middleware/auth'
import { whatsappFormatters } from '../whatsapp/formatters'
import { logger } from '../utils/logger'
import { Decimal } from '@prisma/client/runtime/library'

const router = Router()

// Validation schema
const withdrawSchema = z.object({
  userId: z.string().uuid(),
  positionId: z.string().uuid(),
  amount: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, {
    message: 'Amount must be a positive number'
  }),
  assetSymbol: z.string().min(1).max(20),
  txHash: z.string().min(40).max(140),
  memo: z.string().optional()
})

/**
 * POST /api/withdraw
 * Initiate a withdrawal transaction
 * Returns 409 if duplicate txHash is detected
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId, positionId, amount, assetSymbol, txHash, memo } = withdrawSchema.parse(req.body)

    // Verify user can only withdraw from their own account
    if (req.userId !== userId) {
      res.status(403).json({ error: 'Forbidden', message: 'Cannot create withdrawal for other users' })
      return
    }

    const user = await db.user.findUnique({
      where: { id: userId }
    })

    if (!user) {
      res.status(404).json({ error: 'Not Found', message: 'User not found' })
      return
    }

    // Verify position exists and belongs to user
    const position = await db.position.findUnique({
      where: { id: positionId }
    })

    if (!position) {
      res.status(404).json({ error: 'Not Found', message: 'Position not found' })
      return
    }

    if (position.userId !== userId) {
      res.status(403).json({ error: 'Forbidden', message: 'Cannot withdraw from other users positions' })
      return
    }

    // Check if withdrawal amount is valid
    const withdrawAmount = new Decimal(amount)
    if (withdrawAmount.greaterThan(position.currentValue)) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Withdrawal amount exceeds position value',
        availableBalance: position.currentValue.toString()
      })
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

    // Update position balance
    const updatedPosition = await db.position.update({
      where: { id: positionId },
      data: {
        currentValue: position.currentValue.minus(withdrawAmount)
      }
    })

    // Create withdrawal transaction
    const transaction = await db.transaction.create({
      data: {
        userId: userId,
        positionId: positionId,
        type: 'WITHDRAWAL',
        status: 'PENDING',
        assetSymbol: assetSymbol,
        amount: withdrawAmount,
        network: user.network,
        protocolName: position.protocolName,
        txHash: txHash,
        memo: memo
      }
    })

    // Log agent action
    await db.agentLog.create({
      data: {
        userId: userId,
        action: 'WITHDRAW',
        status: 'SUCCESS',
        inputData: {
          positionId,
          amount,
          assetSymbol,
          txHash
        },
        outputData: {
          transactionId: transaction.id,
          newPositionValue: updatedPosition.currentValue.toString()
        }
      }
    })

    const withdrawData = {
      transactionId: transaction.id,
      positionId: positionId,
      userId: userId,
      type: 'WITHDRAWAL',
      amount: amount,
      assetSymbol: assetSymbol,
      protocolName: position.protocolName,
      txHash: txHash,
      status: 'PENDING',
      remainingBalance: updatedPosition.currentValue.toString(),
      createdAt: transaction.createdAt.toISOString(),
      whatsappReply: whatsappFormatters.formatWithdrawalConfirmation(amount, assetSymbol, txHash)
    }

    res.status(201).json(withdrawData)
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation Error',
        message: 'Invalid withdrawal parameters',
        details: error.issues
      })
      return
    }

    logger.error('Withdraw endpoint error', { error, body: req.body })
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
