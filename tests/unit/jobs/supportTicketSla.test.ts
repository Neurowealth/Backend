import { checkSupportTicketSla } from '../../../src/jobs/supportTicketSla'
import db from '../../../src/db'
import { alertingService } from '../../../src/services/alerting'
import { register } from '../../../src/utils/metrics'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    supportTicket: { findMany: jest.fn(), updateMany: jest.fn() },
  },
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('../../../src/services/alerting', () => ({
  alertingService: { emit: jest.fn().mockResolvedValue({ sent: true }) },
}))

const mockDb = db as any
const now = new Date('2026-10-10T12:00:00Z')
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600000)

const ticket = (over: Record<string, unknown>) => ({
  id: 't',
  priority: 'MEDIUM',
  status: 'OPEN',
  createdAt: hoursAgo(1),
  updatedAt: hoursAgo(1),
  firstResponseAt: null,
  slaBreached: false,
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
})

describe('checkSupportTicketSla (#618)', () => {
  it('marks newly breached tickets, alerts critical for urgent, and sets the metric', async () => {
    mockDb.supportTicket.findMany.mockResolvedValue([
      ticket({ id: 'u1', priority: 'URGENT', createdAt: hoursAgo(3) }),
      ticket({ id: 'm1', priority: 'MEDIUM', createdAt: hoursAgo(2) }),
      ticket({
        id: 'old',
        priority: 'URGENT',
        createdAt: hoursAgo(10),
        slaBreached: true,
      }),
    ])

    const result = await checkSupportTicketSla(now)

    expect(result).toMatchObject({ breached: 2, newlyBreached: 1 })
    expect(mockDb.supportTicket.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['u1'] } },
      data: { slaBreached: true },
    })
    expect(alertingService.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'critical',
        metadata: { ticketIds: ['u1'] },
      }),
      'support-sla-breach'
    )
    const metrics = await register.getMetricsAsJSON()
    const gauge = metrics.find((m) => m.name === 'support_tickets_sla_breached')
    const urgent = (gauge as any).values.find(
      (v: any) => v.labels.priority === 'URGENT'
    )
    expect(urgent.value).toBe(2)
  })

  it('does not treat a ticket answered within SLA as breached', async () => {
    mockDb.supportTicket.findMany.mockResolvedValue([
      ticket({
        priority: 'URGENT',
        status: 'IN_PROGRESS',
        createdAt: hoursAgo(5),
        firstResponseAt: hoursAgo(4),
      }),
    ])

    const result = await checkSupportTicketSla(now)

    expect(result.breached).toBe(0)
    expect(alertingService.emit).not.toHaveBeenCalledWith(
      expect.anything(),
      'support-sla-breach'
    )
  })

  it('alerts on tickets untouched past the stale threshold, ignoring awaiting-user', async () => {
    mockDb.supportTicket.findMany.mockResolvedValue([
      ticket({ id: 's1', priority: 'LOW', updatedAt: hoursAgo(30) }),
      ticket({
        id: 's2',
        priority: 'LOW',
        status: 'AWAITING_USER',
        updatedAt: hoursAgo(90),
      }),
    ])

    const result = await checkSupportTicketSla(now)

    expect(result.stale).toBe(1)
    expect(alertingService.emit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { ticketIds: ['s1'] } }),
      'support-stale'
    )
  })
})
