import {
  Router,
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from 'express'
import { Prisma, TicketPriority } from '@prisma/client'
import {
  requireAdminAuth,
  requireAdminScope,
  getAdminAuth,
} from '../../middleware/adminAuth'
import { validate } from '../../middleware/validate'
import db from '../../db'
import {
  supportSla,
  supportSlaHours,
  SUPPORT_TRANSITIONS,
} from '../../services/support-ticket.service'
import {
  adminUpdateSupportTicketSchema,
  adminReplySupportTicketSchema,
  supportTicketIdParamSchema,
  supportQueueQuerySchema,
} from '../../validators/support-ticket-validators'

const router = Router()
const handle =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res).catch(next)
  }

router.use(requireAdminAuth)
router.get(
  '/',
  requireAdminScope('support:read'),
  validate({ query: supportQueueQuerySchema }),
  handle(async (req, res) => {
    const query = supportQueueQuerySchema.parse(req.query)
    const where: Prisma.SupportTicketWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.assignedTo
        ? {
            assignedTo:
              query.assignedTo === 'unassigned' ? null : query.assignedTo,
          }
        : {}),
    }
    const now = new Date()
    const breached: Prisma.SupportTicketWhereInput = {
      status: { notIn: ['RESOLVED', 'CLOSED'] },
      OR: Object.values(TicketPriority).map((priority) => ({
        priority,
        createdAt: {
          lt: new Date(now.getTime() - supportSlaHours(priority) * 3600000),
        },
      })),
    }
    if (query.slaBreached === 'true') where.AND = [breached]
    if (query.slaBreached === 'false') where.NOT = breached
    const tickets = await db.supportTicket.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      include: {
        user: { select: { id: true, displayName: true, email: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    })
    res.json({
      tickets: tickets.map((ticket) => ({
        ...ticket,
        ...supportSla(ticket, now),
      })),
    })
  })
)

router.get(
  '/:id',
  requireAdminScope('support:read'),
  validate({ params: supportTicketIdParamSchema }),
  handle(async (req, res) => {
    const ticket = await db.supportTicket.findUnique({
      where: { id: req.params.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    })
    if (!ticket) {
      res.status(404).json({ error: 'Support ticket not found' })
      return
    }
    res.json({ ticket: { ...ticket, ...supportSla(ticket) } })
  })
)

router.patch(
  '/:id',
  requireAdminScope('support:write'),
  validate({
    params: supportTicketIdParamSchema,
    body: adminUpdateSupportTicketSchema,
  }),
  handle(async (req, res) => {
    const admin = getAdminAuth(res)!
    const existing = await db.supportTicket.findUnique({
      where: { id: req.params.id },
    })
    if (!existing) {
      res.status(404).json({ error: 'Support ticket not found' })
      return
    }
    const { status, priority, assignedTo } =
      adminUpdateSupportTicketSchema.parse(req.body)
    if (
      status &&
      status !== existing.status &&
      !SUPPORT_TRANSITIONS[existing.status].includes(status)
    ) {
      res.status(409).json({
        error: `Invalid transition from ${existing.status} to ${status}`,
      })
      return
    }
    const data: Prisma.SupportTicketUpdateInput = {
      ...(status !== undefined
        ? {
            status,
            resolvedAt:
              status === 'RESOLVED'
                ? new Date()
                : status === 'CLOSED'
                  ? existing.resolvedAt
                  : null,
          }
        : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(assignedTo !== undefined ? { assignedTo } : {}),
    }
    const ticket = await db.$transaction(async (tx) => {
      const updated = await tx.supportTicket.update({
        where: { id: existing.id, status: existing.status },
        data,
      })
      await tx.adminAuditLog.create({
        data: {
          adminKeyId: admin.id,
          adminName: admin.name,
          adminRole: admin.role,
          action: 'SUPPORT_TICKET_UPDATE',
          target: existing.id,
          result: 'SUCCESS',
          details: {
            before: {
              status: existing.status,
              priority: existing.priority,
              assignedTo: existing.assignedTo,
            },
            after: {
              status: updated.status,
              priority: updated.priority,
              assignedTo: updated.assignedTo,
            },
          },
        },
      })
      return updated
    })
    res.json({ ticket })
  })
)

router.post(
  '/:id/reply',
  requireAdminScope('support:write'),
  validate({
    params: supportTicketIdParamSchema,
    body: adminReplySupportTicketSchema,
  }),
  handle(async (req, res) => {
    const admin = getAdminAuth(res)!
    const ticket = await db.supportTicket.findUnique({
      where: { id: req.params.id },
    })
    if (!ticket) {
      res.status(404).json({ error: 'Support ticket not found' })
      return
    }
    if (ticket.status === 'CLOSED') {
      res.status(409).json({ error: 'Ticket is closed' })
      return
    }
    const { body, attachmentRefs, internal } =
      adminReplySupportTicketSchema.parse(req.body)
    const result = await db.$transaction(async (tx) => {
      const message = await tx.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          authorUserId: admin.id,
          authorRole: 'ADMIN',
          body,
          attachmentRefs: attachmentRefs ?? [],
          internal,
        },
      })
      const updated = await tx.supportTicket.update({
        where: { id: ticket.id, status: ticket.status },
        data: {
          updatedAt: new Date(),
          ...(!internal && ['OPEN', 'IN_PROGRESS'].includes(ticket.status)
            ? { status: 'AWAITING_USER' }
            : {}),
        },
      })
      if (updated.status !== ticket.status) {
        await tx.adminAuditLog.create({
          data: {
            adminKeyId: admin.id,
            adminName: admin.name,
            adminRole: admin.role,
            action: 'SUPPORT_TICKET_STATUS',
            target: ticket.id,
            result: 'SUCCESS',
            details: { before: ticket.status, after: updated.status },
          },
        })
      }
      return { message, ticket: updated }
    })
    res.status(201).json(result)
  })
)

export default router
