/**
 * Integration tests — Analytics API routes
 *
 * Covers `/api/analytics/apy-history`, `/api/analytics/user-yield`, and
 * `/api/analytics/protocol-performance` for the success/auth/validation
 * scenarios listed in the linked issue.
 */

jest.mock('../../../src/config/jwt-adapter', () => ({
    JwtAdapter: {
        generateToken: jest.fn().mockResolvedValue('analytics-test-token'),
        validateToken: jest.fn().mockResolvedValue({ id: 'analytics-user' }),
    },
}))

const mockDb = {
    session: {
        findUnique: jest.fn(),
    },
    yieldSnapshot: {
        findMany: jest.fn(),
    },
    position: {
        findMany: jest.fn(),
    },
    protocolRate: {
        findMany: jest.fn(),
    },
    deadLetterEvent: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
    },
}

jest.mock('../../../src/db', () => ({
    __esModule: true,
    default: mockDb,
}))

import request from 'supertest'
import app from '../../../src/index'

const USER_ID = 'user-analytics-1'
const VALID_TOKEN = 'valid-session-token'

function seedValidSession(): void {
    mockDb.session.findUnique.mockResolvedValue({
        token: VALID_TOKEN,
        userId: USER_ID,
        sessionId: 'sess-1',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        walletAddress: 'GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTICSQYY2T4YJJWUDLVXVVU6G',
        network: 'TESTNET',
        user: { id: USER_ID, isActive: true },
    })
}

