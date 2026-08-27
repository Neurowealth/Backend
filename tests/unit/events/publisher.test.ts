/**
 * #316 — publishUserEvent, the single emit path for user-facing domain events.
 *
 * The assertions that matter here are the ones the acceptance criteria turn on:
 *   * one call reaches BOTH the durable stream and the webhook dispatcher
 *   * the socket payload is redacted; the webhook payload is not
 *   * sub-account viewers are resolved by the PUBLISHER from live grants
 *   * a stream failure never costs the webhook leg and never throws
 */

// Config env validation runs at import time; supply the required vars before
// any src import loads src/config/env (same pattern as the other unit tests).
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

import { publishUserEvent } from '../../../src/events/publisher'
import { appendUserEvent } from '../../../src/events/store'
import { broadcastEnvelope } from '../../../src/events/bridge'
import { dispatchWebhookEvent } from '../../../src/services/webhookDispatcher'
import db from '../../../src/db'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/events/store', () => ({
  appendUserEvent: jest.fn(),
}))
jest.mock('../../../src/events/bridge', () => ({
  broadcastEnvelope: jest.fn().mockResolvedValue(0),
  POD_ID: 'test-pod',
}))
jest.mock('../../../src/services/webhookDispatcher', () => ({
  dispatchWebhookEvent: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockDb = db as any
const mockAppend = appendUserEvent as jest.Mock
const mockBroadcast = broadcastEnvelope as jest.Mock
const mockWebhook = dispatchWebhookEvent as jest.Mock

const USER = 'user-1'
const PARENT = 'parent-1'

beforeEach(() => {
  mockDb.subAccount = { findMany: jest.fn().mockResolvedValue([]) }
  let seq = 0
  mockAppend.mockImplementation(async (params: any) => ({
    seq: ++seq,
    topic: params.topic,
    type: params.type,
    payload: params.payload,
    emittedAt: '2026-08-25T00:00:00.000Z',
  }))
})

describe('publishUserEvent', () => {
  it('persists a redacted payload but hands the webhook the original', async () => {
    await publishUserEvent(USER, 'transactions', 'deposit.received', {
      txHash: 'abc',
      amount: '10',
      assetSymbol: 'USDC',
      protocolName: 'Blend',
      network: 'testnet',
      shares: '9',
      // Identity fields an operator's server may see and a browser may not.
      user: 'GWALLETADDRESS',
      userId: USER,
    })

    const stored = mockAppend.mock.calls[0][0]
    expect(stored.payload).toEqual({
      txHash: 'abc',
      amount: '10',
      shares: '9',
      assetSymbol: 'USDC',
      protocolName: 'Blend',
      network: 'testnet',
    })
    expect(stored.payload).not.toHaveProperty('userId')
    expect(stored.payload).not.toHaveProperty('user')

    // The webhook leg is unchanged — an operator endpoint has always needed to
    // know whose event it is.
    expect(mockWebhook).toHaveBeenCalledWith(
      'deposit.received',
      expect.objectContaining({ userId: USER, user: 'GWALLETADDRESS' })
    )
  })

  it('authorises a parent with an ACTIVE VIEW grant at publish time', async () => {
    mockDb.subAccount.findMany.mockResolvedValue([{ parentUserId: PARENT }])

    await publishUserEvent(USER, 'alerts', 'alert_rule.triggered', {
      ruleId: 'rule-1',
      userId: USER,
      metric: 'PROTOCOL_APY',
      observedValue: 4,
    })

    expect(mockDb.subAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          childUserId: USER,
          status: 'ACTIVE',
          permissions: { has: 'VIEW' },
        }),
      })
    )
    expect(mockBroadcast.mock.calls[0][0].authorizedViewers).toEqual([
      USER,
      PARENT,
    ])
  })

  it('fails closed to the owner alone when the grant lookup errors', async () => {
    mockDb.subAccount.findMany.mockRejectedValue(new Error('db down'))

    await publishUserEvent(USER, 'alerts', 'alert_rule.triggered', {
      ruleId: 'rule-1',
    })

    expect(mockBroadcast.mock.calls[0][0].authorizedViewers).toEqual([USER])
  })

  it('fans out to every affected user but dispatches the webhook once', async () => {
    await publishUserEvent(
      ['user-a', 'user-b', 'user-a'],
      'agent',
      'agent.rebalanced',
      { fromProtocol: 'Blend', toProtocol: 'Luma', amount: '5' }
    )

    // Deduplicated — the same user in the batch twice is still one stream write.
    expect(mockAppend).toHaveBeenCalledTimes(2)
    expect(mockWebhook).toHaveBeenCalledTimes(1)
  })

  it('emits socket-only types without touching the webhook channel', async () => {
    await publishUserEvent(USER, 'portfolio', 'portfolio.updated', {
      protocolName: 'Blend',
      positionsAffected: 3,
      reason: 'rebalance',
    })

    expect(mockAppend).toHaveBeenCalledTimes(1)
    expect(mockWebhook).not.toHaveBeenCalled()
  })

  it('honours an explicit webhook:false without skipping the stream', async () => {
    await publishUserEvent(
      USER,
      'alerts',
      'alert_rule.triggered',
      { ruleId: 'rule-1' },
      { webhook: false }
    )

    expect(mockAppend).toHaveBeenCalledTimes(1)
    expect(mockWebhook).not.toHaveBeenCalled()
  })

  it('never throws, and still dispatches the webhook, when the store fails', async () => {
    mockAppend.mockRejectedValue(new Error('stream unavailable'))

    await expect(
      publishUserEvent(USER, 'transactions', 'transaction.confirmed', {
        txHash: 'abc',
        status: 'CONFIRMED',
      })
    ).resolves.toBeUndefined()

    expect(mockWebhook).toHaveBeenCalledTimes(1)
  })

  it('drops an unknown event type to an empty payload rather than passing it through', async () => {
    await publishUserEvent(USER, 'portfolio', 'never.reviewed' as any, {
      secret: 'leak-me',
    })

    expect(mockAppend.mock.calls[0][0].payload).toEqual({})
  })
})
