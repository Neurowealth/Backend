/**
 * Express Middleware for Feature Flags & Staged Rollouts (#494)
 *
 * Provides route guarding, user-aware staged rollout checks, and emergency maintenance gating.
 */

import { Request, Response, NextFunction } from 'express'
import {
  isFeatureEnabled,
  evaluateFeatureFlag,
  FlagEvaluationResult,
} from '../config/featureFlags'
import { logger } from '../utils/logger'

// Augment Express Request type to include feature flag helpers
declare global {
  namespace Express {
    interface Request {
      isFeatureEnabled?: (flagKey: string) => boolean
      evaluateFeatureFlag?: (flagKey: string) => FlagEvaluationResult
    }
  }
}

export interface RequireFeatureFlagOptions {
  /**
   * HTTP status code to return when the feature is disabled (default: 503).
   */
  status?: number
  /**
   * Custom error message returned in the JSON payload.
   */
  message?: string
  /**
   * Alias for message.
   */
  customMessage?: string
  /**
   * Custom extractor for entity ID (e.g. user ID, account ID) used for deterministic staged rollouts.
   */
  entityExtractor?: (req: Request) => string | undefined
  /**
   * Custom fallback handler if the flag is disabled instead of terminating with a status response.
   */
  fallback?: (req: Request, res: Response, next: NextFunction) => void
}

/**
 * Extracts a candidate entity identifier from the Express Request.
 * Checks authenticated user id, auth context, or client IP.
 */
export function defaultEntityExtractor(req: Request): string | undefined {
  const user = (req as any).user
  if (user?.id) return String(user.id)
  const auth = (req as any).auth
  if (auth?.userId) return String(auth.userId)
  const headerUserId = req.headers['x-user-id']
  if (typeof headerUserId === 'string' && headerUserId.trim()) {
    return headerUserId.trim()
  }
  return req.ip || undefined
}

/**
 * Route middleware that checks whether a feature flag is enabled.
 * If disabled, returns HTTP 503 (Service Unavailable) or executes a custom fallback handler.
 */
export function requireFeatureFlag(
  flagKey: string,
  options: RequireFeatureFlagOptions = {}
) {
  const statusCode = options.status || 503
  const extractor = options.entityExtractor || defaultEntityExtractor

  return (req: Request, res: Response, next: NextFunction): void => {
    const entityId = extractor(req)
    const evaluation = evaluateFeatureFlag(flagKey, { entityId })

    if (evaluation.enabled) {
      next()
      return
    }

    if (options.fallback) {
      options.fallback(req, res, next)
      return
    }

    const message =
      options.customMessage ||
      options.message ||
      'This feature is temporarily unavailable or undergoing staged rollout.'

    logger.warn(
      `[FeatureFlagMiddleware] Request blocked by flag "${flagKey}" for ${req.method} ${req.path}`,
      {
        flagKey,
        path: req.path,
        method: req.method,
        entityId: entityId || null,
        decision: evaluation.decision,
        reason: evaluation.reason,
      }
    )

    res.status(statusCode).json({
      success: false,
      error: message,
      code: 'FEATURE_DISABLED',
      flag: flagKey,
      decision: evaluation.decision,
    })
  }
}

/**
 * Middleware that attaches feature flag helper functions to `req`.
 */
export function featureFlagMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const entityId = defaultEntityExtractor(req)

  req.isFeatureEnabled = (flagKey: string): boolean => {
    return isFeatureEnabled(flagKey, { entityId })
  }

  req.evaluateFeatureFlag = (flagKey: string): FlagEvaluationResult => {
    return evaluateFeatureFlag(flagKey, { entityId })
  }

  next()
}

/**
 * Platform-wide emergency maintenance mode guard.
 * Blocks all mutating (POST, PUT, PATCH, DELETE) operations when active.
 */
export function emergencyMaintenanceGuard(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const mutatingMethods = ['POST', 'PUT', 'PATCH', 'DELETE']
  if (!mutatingMethods.includes(req.method.toUpperCase())) {
    next()
    return
  }

  // Exempt internal health and admin emergency unlock routes
  if (req.path.startsWith('/health') || req.path.startsWith('/api/v1/admin/feature-flags')) {
    next()
    return
  }

  const maintenance = evaluateFeatureFlag('emergency_maintenance_mode')
  if (maintenance.enabled) {
    logger.error(
      `[EmergencyMaintenanceGuard] Blocked mutating request ${req.method} ${req.path}`,
      {
        path: req.path,
        method: req.method,
      }
    )

    res.status(503).json({
      success: false,
      error: 'Platform emergency maintenance mode is active. State mutations are currently halted.',
      code: 'EMERGENCY_MAINTENANCE_ACTIVE',
    })
    return
  }

  next()
}
