import type { Network } from '@prisma/client'

declare global {
  namespace Express {
    interface Request {
      correlationId?: string
      userId?: string
      stellarPubKey?: string
      auth?: {
        userId: string
        sessionId: string
        walletAddress: string
        network: Network
        actingAsUserId?: string // set by requireSubAccountPermission when parent acts on child
      }
    }
  }
}

export {}
