import { Router, Request, Response } from 'express'
import { requireAuth } from '../../middleware/authenticate'
import { requireAdminAuth } from '../../middleware/adminAuth'
import { validate } from '../../middleware/validate'
import db from '../../db'
import { logger } from '../../utils/logger'
import {
  adminUpdateSupportTicketSchema,
  adminReplySupportTicketSchema,
  supportTicketIdParamSchema,
} from '../../validators/support-ticket-validators'

const router = Router()

// Admin guard middleware fallback if requireAdminAuth is not present
const adminGuard = requireAdminAuth ?? requireAuth

// ── GET / — Filterable support tickets queue ─────────────────────────────────
router.get('/', adminGuard, async (req: Request, res: Response) => {
  const { status, category, assignedTo, slaBreached } = req.query

  const where: any = {}
  if (status) where.status = status as string
  if (category) where.category = category as string
  if (assignedTo !== undefined) {
    where.assignedTo =
      assignedTo === 'unassigned' ? null : (assignedTo as string)
  }
  if (slaBreached !== undefined) {
    where.slaBreached = slaBreached === 'true'
  }

  const tickets = await (db as any).supportTicket.findMany({
    where,
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    include: {
      user: {
        select: {
          id: true,
          displayName: true,
          email: true,
          walletAddress: true,
        },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  })

  res.json({ tickets })
})

// ── PATCH /:id — Admin update ticket status / priority / assignment ─────────
router.patch(
  '/:id',
  adminGuard,
  validate({
    params: supportTicketIdParamSchema,
    body: adminUpdateSupportTicketSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const { id } = req.params
    const { status, priority, assignedTo } = req.body
    const adminId = (req as any).adminKey?.id ?? req.auth?.userId ?? 'admin'

    const existing = await (db as any).supportTicket.findUnique({
      where: { id },
    })
    if (!existing) {
      res.status(404).json({ error: 'Support ticket not found' })
      return
    }

    const data: any = {}
    if (status !== undefined) data.status = status
    if (priority !== undefined) data.priority = priority
    if (assignedTo !== undefined) data.assignedTo = assignedTo

    if (status === 'RESOLVED' && existing.status !== 'RESOLVED') {
      data.resolvedAt = new Date()
    }

    const updated = await (db as any).supportTicket.update({
      where: { id },
      data,
    })

    // Audit log status/assignment/priority changes
    logger.info('[SupportTicketAdmin] Updated ticket', {
      ticketId: id,
      adminId,
      changes: {
        status: status ?? existing.status,
        priority: priority ?? existing.priority,
        assignedTo: assignedTo ?? existing.assignedTo,
      },
    })

    // Write to admin audit log if model exists
    if ((db as any).adminAuditLog) {
      await (db as any).adminAuditLog
        .create({
          data: {
            adminKeyId: (req as any).adminKey?.id ?? null,
            adminName: (req as any).adminKey?.name ?? 'admin',
            action: 'SUPPORT_TICKET_UPDATE',
            target: id,
            result: 'SUCCESS',
            details: { changes: data },
          },
        })
        .catch(() => {})
    }

    res.json({ ticket: updated })
  }
)

// ── POST /:id/reply — Admin reply (public or internal note) ──────────────────
router.post(
  '/:id/reply',
  adminGuard,
  validate({
    params: supportTicketIdParamSchema,
    body: adminReplySupportTicketSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const { id } = req.params
    const { body, attachmentRefs, internal } = req.body
    const adminId = (req as any).adminKey?.id ?? req.auth?.userId ?? 'admin'

    const ticket = await (db as any).supportTicket.findUnique({
      where: { id },
    })
    if (!ticket) {
      res.status(404).json({ error: 'Support ticket not found' })
      return
    }

    const isInternal = Boolean(internal)

    const message = await (db as any).ticketMessage.create({
      data: {
        ticketId: id,
        authorUserId: adminId,
        authorRole: 'ADMIN',
        body,
        attachmentRefs: attachmentRefs ?? [],
        internal: isInternal,
      },
    })

    // If admin replies publicly, update ticket status to AWAITING_USER if currently OPEN or IN_PROGRESS
    let updatedTicket = ticket
    if (
      !isInternal &&
      (ticket.status === 'OPEN' || ticket.status === 'IN_PROGRESS')
    ) {
      updatedTicket = await (db as any).supportTicket.update({
        where: { id },
        data: { status: 'AWAITING_USER' },
      })
    }

    logger.info('[SupportTicketAdmin] Admin replied to ticket', {
      ticketId: id,
      adminId,
      internal: isInternal,
    })

    res.status(201).json({ message, ticket: updatedTicket })
  }
)

export default router
