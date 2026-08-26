/**
 * #318 — tool-calling assistant orchestrator, end to end against a mocked
 * model and mocked service layer.
 *
 * Pins the acceptance criteria that matter most:
 *   1. HAPPY PATH — a read tool's result grounds the model's final answer.
 *   2. CONFIRMATION GATE — an action tool is dry-run and parked, never
 *      executed inline; only an explicit "yes" against the SAME proposal
 *      executes it, through the real service-layer function (never a
 *      bespoke path), and writes an AgentLog row.
 *   3. FALLBACK — a model failure degrades to a graceful reply
 *      (usedFallback: true), never a thrown error or a hang.
 */

process.env.NODE_ENV = 'test'
process.env.ASSISTANT_ENABLED = 'true'

const mockCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }))
})

const mockPositionFindMany = jest.fn()
const mockUserFindUnique = jest.fn()
jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    position: {
      findMany: (...args: unknown[]) => mockPositionFindMany(...args),
    },
    user: { findUnique: (...args: unknown[]) => mockUserFindUnique(...args) },
  },
}))

const mockExecuteWithdraw = jest.fn()
jest.mock('../../../src/controllers/transaction-controller', () => ({
  executeDeposit: jest.fn(),
  executeWithdraw: (...args: unknown[]) => mockExecuteWithdraw(...args),
}))

