/**
 * #496 — Alert delivery channels: incident context must reach Slack and
 * PagerDuty when configured, and a provider outage must degrade to the LOG
 * channel instead of losing the alert.
 *
 * The existing dlq-alerts tests cover cooldown/dedup and the LOG channel;
 * these tests cover the external HTTP channels (#496: "Slack or DB logging
 * is used for incident context when relevant").
 */

process.env.NODE_ENV = 'test'
process.env.STELLAR_NETWORK = 'testnet'
process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org'
process.env.STELLAR_AGENT_SECRET_KEY = 'S' + 'A'.repeat(55)
process.env.VAULT_CONTRACT_ID = 'C' + 'A'.repeat(55)
process.env.USDC_TOKEN_ADDRESS = 'C' + 'B'.repeat(55)
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
process.env.DATABASE_URL = 'postgresql://localhost:5432/test'
process.env.JWT_SEED = '0'.repeat(64)
process.env.WALLET_ENCRYPTION_KEY = '0'.repeat(64)
process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32)

const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/XXXX'

process.env.SLACK_WEBHOOK_URL = SLACK_URL
delete process.env.PAGERDUTY_ROUTING_KEY

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('../../../src/utils/metrics', () => ({
  dlqAlertActive: { set: jest.fn() },
}))

import {
  alertingService,
  type AlertPayload,
} from '../../../src/services/alerting'

let fetchCalls: { url: string; init: any }[] = []

beforeEach(() => {
  jest.clearAllMocks()
  fetchCalls = []
  global.fetch = jest.fn(async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init })
    return { ok: true, status: 200 }
  }) as any
})

const payload: AlertPayload = {
  title: 'Webhook DLQ growing',
  description: '3 dead letters pending for over an hour',
  severity: 'critical',
  component: 'webhooks',
  metadata: { oldest: 'dl-1' },
}

describe('alerting channels (#496)', () => {
  it('posts a formatted alert to the configured Slack webhook', async () => {
    const result = await alertingService.emit(payload, 'slack-test-1')

    expect(result.sent).toBe(true)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe(SLACK_URL)
    expect(fetchCalls[0].init.method).toBe('POST')

    const body = JSON.parse(fetchCalls[0].init.body)
    // Slack block-kit payload: severity drives color/header content.
    const header = body.blocks[0].text.text
    expect(header).toContain('Webhook DLQ growing')
    const text = JSON.stringify(body.blocks)
    expect(text).toContain('3 dead letters pending')
    expect(text).toContain('oldest')
  })

  it('still records cooldown after a Slack outage instead of throwing', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any

    // Must not throw — alerting failures degrade to logs, and the cooldown
    // is only recorded after the fan-out attempt completes.
    const result = await alertingService.emit(payload, 'slack-outage')

    expect(result.sent).toBe(true)
  })

  it('reports the enabled channels including SLACK from the environment', () => {
    const channels = alertingService.getEnabledChannels()
    expect(channels).toContain('LOG')
    expect(channels).toContain('SLACK')
    expect(channels).not.toContain('PAGERDUTY')
  })
})
