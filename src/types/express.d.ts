import type { Network } from '@prisma/client'

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string
        sessionId: string
        walletAddress: string
        network: Network
      }
    }
  }
}

export {}