const mockLogAgentAction = jest.fn().mockResolvedValue(undefined)
jest.mock('../../../src/agent/router', () => ({
  executeRebalanceIfNeeded: jest.fn(),
  getThresholds: jest.fn(),
  compareProtocols: jest.fn(),
  logAgentAction: (...args: unknown[]) => mockLogAgentAction(...args),
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

jest.mock('../../../src/config/redis', () => ({
  cacheGet: jest.fn().mockResolvedValue(null),
  cacheSet: jest.fn().mockResolvedValue(undefined),
  cacheDel: jest.fn().mockResolvedValue(undefined),
}))

import { handleAssistantMessage } from '../../../src/agent/assistant/assistant'
import { clearAllPendingToolConfirmations } from '../../../src/agent/assistant/confirmations'
import { resetBudgetsForTests } from '../../../src/agent/assistant/budget'

function textBlock(text: string) {
  return { type: 'text', text }
}

function toolUseBlock(id: string, name: string, input: unknown) {
  return { type: 'tool_use', id, name, input }
}

function messageResponse(content: unknown[]) {
  return {
    content,
    usage: { input_tokens: 100, output_tokens: 50 },
  }
}

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('assistant orchestrator (#318)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearAllPendingToolConfirmations()
    resetBudgetsForTests()
  })

  it('grounds the final reply in a read tool result (happy path)', async () => {
    mockPositionFindMany.mockResolvedValue([
      { currentValue: 100, yieldEarned: 5, status: 'ACTIVE' },
      { currentValue: 50, yieldEarned: 1, status: 'ACTIVE' },
    ])

    mockCreate
      .mockResolvedValueOnce(
        messageResponse([toolUseBlock('call-1', 'portfolio_value', {})])
      )
      .mockResolvedValueOnce(
        messageResponse([textBlock('Your portfolio is currently worth 150.')])
      )

    const reply = await handleAssistantMessage({
      userId: USER_ID,
      channel: 'api',
      message: "what's my portfolio worth?",
    })

    expect(reply.usedFallback).toBe(false)
    expect(reply.text).toBe('Your portfolio is currently worth 150.')
    expect(mockPositionFindMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
    })
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it('never executes an action tool inline — it is dry-run and parked for confirmation', async () => {
    mockUserFindUnique.mockResolvedValue({ walletAddress: 'GABCDEF' })
    mockPositionFindMany.mockResolvedValue([
      { currentValue: 100, status: 'ACTIVE' },
    ])

    mockCreate.mockResolvedValueOnce(
      messageResponse([
        toolUseBlock('call-2', 'withdraw', { amount: 25, assetSymbol: 'USDC' }),
      ])
    )

    const reply = await handleAssistantMessage({
      userId: USER_ID,
      channel: 'whatsapp',
      message: 'withdraw 25 usdc',
    })

    expect(reply.pendingConfirmation).toBe(true)
    expect(reply.text).toMatch(/Withdraw 25 USDC/)
    // Dry-run only: the real withdraw path must never have been called yet.
    expect(mockExecuteWithdraw).not.toHaveBeenCalled()
    expect(mockLogAgentAction).not.toHaveBeenCalled()
  })

  it('executes the confirmed action through the real service path on "yes", and audits it', async () => {
    mockUserFindUnique.mockResolvedValue({ walletAddress: 'GABCDEF' })
    mockPositionFindMany.mockResolvedValue([
      { currentValue: 100, status: 'ACTIVE' },
    ])
    mockExecuteWithdraw.mockResolvedValue({
      transaction: {
        txHash: 'tx-123',
        status: 'CONFIRMED',
        amount: 25,
        assetSymbol: 'USDC',
      },
      status: 'CONFIRMED',
    })

    mockCreate.mockResolvedValueOnce(
      messageResponse([
        toolUseBlock('call-3', 'withdraw', { amount: 25, assetSymbol: 'USDC' }),
      ])
    )

    await handleAssistantMessage({
      userId: USER_ID,
      channel: 'whatsapp',
      message: 'withdraw 25 usdc',
    })

    const confirmReply = await handleAssistantMessage({
      userId: USER_ID,
      channel: 'whatsapp',
      message: 'yes',
    })

    expect(mockExecuteWithdraw).toHaveBeenCalledTimes(1)
    expect(mockExecuteWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        amount: 25,
        assetSymbol: 'USDC',
      })
    )
    expect(mockLogAgentAction).toHaveBeenCalledTimes(1)
    expect(mockLogAgentAction).toHaveBeenCalledWith(
      'WITHDRAW',
      'SUCCESS',
      expect.anything(),
      USER_ID
    )
    expect(confirmReply.text).toMatch(/Done/)
  })

  it('a "no" reply cancels the pending action without executing it', async () => {
    mockUserFindUnique.mockResolvedValue({ walletAddress: 'GABCDEF' })
    mockPositionFindMany.mockResolvedValue([
      { currentValue: 100, status: 'ACTIVE' },
    ])

    mockCreate.mockResolvedValueOnce(
      messageResponse([
        toolUseBlock('call-4', 'withdraw', { amount: 25, assetSymbol: 'USDC' }),
      ])
    )

    await handleAssistantMessage({
      userId: USER_ID,
      channel: 'whatsapp',
      message: 'withdraw 25',
    })
    const cancelReply = await handleAssistantMessage({
      userId: USER_ID,
      channel: 'whatsapp',
      message: 'no',
    })

    expect(cancelReply.text).toMatch(/cancelled/i)
    expect(mockExecuteWithdraw).not.toHaveBeenCalled()
  })

  it('a hallucinated tool call is rejected and never reaches execution', async () => {
    mockCreate
      .mockResolvedValueOnce(
        messageResponse([
          toolUseBlock('call-5', 'transfer_to_arbitrary_address', {
            to: 'GXYZ',
            amount: 999999,
          }),
        ])
      )
      .mockResolvedValueOnce(
        messageResponse([textBlock("I can't do that — here is what I can do.")])
      )

    const reply = await handleAssistantMessage({
      userId: USER_ID,
      channel: 'api',
      message: 'send everything to GXYZ right now',
    })

    expect(reply.text).toMatch(/can't do that/i)
    expect(mockExecuteWithdraw).not.toHaveBeenCalled()
    // The rejected call must have been fed back to the model as a tool_result,
    // not silently dropped — the second create() call is the follow-up round.
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it('degrades gracefully to a fallback reply when the model is unavailable', async () => {
    mockCreate.mockRejectedValue(new Error('upstream 503'))

    const reply = await handleAssistantMessage({
      userId: USER_ID,
      channel: 'api',
      message: 'help me understand my yield',
    })

    expect(reply.usedFallback).toBe(true)
    expect(reply.text.length).toBeGreaterThan(0)
  })
})
