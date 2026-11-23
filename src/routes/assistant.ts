import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/authenticate'
import { requireSessionAuth } from '../middleware/apiKeyAuth'
import { sensitiveRateLimiter } from '../middleware/rateLimiter'
import { validate } from '../middleware/validate'
import { assistantChatSchema } from '../validators/assistant-validators'
import { handleAssistantMessage } from '../agent/assistant/assistant'
import { checkSubAccountPermission } from '../middleware/subAccount'
import { sendUnauthorized } from '../utils/errors'

/**
 * POST /api/v1/assistant/chat (#318).
 *
 * The tool-calling assistant, over the same auth/validation discipline as
 * every other route — see src/agent/assistant/assistant.ts for the
 * orchestrator this delegates to.
 */
const router = Router()

router.use(requireAuth)
// #753 — the assistant can propose AND confirm money-moving tools. An API
// key with any scope could otherwise drive those tools without ever passing
// requireWithdrawScope, so this surface is session-JWT only.
router.use(requireSessionAuth)

router.post(
  '/chat',
  // LLM calls are expensive and can reach action tools; reuse the existing
  // sensitive-operation budget rather than the plain per-principal tier.
  sensitiveRateLimiter,
  validate(assistantChatSchema),
  async (req: Request, res: Response) => {
    const callerUserId = req.auth!.userId
    const targetUserId =
      (req.body.targetUserId as string | undefined) ?? callerUserId
    const isDelegated = targetUserId !== callerUserId

    if (isDelegated) {
      // Gate entry with the broadest permission (VIEW) so a caller with no
      // relationship to the target account cannot even start a conversation
      // about it. Individual tool calls are re-checked against their own
      // required permission inside the assistant orchestrator.
      const check = await checkSubAccountPermission(
        callerUserId,
        targetUserId,
        'VIEW'
      )
      if (!check.allowed) {
        return sendUnauthorized(res)
      }
    }

    const reply = await handleAssistantMessage({
      userId: targetUserId,
      channel: 'api',
      message: req.body.message as string,
      actingAsUserId: isDelegated ? callerUserId : null,
    })

    return res.status(200).json({
      reply: reply.text,
      usedFallback: reply.usedFallback,
      pendingConfirmation: reply.pendingConfirmation ?? false,
    })
  }
)

export default router
