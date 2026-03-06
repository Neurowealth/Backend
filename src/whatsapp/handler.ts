import { Request, Response } from 'express'
import { UserManager } from './userManager'
import { parseWithRegex } from '../nlp/parser'
import { formatBalance, formatDeposit, formatWithdraw, formatEarnings, formatHelp } from './formatters'
import { logger } from '../utils/logger'
import { db } from '../db'

export interface IntentResult {
  success: boolean
  message: string
  needsVerification?: boolean
}

export class WhatsAppHandler {
  /**
   * Handle incoming WhatsApp message and return formatted responses
   */
  static async handleMessage(
    phoneNumber: string,
    message: string
  ): Promise<IntentResult> {
    try {
      // Find or create user
      const user = await UserManager.findOrCreateUser(phoneNumber)

      // Check if user needs verification
      if (!user.isVerified) {
        return this.handleUnverifiedUser(user.id, message)
      }

      // Parse intent
      const intent = parseWithRegex(message)
      if (!intent) {
        return {
          success: true,
          message: formatHelp()
        }
      }

      // Handle different intents
      switch (intent.action) {
        case 'balance':
          return await this.handleBalance(user.id)
        case 'deposit':
          return await this.handleDeposit(user, intent)
        case 'withdraw':
          return await this.handleWithdraw(user, intent)
        case 'help':
          return {
            success: true,
            message: formatHelp()
          }
        default:
          return {
            success: true,
            message: formatHelp()
          }
      }
    } catch (error) {
      logger.error('Error handling WhatsApp message', { error, phoneNumber })
      return {
        success: false,
        message: 'Sorry, I encountered an error. Please try again later.'
      }
    }
  }

  /**
   * Handle unverified user (OTP flow)
   */
  private static async handleUnverifiedUser(
    userId: string,
    message: string
  ): Promise<IntentResult> {
    const cleanMessage = message.trim().toLowerCase()

    // Check if this is an OTP verification attempt
    if (/^\d{6}$/.test(cleanMessage)) {
      const isValid = await UserManager.verifyOTP(userId, cleanMessage)
      if (isValid) {
        return {
          success: true,
          message: `✅ *Account Verified!*\n\nWelcome to NeuroWealth! 🎉\n\nYou can now:\n• Check your *balance*\n• Make *deposits*\n• Request *withdrawals*\n• View *earnings*\n\nType *help* for more commands.`
        }
      } else {
        return {
          success: false,
          message: '❌ *Invalid OTP*\n\nPlease check your code and try again.'
        }
      }
    }

    // Send new OTP
    const otp = await UserManager.generateOTP(userId)
    // In production, send OTP via Twilio SMS
    logger.info('OTP generated for WhatsApp user', { userId, otp })

    return {
      success: true,
      message: `👋 *Welcome to NeuroWealth!*\n\nTo get started, please verify your account with the OTP code sent to your phone.\n\n*Demo OTP: ${otp}*\n\nReply with the 6-digit code to continue.`,
      needsVerification: true
    }
  }

  /**
   * Handle balance inquiry
   */
  private static async handleBalance(userId: string): Promise<IntentResult> {
    try {
      // Get user's positions and calculate totals
      const positions = await db.position.findMany({
        where: {
          userId,
          status: 'ACTIVE'
        },
        include: {
          yieldSnapshots: {
            orderBy: { snapshotAt: 'desc' },
            take: 1
          }
        }
      })

      const totalBalance = positions.reduce((sum: any, pos: any) =>
        sum + Number(pos.currentValue), 0
      )

      const totalYield = positions.reduce((sum: any, pos: any) =>
        sum + Number(pos.yieldEarned), 0
      )

      const formattedPositions = positions.map((pos: any) => ({
        protocolName: pos.protocolName,
        assetSymbol: pos.assetSymbol,
        amount: pos.depositedAmount.toString(),
        currentValue: pos.currentValue.toString(),
        apy: pos.yieldSnapshots[0]?.apy.toString() || '0'
      }))

      return {
        success: true,
        message: formatBalance({
          totalBalance: totalBalance.toFixed(2),
          totalYield: totalYield.toFixed(2),
          positions: formattedPositions
        })
      }
    } catch (error) {
      logger.error('Error fetching balance', { error, userId })
      return {
        success: false,
        message: 'Sorry, I couldn\'t fetch your balance. Please try again.'
      }
    }
  }

  /**
   * Handle deposit request
   */
  private static async handleDeposit(
    user: any,
    intent: any
  ): Promise<IntentResult> {
    try {
      if (!intent.amount) {
        return {
          success: false,
          message: 'Please specify an amount to deposit. Example: "deposit 100 USDC"'
        }
      }

      // For demo purposes, we'll simulate deposit processing
      // In production, this would integrate with actual deposit logic
      const depositData = {
        amount: intent.amount.toString(),
        currency: intent.currency || 'USDC',
        walletAddress: user.walletAddress,
        status: 'pending'
      }

      return {
        success: true,
        message: formatDeposit(depositData)
      }
    } catch (error) {
      logger.error('Error processing deposit', { error, userId: user.id })
      return {
        success: false,
        message: 'Sorry, I couldn\'t process your deposit request. Please try again.'
      }
    }
  }

  /**
   * Handle withdrawal request
   */
  private static async handleWithdraw(
    user: any,
    intent: any
  ): Promise<IntentResult> {
    try {
      if (!intent.amount && !intent.all) {
        return {
          success: false,
          message: 'Please specify an amount to withdraw or say "withdraw all". Example: "withdraw 50 USDC"'
        }
      }

      // Check available balance
      const positions = await db.position.findMany({
        where: {
          userId: user.id,
          status: 'ACTIVE'
        }
      })

      const totalBalance = positions.reduce((sum: any, pos: any) =>
        sum + Number(pos.currentValue), 0
      )

      if (totalBalance === 0) {
        return {
          success: false,
          message: 'You don\'t have any funds to withdraw.'
        }
      }

      const withdrawAmount = intent.all ? totalBalance : intent.amount
      if (withdrawAmount > totalBalance) {
        return {
          success: false,
          message: `Insufficient balance. You have $${totalBalance.toFixed(2)} available.`
        }
      }

      // For demo purposes, simulate withdrawal
      const withdrawData = {
        amount: withdrawAmount.toString(),
        currency: 'USDC', // Assume USDC for simplicity
        status: 'processing'
      }

      return {
        success: true,
        message: formatWithdraw(withdrawData)
      }
    } catch (error) {
      logger.error('Error processing withdrawal', { error, userId: user.id })
      return {
        success: false,
        message: 'Sorry, I couldn\'t process your withdrawal request. Please try again.'
      }
    }
  }
}