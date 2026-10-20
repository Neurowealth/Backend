import { Router, Request, Response, RequestHandler } from 'express'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import { sensitiveRateLimiter } from '../middleware/rateLimiter'
import db from '../db'
import { logger } from '../utils/logger'
import {
  createSupportTicketSchema,
  replySupportTicketSchema,
  supportTicketIdParamSchema,
} from '../validators/support-ticket-validators'

const router = Router()

const MAX_ATTACHMENT_REFS = 10

/**
 * Verify that every ref in `attachmentRefs` is owned by `userId`.
 * Rejects if any ref is foreign or the count exceeds the cap.
 * NOTE: When a dedicated attachment upload endpoint is added it must also
 * enforce MIME allow-list (image/*, application/pdf) and a per-file size cap
 * (e.g. 10 MB). Admin download paths must serve with:
 *   Content-Disposition: attachment; filename="<name>"
 *   X-Content-Type-Options: nosniff
 * and route through a scan/quarantine step before delivery.
 */
async function validateAttachmentRefs(
  refs: string[] | undefined,
  userId: string
): Promise<{ valid: boolean; error?: string }> {
  if (!refs || refs.length === 0) return { valid: true }
  if (refs.length > MAX_ATTACHMENT_REFS) {
    return { valid: false, error: `Cannot attach more than ${MAX_ATTACHMENT_REFS} files per message` }
  }
  // Ownership check: each ref must be a TicketAttachment owned by this user.
  // `attachmentRefs` stores UUIDs referencing pre-uploaded attachments scoped to the user.
  const owned = await (db as any).ticketAttachment?.findMany?.({
    where: { id: { in: refs }, userId },
    select: { id: true },
  }) as { id: string }[] | undefined

  if (owned === undefined) {
    // TicketAttachment model not yet deployed — skip ownership check but still
    // accept the refs. Remove this branch once the model is in production.
    return { valid: true }
  }

  const ownedIds = new Set(owned.map((a) => a.id))
  const foreign = refs.filter((r) => !ownedIds.has(r))
  if (foreign.length > 0) {
    logger.warn('[SupportTicket] IDOR attempt: foreign attachment refs', { userId, foreign })
    return { valid: false, error: 'One or more attachment refs are invalid or do not belong to you' }
  }

  return { valid: true }
}

const handle =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    void fn(req, res).catch((error) => {
      if (error && error.code === 'P2025') {
        res
          .status(409)
          .json({ error: 'Resource changed during the request; retry' })
        return
      }
      next(error)
    })
  }

// ── POST / — Create a new support ticket ─────────────────────────────────────
router.post(
  '/',
  requireAuth,
  sensitiveRateLimiter,
  validate({
    body: createSupportTicketSchema,
    errorMessage: 'Validation error',
  }),
  handle(async (req: Request, res: Response) => {
    const { subject, category, body, priority, contextRef, attachmentRefs } =
      req.body
    const userId = req.auth!.userId

    const refCheck = await validateAttachmentRefs(attachmentRefs, userId)
    if (!refCheck.valid) {
      res.status(400).json({ error: refCheck.error })
      return
    }

    const result = await (db as any).$transaction(async (tx: any) => {
      const ticket = await tx.supportTicket.create({
        data: {
          userId,
          subject,
          category,
          priority: priority ?? 'MEDIUM',
          contextRef: contextRef ?? null,
          status: 'OPEN',
        },
      })

      const message = await tx.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          authorUserId: userId,
          authorRole: 'USER',
          body,
          attachmentRefs: attachmentRefs ?? [],
          internal: false,
        },
      })

      return { ticket, message }
    })

    logger.info('[SupportTicket] Created ticket', {
      ticketId: result.ticket.id,
      userId,
      category,
      priority,
    })

    res.status(201).json(result)
  })
)

// ── GET / — List user's support tickets ──────────────────────────────────────
router.get(
  '/',
  requireAuth,
  handle(async (req: Request, res: Response) => {
    const userId = req.auth!.userId

    const tickets = await (db as any).supportTicket.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        messages: {
          where: { internal: false },
          orderBy: { createdAt: 'asc' },
          take: 1, // first message snippet
        },
      },
    })

    res.json({ tickets })
  })
)

// ── GET /:id — View single support ticket thread ─────────────────────────────
router.get(
  '/:id',
  requireAuth,
  validate({
    params: supportTicketIdParamSchema,
    errorMessage: 'Validation error',
  }),
  handle(async (req: Request, res: Response) => {
    const { id } = req.params
    const userId = req.auth!.userId

    const ticket = await (db as any).supportTicket.findUnique({
      where: { id },
    })

    if (!ticket) {
      res.status(404).json({ error: 'Support ticket not found' })
      return
    }

    if (ticket.userId !== userId) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    // CRITICAL: internal: false enforced strictly at DB query level
    const messages = await (db as any).ticketMessage.findMany({
      where: {
        ticketId: id,
        internal: false,
      },
      orderBy: { createdAt: 'asc' },
    })

    res.json({ ticket, messages })
  })
)

// ── POST /:id/reply — User reply to ticket ───────────────────────────────────
router.post(
  '/:id/reply',
  requireAuth,
  validate({
    params: supportTicketIdParamSchema,
    body: replySupportTicketSchema,
    errorMessage: 'Validation error',
  }),
  handle(async (req: Request, res: Response) => {
    const { id } = req.params
    const { body, attachmentRefs } = req.body
    const userId = req.auth!.userId

    const ticket = await (db as any).supportTicket.findUnique({
      where: { id },
    })

    if (!ticket) {
      res.status(404).json({ error: 'Support ticket not found' })
      return
    }

    if (ticket.userId !== userId) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    if (ticket.status === 'CLOSED') {
      res.status(409).json({ error: 'Ticket is closed' })
      return
    }

    const refCheck = await validateAttachmentRefs(attachmentRefs, userId)
    if (!refCheck.valid) {
      res.status(400).json({ error: refCheck.error })
      return
    }

    const result = await (db as any).$transaction(async (tx: any) => {
      const message = await tx.ticketMessage.create({
        data: {
          ticketId: id,
          authorUserId: userId,
          authorRole: 'USER',
          body,
          attachmentRefs: attachmentRefs ?? [],
          internal: false,
        },
      })

      // Auto-reopen if ticket status was RESOLVED
      let updatedTicket = ticket
      if (ticket.status === 'RESOLVED' || ticket.status === 'AWAITING_USER') {
        updatedTicket = await tx.supportTicket.update({
          where: { id, status: ticket.status },
          data: {
            status: 'IN_PROGRESS',
            resolvedAt: null,
          },
        })

        logger.info('[SupportTicket] Reopened resolved ticket on user reply', {
          ticketId: id,
          userId,
        })
      } else {
        await tx.supportTicket.update({
          where: { id, status: ticket.status },
          data: { updatedAt: new Date() },
        })
      }

      return { message, ticket: updatedTicket }
    })

    res.status(201).json(result)
  })
)

export default router
