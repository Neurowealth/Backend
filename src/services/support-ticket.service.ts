import { TicketPriority, TicketStatus } from '@prisma/client'

const DEFAULT_SLA_HOURS: Record<TicketPriority, number> = {
  LOW: 72,
  MEDIUM: 24,
  HIGH: 8,
  URGENT: 2,
}

export function supportSlaHours(priority: TicketPriority): number {
  const configured = Number(process.env[`SUPPORT_SLA_${priority}_HOURS`])
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SLA_HOURS[priority]
}

export function supportStaleHours(): number {
  const configured = Number(process.env.SUPPORT_STALE_HOURS)
  return Number.isFinite(configured) && configured > 0 ? configured : 24
}

export function supportSla(
  ticket: {
    priority: TicketPriority
    status: TicketStatus
    createdAt: Date
    firstResponseAt?: Date | null
  },
  now = new Date()
) {
  const slaDueAt = new Date(
    ticket.createdAt.getTime() + supportSlaHours(ticket.priority) * 3600000
  )
  const slaBreached = ticket.firstResponseAt
    ? ticket.firstResponseAt > slaDueAt
    : ticket.status !== 'RESOLVED' &&
      ticket.status !== 'CLOSED' &&
      slaDueAt < now
  return { slaDueAt, slaBreached }
}

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return from === to || SUPPORT_TRANSITIONS[from].includes(to)
}

export const SUPPORT_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  OPEN: ['IN_PROGRESS', 'AWAITING_USER', 'RESOLVED'],
  IN_PROGRESS: ['AWAITING_USER', 'RESOLVED'],
  AWAITING_USER: ['IN_PROGRESS', 'RESOLVED'],
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
}
