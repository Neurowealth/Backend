process.env.NODE_ENV = 'test'

import express from 'express'
import request from 'supertest'
import { Request, Response, NextFunction } from 'express'
import { Network } from '@prisma/client'
import approvalsRouter from '../../../src/routes/approvals'
import { AppError } from '../../../src/utils/errors'
import {
  decide,
  cancel,
  listApprovalRequestsForUser,
  getVisibleRequestDetail,
} from '../../../src/approvals/service'

jest.mock('../../../src/approvals/service', () => ({
  decide: jest.fn(),
  cancel: jest.fn(),
  listApprovalRequestsForUser: jest.fn(),
  getVisibleRequestDetail: jest.fn(),
}))

jest.mock('../../../src/middleware/authenticate', () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers?.authorization) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.auth = {
      userId: 'user-1',
      sessionId: 'session-1',
      walletAddress: 'GDZST3XVCDTUJ76ZAV2HA72KYXM4Y5KLTMPQWLBQ3VBLGR4A5YNWHA63',
      network: Network.MAINNET,
    }
    next()
  },
}))

const app = express()
app.use(express.json())
app.use('/approvals', approvalsRouter)

const mockDecide = decide as jest.Mock
const mockCancel = cancel as jest.Mock
const mockList = listApprovalRequestsForUser as jest.Mock
const mockDetail = getVisibleRequestDetail as jest.Mock

function authHeader() {
  return { Authorization: 'Bearer test-token' }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('GET /approvals', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/approvals')
    expect(res.status).toBe(401)
  })

  it('returns the caller-visible list', async () => {
    mockList.mockResolvedValue({ requests: [], page: 1, limit: 5, total: 0 })
    const res = await request(app).get('/approvals').set(authHeader())
    expect(res.status).toBe(200)
    expect(mockList).toHaveBeenCalledWith('user-1', expect.any(Object))
  })
})

describe('GET /approvals/:id', () => {
  it('returns 404 when the request is not visible to the caller', async () => {
    mockDetail.mockResolvedValue(null)
    const res = await request(app).get('/approvals/req-1').set(authHeader())
    expect(res.status).toBe(404)
  })

  it('returns the request when visible', async () => {
    mockDetail.mockResolvedValue({ id: 'req-1' })
    const res = await request(app).get('/approvals/req-1').set(authHeader())
    expect(res.status).toBe(200)
    expect(res.body.request.id).toBe('req-1')
  })
})

describe('POST /approvals/:id/approve', () => {
  it('approves and returns the service result', async () => {
    mockDecide.mockResolvedValue({ status: 'PENDING', approvalCount: 1 })
    const res = await request(app)
      .post('/approvals/req-1/approve')
      .set(authHeader())
      .send({ note: 'looks fine' })
    expect(res.status).toBe(200)
    expect(mockDecide).toHaveBeenCalledWith(
      'req-1',
      'user-1',
      true,
      'looks fine'
    )
  })

  it('maps a thrown AppError to its status code', async () => {
    mockDecide.mockRejectedValue(new AppError(403, 'Not an eligible approver'))
    const res = await request(app)
      .post('/approvals/req-1/approve')
      .set(authHeader())
      .send({})
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Not an eligible approver')
  })

  it('maps an unexpected error to 500', async () => {
    mockDecide.mockRejectedValue(new Error('db exploded'))
    const res = await request(app)
      .post('/approvals/req-1/approve')
      .set(authHeader())
      .send({})
    expect(res.status).toBe(500)
  })
})

describe('POST /approvals/:id/reject', () => {
  it('rejects a request with no reason (400 from zod validation)', async () => {
    const res = await request(app)
      .post('/approvals/req-1/reject')
      .set(authHeader())
      .send({})
    expect(res.status).toBe(400)
    expect(mockDecide).not.toHaveBeenCalled()
  })

  it('rejects a request with a reason', async () => {
    mockDecide.mockResolvedValue({ status: 'REJECTED' })
    const res = await request(app)
      .post('/approvals/req-1/reject')
      .set(authHeader())
      .send({ reason: 'amount looks wrong' })
    expect(res.status).toBe(200)
    expect(mockDecide).toHaveBeenCalledWith(
      'req-1',
      'user-1',
      false,
      'amount looks wrong'
    )
  })
})

describe('POST /approvals/:id/cancel', () => {
  it('cancels as the requester', async () => {
    mockCancel.mockResolvedValue({ status: 'CANCELLED' })
    const res = await request(app)
      .post('/approvals/req-1/cancel')
      .set(authHeader())
    expect(res.status).toBe(200)
    expect(mockCancel).toHaveBeenCalledWith('req-1', 'user-1')
  })

  it('maps a 409 conflict from an already-decided request', async () => {
    mockCancel.mockRejectedValue(
      new AppError(409, 'Request is already EXECUTED')
    )
    const res = await request(app)
      .post('/approvals/req-1/cancel')
      .set(authHeader())
    expect(res.status).toBe(409)
  })
})
