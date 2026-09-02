// #345 — breaker service status surfaces: user-facing status must never leak
// another user's (or any protocol's) breaker details, and the GLOBAL state is
// exposed in plain language only.
import {
  getBreakerStatusForUser,
  getBreakerStatusSummary,
} from '../../../src/agent/breakerService'

jest.mock('../../../src/db', () => {
  const mockFindMany = jest.fn()
  const client: any = {
    agentCircuitBreaker: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
  }
  return {
    __esModule: true,
    default: client,
    __mockFindMany: mockFindMany,
  }
})

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('../../../src/events/publisher', () => ({
  publishUserEvent: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/services/alerting', () => ({
  alertingService: { emit: jest.fn().mockResolvedValue(undefined) },
}))
jest.mock('../../../src/utils/metrics', () => ({
  setAgentBreakerState: jest.fn(),
  recordAgentBreakerTrip: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const dbMock = require('../../../src/db')
const mockFindMany: jest.Mock = dbMock.__mockFindMany

describe('breakerService status surfaces', () => {
  beforeEach(() => {
    mockFindMany.mockReset()
  })

  describe('getBreakerStatusForUser', () => {
    it('reports only the calling user plus the GLOBAL state', async () => {
      mockFindMany.mockResolvedValue([
        {
          id: 'g',
          scope: 'GLOBAL',
          scopeKey: '',
          state: 'OPEN',
          trippedRule: 'stale_data',
        },
        {
          id: 'p',
          scope: 'PROTOCOL',
          scopeKey: 'protocol-b',
          state: 'OPEN',
          trippedRule: 'abnormal_loss',
        },
        {
          id: 'u-other',
          scope: 'USER',
          scopeKey: 'user-other',
          state: 'OPEN',
          trippedRule: 'oscillation',
        },
        {
          id: 'u-a',
          scope: 'USER',
          scopeKey: 'user-a',
          state: 'HALF_OPEN',
          trippedRule: 'abnormal_loss',
        },
        {
          id: 'u-a-closed',
          scope: 'USER',
          scopeKey: 'user-a',
          state: 'CLOSED',
          trippedRule: null,
        },
      ])

      const status = await getBreakerStatusForUser('user-a')

      // GLOBAL + the user's own breaker, plain language only.
      expect(status).toEqual({
        global: 'stale_data',
        affectingYou: ['rebalancing paused for your account: abnormal_loss'],
      })
      const serialized = JSON.stringify(status)
      expect(serialized).not.toContain('user-other')
      expect(serialized).not.toContain('protocol-b')
      expect(serialized).not.toContain('oscillation')
    })

    it('reports nothing when no open breaker applies', async () => {
      mockFindMany.mockResolvedValue([
        {
          id: 'g',
          scope: 'GLOBAL',
          scopeKey: '',
          state: 'CLOSED',
          trippedRule: null,
        },
        {
          id: 'u-a',
          scope: 'USER',
          scopeKey: 'user-a',
          state: 'CLOSED',
          trippedRule: null,
        },
      ])
      await expect(getBreakerStatusForUser('user-a')).resolves.toEqual({
        global: null,
        affectingYou: [],
      })
    })
  })

  describe('getBreakerStatusSummary', () => {
    it('returns a closed (null) global summary before any tick', () => {
      expect(getBreakerStatusSummary()).toEqual({ global: null })
    })
  })

  describe('withdrawal independence (#345 acceptance criterion)', () => {
    it('breaker code never gates or imports the withdrawal/outbox path', () => {
      const fs = require('node:fs')
      const path = require('node:path')
      const fixtureDir = path.join(__dirname, '../../../src')

      const breakerSource = fs.readFileSync(
        path.join(fixtureDir, 'agent/breakerService.ts'),
        'utf8'
      )
      // A documented reference to the outbox loop gate is expected in the
      // header comment; only a real import would couple the breaker to it.
      const codeOnly = breakerSource.replace(/\/\*[\s\S]*?\*\//g, '')

      expect(codeOnly).not.toMatch(/from '.*\boutbox\b/)
      expect(codeOnly).not.toMatch(/from '.*\bwithdraw\b/)
      expect(codeOnly).not.toContain('isUserHalted')
    })
  })
})
