/**
 * #844 — the tax-report route's period parameters, through the real router
 * and validators with auth and the DB mocked. `year` is the year the
 * jurisdiction's tax year starts in; `taxYear` takes the canonical label and
 * is checked against the user's jurisdiction.
 */
const userId = '11111111-1111-4111-8111-111111111111'

import request from 'supertest'
import express from 'express'

jest.mock('../../src/middleware/authenticate', () => {
  const actual = jest.requireActual('../../src/middleware/authenticate')
  return {
    requireAuth: (req: any, _res: any, next: any) => {
      req.userId = userId
      req.auth = { userId, walletAddress: 'GWALLET_OWNER' }
      req.authScopes = ['portfolio:read']
      next()
    },
    enforceUserAccess: actual.enforceUserAccess,
  }
})

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logBackgroundJob: jest.fn(),
  requestLogger: (_req: any, _res: any, next: any) => next(),
}))

jest.mock('../../src/db', () => ({ __esModule: true, default: {} }))

import db from '../../src/db'
import portfolioRouter from '../../src/routes/portfolio'

const mockDb = db as any

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/portfolio', portfolioRouter)
  return app
}

function asJurisdiction(taxJurisdiction: string) {
  mockDb.user = {
    findUnique: jest.fn().mockResolvedValue({
      id: userId,
      taxJurisdiction,
      accountingMethod: 'FIFO',
      methodEffectiveAt: null,
    }),
  }
}

const url = `/api/v1/portfolio/${userId}/tax-report`

beforeEach(() => {
  mockDb.lotDisposal = { findMany: jest.fn().mockResolvedValue([]) }
  asJurisdiction('UK')
})

describe('GET /portfolio/:userId/tax-report period (#844)', () => {
  it('UK taxYear=2025-26 returns the 6 April period with its canonical label', async () => {
    const res = await request(buildApp()).get(`${url}?taxYear=2025-26`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      year: 2025,
      taxYearLabel: '2025-26',
      taxYearStart: '2025-04-06T00:00:00.000Z',
      taxYearEnd: '2026-04-06T00:00:00.000Z',
    })
  })

  it('year=2025 still works and means the tax year starting in 2025', async () => {
    const res = await request(buildApp()).get(`${url}?year=2025`)

    expect(res.status).toBe(200)
    expect(res.body.taxYearLabel).toBe('2025-26')
    expect(res.body.caveats.taxYearNote).toMatch(/starts in 2025/)
  })

  it('rejects an ambiguous bare UK taxYear with a hint', async () => {
    const res = await request(buildApp()).get(`${url}?taxYear=2025`)

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/did you mean '2025-26'/)
    expect(mockDb.lotDisposal.findMany).not.toHaveBeenCalled()
  })

  it('accepts a calendar taxYear for US', async () => {
    asJurisdiction('US')
    const res = await request(buildApp()).get(`${url}?taxYear=2025`)

    expect(res.status).toBe(200)
    expect(res.body.taxYearLabel).toBe('2025')
  })

  it('requires exactly one of year and taxYear', async () => {
    const neither = await request(buildApp()).get(url)
    const both = await request(buildApp()).get(
      `${url}?year=2025&taxYear=2025-26`
    )

    expect(neither.status).toBe(400)
    expect(both.status).toBe(400)
  })

  it('names the CSV after the canonical tax-year label', async () => {
    asJurisdiction('AU')
    const res = await request(buildApp()).get(
      `${url}?taxYear=2025-26&format=csv`
    )

    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="tax-report-2025-26.csv"'
    )
  })
})
