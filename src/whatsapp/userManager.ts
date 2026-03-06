import { Keypair } from '@stellar/stellar-sdk'
import { db } from '../db'
import { logger } from '../utils/logger'
import crypto from 'crypto'

export interface WhatsAppUser {
  id: string
  phoneNumber: string
  walletAddress: string
  isVerified: boolean
  isActive: boolean
}

export class UserManager {
  /**
   * Find or create a user by phone number
   */
  static async findOrCreateUser(phoneNumber: string): Promise<WhatsAppUser> {
    try {
      // Clean phone number (remove + and spaces)
      const cleanPhone = phoneNumber.replace(/[\+\s]/g, '')

      let user = await db.user.findUnique({
        where: { phoneNumber: cleanPhone }
      })

      if (!user) {
        // Create new Stellar wallet
        const keypair = Keypair.random()

        // Encrypt the secret key (in production, use KMS)
        const encryptedSecret = this.encryptSecret(keypair.secret())

        user = await db.user.create({
          data: {
            phoneNumber: cleanPhone,
            walletAddress: keypair.publicKey(),
            walletSecret: encryptedSecret,
            network: 'TESTNET', // Use testnet for development
            isActive: true,
            isVerified: false
          }
        })

        logger.info('Created new WhatsApp user', {
          userId: user.id,
          phoneNumber: cleanPhone,
          walletAddress: user.walletAddress
        })
      }

      return {
        id: user.id,
        phoneNumber: user.phoneNumber!,
        walletAddress: user.walletAddress,
        isVerified: user.isVerified,
        isActive: user.isActive
      }
    } catch (error) {
      logger.error('Error finding/creating WhatsApp user', { error, phoneNumber })
      throw error
    }
  }

  /**
   * Generate and store OTP for user verification
   */
  static async generateOTP(userId: string): Promise<string> {
    try {
      // Generate 6-digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString()
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes

      await db.user.update({
        where: { id: userId },
        data: {
          otpCode: otp,
          otpExpiresAt: expiresAt
        }
      })

      logger.info('Generated OTP for user', { userId })
      return otp
    } catch (error) {
      logger.error('Error generating OTP', { error, userId })
      throw error
    }
  }

  /**
   * Verify OTP code
   */
  static async verifyOTP(userId: string, otpCode: string): Promise<boolean> {
    try {
      const user = await db.user.findUnique({
        where: { id: userId },
        select: {
          otpCode: true,
          otpExpiresAt: true,
          isVerified: true
        }
      })

      if (!user || !user.otpCode || !user.otpExpiresAt) {
        return false
      }

      // Check if OTP is expired
      if (new Date() > user.otpExpiresAt) {
        return false
      }

      // Check if OTP matches
      if (user.otpCode !== otpCode) {
        return false
      }

      // Mark user as verified
      await db.user.update({
        where: { id: userId },
        data: {
          isVerified: true,
          otpCode: null,
          otpExpiresAt: null
        }
      })

      logger.info('User verified with OTP', { userId })
      return true
    } catch (error) {
      logger.error('Error verifying OTP', { error, userId })
      throw error
    }
  }

  /**
   * Get user's decrypted wallet secret (for signing transactions)
   */
  static getWalletSecret(userId: string): Promise<string | null> {
    return db.user.findUnique({
      where: { id: userId },
      select: { walletSecret: true }
    }).then(user => {
      if (!user?.walletSecret) return null
      return this.decryptSecret(user.walletSecret)
    })
  }

  /**
   * Encrypt wallet secret (MVP implementation - use KMS in production)
   */
  private static encryptSecret(secret: string): string {
    const algorithm = 'aes-256-cbc'
    const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'default-key', 'salt', 32)
    const iv = crypto.randomBytes(16)

    const cipher = crypto.createCipheriv(algorithm, key, iv)
    let encrypted = cipher.update(secret, 'utf8', 'hex')
    encrypted += cipher.final('hex')

    return iv.toString('hex') + ':' + encrypted
  }

  /**
   * Decrypt wallet secret
   */
  private static decryptSecret(encrypted: string): string {
    const algorithm = 'aes-256-cbc'
    const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'default-key', 'salt', 32)

    const [ivHex, encryptedData] = encrypted.split(':')
    const iv = Buffer.from(ivHex, 'hex')

    const decipher = crypto.createDecipheriv(algorithm, key, iv)
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8')
    decrypted += decipher.final('utf8')

    return decrypted
  }
}