import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/authenticate'
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

router.post(
  '/chat',
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
