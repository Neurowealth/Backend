import type { Request, Response } from 'express'
import { createStreamTicket } from '../../../src/middleware/streamAuth'
import { issueStreamTicket } from '../../../src/controllers/stream-ticket-controller'

jest.mock('../../../src/middleware/streamAuth', () => ({
  createStreamTicket: jest.fn().mockReturnValue('signed-ticket'),
}))

describe('issueStreamTicket', () => {
  const response = () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }
    return res as unknown as Response
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('always issues a ticket for the authenticated user, ignoring actor query input', async () => {
    const req = {
      auth: { userId: 'viewer-1' },
      query: { actor: 'victim-1' },
    } as unknown as Request
    const res = response()

    await issueStreamTicket(req, res)

    expect(createStreamTicket).toHaveBeenCalledWith('viewer-1', 'viewer-1')
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: 'signed-ticket' })
    )
  })

  it('does not issue a ticket without authenticated identity', async () => {
    const req = { query: {} } as unknown as Request
    const res = response()

    await issueStreamTicket(req, res)

    expect(createStreamTicket).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
  })
})