describe('Analytics routes', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    describe('GET /api/analytics/apy-history', () => {
        it('returns 401 when no token is provided', async () => {
            const res = await request(app).get('/api/analytics/apy-history')

            expect(res.status).toBe(401)
            expect(res.body.error).toBe('Unauthorized')
        })

        it('returns 401 when token does not match any session', async () => {
            mockDb.session.findUnique.mockResolvedValue(null)

            const res = await request(app)
                .get('/api/analytics/apy-history')
                .set('Authorization', 'Bearer invalid-token')

            expect(res.status).toBe(401)
        })

        it('returns 200 with grouped APY points for a valid session', async () => {
            seedValidSession()
            const snapshotAt = new Date('2026-05-01T00:00:00Z')
            mockDb.yieldSnapshot.findMany.mockResolvedValue([
                { snapshotAt, apy: 5.42, positionId: 'pos-1' },
                {
                    snapshotAt: new Date('2026-05-02T00:00:00Z'),
                    apy: 5.5,
                    positionId: 'pos-1',
                },
            ])

            const res = await request(app)
                .get('/api/analytics/apy-history?period=30d')
                .set('Authorization', `Bearer ${VALID_TOKEN}`)

            expect(res.status).toBe(200)
            expect(res.body).toEqual({
                userId: USER_ID,
                period: '30d',
                points: [
                    { date: '2026-05-01', apy: 5.42, positionId: 'pos-1' },
                    { date: '2026-05-02', apy: 5.5, positionId: 'pos-1' },
                ],
            })
        })

        it('defaults to a 30d window when no period is supplied', async () => {
            seedValidSession()
            mockDb.yieldSnapshot.findMany.mockResolvedValue([])

            const res = await request(app)
                .get('/api/analytics/apy-history')
                .set('Authorization', `Bearer ${VALID_TOKEN}`)

            expect(res.status).toBe(200)
            expect(res.body.period).toBe('30d')
            expect(Array.isArray(res.body.points)).toBe(true)
        })

        it('returns 400 for an invalid period value', async () => {
            seedValidSession()

            const res = await request(app)
                .get('/api/analytics/apy-history?period=42d')
                .set('Authorization', `Bearer ${VALID_TOKEN}`)

            expect(res.status).toBe(400)
            expect(res.body.error).toBe('Validation error')
            expect(res.body.details).toBeDefined()
        })
    })

    describe('GET /api/analytics/user-yield', () => {
        it('returns 401 when no token is provided', async () => {
            const res = await request(app).get('/api/analytics/user-yield')

            expect(res.status).toBe(401)
        })

        it('aggregates totals, period yield, and average APY for the user', async () => {
            seedValidSession()
            mockDb.position.findMany.mockResolvedValue([
                { yieldEarned: 100, assetSymbol: 'USDC' },
                { yieldEarned: 50, assetSymbol: 'XLM' },
            ])
            mockDb.yieldSnapshot.findMany.mockResolvedValue([
                {
                    snapshotAt: new Date('2026-05-01T00:00:00Z'),
                    yieldAmount: 10,
                    apy: 5,
                },
                {
                    snapshotAt: new Date('2026-05-02T00:00:00Z'),
                    yieldAmount: 15,
                    apy: 7,
                },
            ])

            const res = await request(app)
                .get('/api/analytics/user-yield?period=7d')
                .set('Authorization', `Bearer ${VALID_TOKEN}`)

            expect(res.status).toBe(200)
            expect(res.body).toEqual({
                userId: USER_ID,
                period: '7d',
                totalYield: 150,
                periodYield: 25,
                averageApy: 6,
                points: [
                    { date: '2026-05-01', yieldAmount: 10, apy: 5 },
                    { date: '2026-05-02', yieldAmount: 15, apy: 7 },
                ],
            })
        })

        it('returns averageApy = 0 when no snapshots exist (no NaN leak)', async () => {
            seedValidSession()
            mockDb.position.findMany.mockResolvedValue([])
            mockDb.yieldSnapshot.findMany.mockResolvedValue([])

            const res = await request(app)
                .get('/api/analytics/user-yield')
                .set('Authorization', `Bearer ${VALID_TOKEN}`)

            expect(res.status).toBe(200)
            expect(res.body.averageApy).toBe(0)
            expect(res.body.totalYield).toBe(0)
            expect(res.body.periodYield).toBe(0)
        })

        it('returns 400 for an invalid period value', async () => {
            seedValidSession()

            const res = await request(app)
                .get('/api/analytics/user-yield?period=year')
                .set('Authorization', `Bearer ${VALID_TOKEN}`)

            expect(res.status).toBe(400)
            expect(res.body.error).toBe('Validation error')
        })
    })

    describe('GET /api/analytics/protocol-performance', () => {
        it('does not require authentication', async () => {
            mockDb.protocolRate.findMany.mockResolvedValue([])

            const res = await request(app).get(
                '/api/analytics/protocol-performance',
            )

            expect(res.status).toBe(200)
            expect(res.body).toEqual({ period: '30d', protocols: [] })
        })

        it('groups rates by protocol/asset/network with graph-ready points', async () => {
            mockDb.protocolRate.findMany.mockResolvedValue([
                {
                    protocolName: 'blend',
                    assetSymbol: 'USDC',
                    network: 'TESTNET',
                    supplyApy: 4.5,
                    tvl: 1_000_000,
                    fetchedAt: new Date('2026-05-01T00:00:00Z'),
                },
                {
                    protocolName: 'blend',
                    assetSymbol: 'USDC',
                    network: 'TESTNET',
                    supplyApy: 4.8,
                    tvl: 1_100_000,
                    fetchedAt: new Date('2026-05-02T00:00:00Z'),
                },
                {
                    protocolName: 'aquarius',
                    assetSymbol: 'XLM',
                    network: 'TESTNET',
                    supplyApy: 3.1,
                    tvl: null,
                    fetchedAt: new Date('2026-05-01T00:00:00Z'),
                },
            ])

            const res = await request(app).get(
                '/api/analytics/protocol-performance?period=90d',
            )

            expect(res.status).toBe(200)
            expect(res.body.period).toBe('90d')
            expect(res.body.protocols).toHaveLength(2)

            const blend = res.body.protocols.find(
                (p: any) => p.protocol === 'blend',
            )
            expect(blend).toBeDefined()
            expect(blend.points).toEqual([
                { date: '2026-05-01', apy: 4.5, tvl: 1_000_000 },
                { date: '2026-05-02', apy: 4.8, tvl: 1_100_000 },
            ])

            const aquarius = res.body.protocols.find(
                (p: any) => p.protocol === 'aquarius',
            )
            expect(aquarius.points[0]).toEqual({
                date: '2026-05-01',
                apy: 3.1,
                tvl: null,
            })
        })

        it('returns 400 for an invalid period value', async () => {
            const res = await request(app).get(
                '/api/analytics/protocol-performance?period=1y',
            )

            expect(res.status).toBe(400)
            expect(res.body.error).toBe('Validation error')
        })
    })

    describe('Response schema sanity', () => {
        it('apy-history response includes the documented fields', async () => {
            seedValidSession()
            mockDb.yieldSnapshot.findMany.mockResolvedValue([])

            const res = await request(app)
                .get('/api/analytics/apy-history')
                .set('Authorization', `Bearer ${VALID_TOKEN}`)

            expect(res.body).toHaveProperty('userId')
            expect(res.body).toHaveProperty('period')
            expect(res.body).toHaveProperty('points')
        })

        it('user-yield response includes the documented fields', async () => {
            seedValidSession()
            mockDb.position.findMany.mockResolvedValue([])
            mockDb.yieldSnapshot.findMany.mockResolvedValue([])

            const res = await request(app)
                .get('/api/analytics/user-yield')
                .set('Authorization', `Bearer ${VALID_TOKEN}`)

            expect(res.body).toMatchObject({
                userId: expect.any(String),
                period: expect.any(String),
                totalYield: expect.any(Number),
                averageApy: expect.any(Number),
                points: expect.any(Array),
            })
        })

        it('protocol-performance response includes the documented fields', async () => {
            mockDb.protocolRate.findMany.mockResolvedValue([])

            const res = await request(app).get(
                '/api/analytics/protocol-performance',
            )

            expect(res.body).toMatchObject({
                period: expect.any(String),
                protocols: expect.any(Array),
            })
        })
    })
})
