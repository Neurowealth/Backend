/**
 * Support ticket SLA monitor (#618). Marks tickets whose first response is
 * overdue, flags tickets untouched for SUPPORT_STALE_HOURS, publishes gauges
 * for Prometheus, and alerts on newly breached or stale tickets.
 */
import { TicketPriority } from '@prisma/client'
import db from '../db'
import { logger } from '../utils/logger'
import { alertingService } from '../services/alerting'
import {
  supportTicketsSlaBreached,
  supportTicketsStale,
} from '../utils/metrics'
import { scheduleResilientJob } from './resilientScheduler'
import {
  supportSla,
  supportStaleHours,
} from '../services/support-ticket.service'

const INTERVAL_MS = parseInt(
  process.env.SUPPORT_SLA_CHECK_INTERVAL_MS || '300000'
)

export interface SupportSlaResult {
  breached: number
  newlyBreached: number
  stale: number
}

export async function checkSupportTicketSla(
  now: Date = new Date()
): Promise<SupportSlaResult> {
  const open = await db.supportTicket.findMany({
    where: { status: { notIn: ['RESOLVED', 'CLOSED'] } },
    select: {
      id: true,
      priority: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      firstResponseAt: true,
      slaBreached: true,
    },
  })

  const byPriority = new Map<TicketPriority, number>(
    Object.values(TicketPriority).map((p) => [p, 0])
  )
  const newlyBreached: typeof open = []
  let breached = 0

  for (const ticket of open) {
    if (!supportSla(ticket, now).slaBreached) continue
    breached++
    byPriority.set(ticket.priority, (byPriority.get(ticket.priority) ?? 0) + 1)
    if (!ticket.slaBreached) newlyBreached.push(ticket)
  }

  for (const [priority, count] of byPriority) {
    supportTicketsSlaBreached.set({ priority }, count)
  }

  if (newlyBreached.length > 0) {
    await db.supportTicket.updateMany({
      where: { id: { in: newlyBreached.map((t) => t.id) } },
      data: { slaBreached: true },
    })
    const urgent = newlyBreached.some(
      (t) => t.priority === 'URGENT' || t.priority === 'HIGH'
    )
    await alertingService.emit(
      {
        title: 'Support ticket SLA breached',
        description: `${newlyBreached.length} support ticket(s) passed their response SLA`,
        severity: urgent ? 'critical' : 'warning',
        component: 'support-tickets',
        metadata: { ticketIds: newlyBreached.map((t) => t.id) },
      },
      'support-sla-breach'
    )
  }

  const staleCutoff = now.getTime() - supportStaleHours() * 3600000
  const stale = open.filter(
    (t) => t.status !== 'AWAITING_USER' && t.updatedAt.getTime() < staleCutoff
  )
  supportTicketsStale.set(stale.length)

  if (stale.length > 0) {
    await alertingService.emit(
      {
        title: 'Stale support tickets',
        description: `${stale.length} support ticket(s) untouched for over ${supportStaleHours()}h`,
        severity: 'warning',
        component: 'support-tickets',
        metadata: { ticketIds: stale.map((t) => t.id) },
      },
      'support-stale'
    )
  }

  logger.info('[SupportSla] Check complete', {
    breached,
    newlyBreached: newlyBreached.length,
    stale: stale.length,
  })
  return { breached, newlyBreached: newlyBreached.length, stale: stale.length }
}

export function scheduleSupportTicketSla(): NodeJS.Timeout {
  return scheduleResilientJob({
    jobName: 'support_ticket_sla',
    task: () => checkSupportTicketSla().then(() => undefined),
    intervalMs: INTERVAL_MS,
    unref: true,
  })
}
