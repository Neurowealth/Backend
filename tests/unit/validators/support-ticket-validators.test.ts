import {
  createSupportTicketSchema,
  replySupportTicketSchema,
  adminUpdateSupportTicketSchema,
} from '../../../src/validators/support-ticket-validators'

describe('support-ticket-validators', () => {
  it('validates a valid create ticket schema', () => {
    const valid = {
      subject: 'Deposit not appearing',
      category: 'TRANSACTION',
      body: 'I sent 100 USDC but it is not showing up in my account.',
      priority: 'HIGH',
      contextRef: 'tx-12345',
    }

    const res = createSupportTicketSchema.safeParse(valid)
    expect(res.success).toBe(true)
  })

  it('fails if subject is too short', () => {
    const invalid = {
      subject: 'Hi',
      category: 'OTHER',
      body: 'Question about fees',
    }

    const res = createSupportTicketSchema.safeParse(invalid)
    expect(res.success).toBe(false)
  })

  it('validates reply schema', () => {
    const valid = {
      body: 'Here is the requested transaction hash',
    }

    const res = replySupportTicketSchema.safeParse(valid)
    expect(res.success).toBe(true)
  })

  it('validates admin update schema', () => {
    const valid = {
      status: 'RESOLVED',
      priority: 'URGENT',
      assignedTo: 'admin-user-1',
    }

    const res = adminUpdateSupportTicketSchema.safeParse(valid)
    expect(res.success).toBe(true)
  })
})
