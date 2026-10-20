import type { Network } from '@prisma/client'
import type { FlagEvaluationResult } from '../config/featureFlags'

declare global {
  namespace Express {
    interface Request {
      correlationId?: string
      userId?: string
      stellarPubKey?: string
      authKind?: 'session' | 'api_key'
      authScopes?: string[]
      apiKeyId?: string
      apiKeyAllowWithdrawals?: boolean
      isFeatureEnabled?: (flagKey: string) => boolean
      evaluateFeatureFlag?: (flagKey: string) => FlagEvaluationResult
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
