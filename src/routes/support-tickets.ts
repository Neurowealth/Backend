import { Router, Request, Response } from 'express'
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

// ── POST / — Create a new support ticket ─────────────────────────────────────
router.post(
  '/',
  requireAuth,
  sensitiveRateLimiter,
  validate({
    body: createSupportTicketSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const { subject, category, body, priority, contextRef, attachmentRefs } =
      req.body
    const userId = req.auth!.userId

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
  }
)

// ── GET / — List user's support tickets ──────────────────────────────────────
router.get('/', requireAuth, async (req: Request, res: Response) => {
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

// ── GET /:id — View single support ticket thread ─────────────────────────────
router.get(
  '/:id',
  requireAuth,
  validate({
    params: supportTicketIdParamSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
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
  }
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
  async (req: Request, res: Response) => {
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
  }
)

export default router
