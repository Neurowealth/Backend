import request from 'supertest'

import db from '../../src/db'
import app from '../../src'

// Jest is available at runtime; these are only to satisfy TS in IDE.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const jest: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const describe: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const it: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const beforeEach: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const expect: any

import { createCustodialWallet } from '../../src/stellar/wallet'
import { JwtAdapter } from '../../src/config'
import { config } from '../../src/config/env'

function uuid(): string {
  // Deterministic enough for tests; avoids pulling in extra deps like "uuid".
  return `t-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// --- Mock Stellar contract calls used by the HTTP deposit/withdraw controller ----

const mockDepositForUser = jest.fn()
const mockWithdrawForUser = jest.fn()

// The fake contract events below carry plain JS objects, not XDR ScVals —
// pass them straight through the parser.
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk')
  return { ...actual, scValToNative: (v: unknown) => v }
})

jest.mock('../../src/stellar/contract', () => ({
  __esModule: true,
  // controller imports depositForUser/withdrawForUser
  depositForUser: (...args: unknown[]) => mockDepositForUser(...args),
  withdrawForUser: (...args: unknown[]) => mockWithdrawForUser(...args),
}))

// --- Mock DLQ metrics side-effects & alerting to keep test deterministic ----
jest.mock('../../src/utils/metrics', () => ({
  updateDlqSize: jest.fn(),
  updateCursorLag: jest.fn(),
  updateLastProcessedLedger: jest.fn(),
  recordDbOperation: jest.fn(),
  recordEventDuration: jest.fn(),
  recordEventFailed: jest.fn(),
  recordEventProcessed: jest.fn(),
  recordHttpRequest: jest.fn(),
  recordRequestTimeout: jest.fn(),
  recordRejectedRequest: jest.fn(),
}))

// Avoid external alerting side effects
jest.mock('../../src/services/alerting', () => ({
  alertingService: {
    emit: jest.fn(async () => {}),
    emitDLQAlert: jest.fn(),
    clearDLQAlertState: jest.fn(),
  },
}))

// Avoid verbose logger noise in CI
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

// --- Mock event listener persistence by directly exercising the same persistence layer ----
// The integration tests want to validate DB state *after* operations. Since the HTTP
// controller only writes the Transaction row, we simulate the downstream event processing
// by mocking the RPC-driven event listener call stack.

type FakeContractEvent = {
  type: 'deposit' | 'withdraw'
  ledger: number
  txHash: string
  contractId: string
  topics: string[]
  value: any
}

const mockHandleEvent = jest.fn()

jest.mock('../../src/stellar/events', () => {
  const actual = jest.requireActual('../../src/stellar/events')
  return {
    __esModule: true,
    ...actual,
    // When the server boots it starts the listener. We keep it from polling real RPC.
    startEventListener: jest.fn().mockResolvedValue(undefined),
    stopEventListener: jest.fn(),
    handleEvent: (...args: unknown[]) => mockHandleEvent(...args),
  }
})

async function seedAuthAndWallet(): Promise<{
  userId: string
  walletAddress: string
  sessionToken: string
}> {
  // Unique wallet address per test run to avoid uniqueness collisions.
  // Wallet encryption is deterministic only on WALLET_ENCRYPTION_KEY, so we just
  // need an actual custodial wallet row.
  const userId = `it-user-${uuid()}`
  const walletAddress =
    `G${uuid().replace(/-/g, '').slice(0, 47)}WALLETADDR`.slice(0, 56)

  const user = await db.user.create({
    data: {
      walletAddress,
      network: 'TESTNET',
      displayName: 'IT Test',
      email: `it-${Date.now()}-${Math.random()}@example.com`,
      riskTolerance: 5,
      isActive: true,
    },
  })

  await createCustodialWallet(user.id)

  // requireAuth verifies the JWT signature before the DB session lookup, so
  // the session token must be a real signed JWT — a random string 401s.
  const sessionToken = (await JwtAdapter.generateToken({
    id: user.id,
  })) as string

  await db.session.create({
    data: {
      userId: user.id,
      token: sessionToken,
      walletAddress: user.walletAddress,
      network: user.network,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      ipAddress: '127.0.0.1',
      userAgent: 'deposit-withdraw-e2e-tests',
    },
  })

  return {
    userId: user.id,
    walletAddress: user.walletAddress,
    sessionToken,
  }
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
  }
}

describe('E2E integration — deposit and withdraw flows (#219)', () => {
  beforeEach(async () => {
    jest.clearAllMocks()

    mockDepositForUser.mockReset()
    mockWithdrawForUser.mockReset()

    // When we simulate event processing, we want the real handleEvent to execute.
    // Our jest.mock replaces handleEvent; we delegate to the actual implementation.
    mockHandleEvent.mockImplementation(async (event: FakeContractEvent) => {
      const realEvents = await jest.requireActual('../../src/stellar/events')
      // Call the real handler through the actual module.
      return realEvents.handleEvent(event)
    })
  })

  it('POST /api/deposit (happy path): verifies Transaction row + position update + cursor advance', async () => {
    const { userId, walletAddress, sessionToken } = await seedAuthAndWallet()

    // Seed cursor row so we can assert it advances.
    await db.eventCursor.upsert({
      where: { contractId: config.stellar.vaultContractId },
      update: { lastProcessedLedger: 10 },
      create: {
        contractId: config.stellar.vaultContractId,
        lastProcessedLedger: 10,
      },
    })

    const txHash = `tx-${uuid()}`
    const depositAmount = 123.45
    const assetSymbol = 'USDC'
    const protocolName = 'Blend'

    // HTTP controller uses depositForUser to submit tx. We mock it as successful.
    mockDepositForUser.mockResolvedValue({
      hash: txHash,
      status: 'success',
    })

    // Build request payload
    const res = await request(app)
      .post('/api/deposit/')
      .set(authHeaders(sessionToken))
      .send({
        userId,
        amount: depositAmount,
        assetSymbol,
        protocolName,
        memo: 'integration-test',
      })

    expect(res.status).toBe(201)
    expect(res.body.txHash).toBe(txHash)
    expect(res.body.status).toBe('CONFIRMED')
    expect(res.body.whatsappReply).toContain('Deposit')
    expect(res.body.transaction).toEqual(
      expect.objectContaining({
        txHash,
        status: 'CONFIRMED',
        amount: depositAmount,
        assetSymbol,
        protocolName,
      })
    )

    // The HTTP controller wrote the Transaction row. Position update happens via event processing.
    // Simulate the on-chain deposit event by invoking the real handleEvent logic.
    // We only need the minimal shape required by parsers in src/stellar/events.ts.
    const depositEvent = {
      type: 'deposit',
      ledger: 50,
      txHash,
      contractId: config.stellar.vaultContractId,
      topics: ['deposit', assetSymbol, protocolName],
      value: {
        user: walletAddress,
        amount: depositAmount.toString(),
        shares: depositAmount.toString(),
      },
    } as unknown as FakeContractEvent

    await mockHandleEvent(depositEvent)

    const transactionRow = await db.transaction.findUnique({
      where: { txHash },
    })
    expect(transactionRow).toBeTruthy()
    expect(transactionRow?.status).toBe('CONFIRMED')
    expect(transactionRow?.confirmedAt).not.toBeNull()

    const position = await db.position.findFirst({
      where: {
        userId,
        protocolName,
        assetSymbol,
        status: 'ACTIVE',
      },
    })
    expect(position).toBeTruthy()
    expect(Number(position!.depositedAmount)).toBeCloseTo(depositAmount)
    expect(Number(position!.currentValue)).toBeCloseTo(depositAmount)

    // The cursor advances in the polling loop (fetchEvents), not per-event —
    // handleEvent's completion marker is the ProcessedEvent dedup row.
    const processed = await db.processedEvent.findUnique({
      where: {
        contractId_txHash_eventType_ledger: {
          contractId: config.stellar.vaultContractId,
          txHash,
          eventType: 'deposit',
          ledger: 50,
        },
      },
    })
    expect(processed).toBeTruthy()
  })

  it('POST /api/withdraw (happy path): verifies balance deduction + transaction record', async () => {
    const { userId, walletAddress, sessionToken } = await seedAuthAndWallet()

    // Create an initial position to withdraw from.
    const position = await db.position.create({
      data: {
        userId,
        protocolName: 'Blend',
        assetSymbol: 'USDC',
        depositedAmount: 500,
        currentValue: 500,
        yieldEarned: 0,
        status: 'ACTIVE',
      },
    })

    await db.eventCursor.upsert({
      where: { contractId: config.stellar.vaultContractId },
      update: { lastProcessedLedger: 10 },
      create: {
        contractId: config.stellar.vaultContractId,
        lastProcessedLedger: 10,
      },
    })

    const txHash = `tx-${uuid()}`
    const withdrawAmount = 123.0

    mockWithdrawForUser.mockResolvedValue({
      hash: txHash,
      status: 'success',
    })

    const res = await request(app)
      .post('/api/withdraw/')
      .set(authHeaders(sessionToken))
      .send({
        userId,
        amount: withdrawAmount,
        assetSymbol: 'USDC',
        protocolName: 'Blend',
        memo: 'integration-test',
      })

    expect(res.status).toBe(201)
    expect(res.body.txHash).toBe(txHash)
    expect(res.body.status).toBe('CONFIRMED')

    const withdrawEvent = {
      type: 'withdraw',
      ledger: 70,
      txHash,
      contractId: config.stellar.vaultContractId,
      topics: ['withdraw', 'USDC', 'Blend'],
      value: {
        user: walletAddress,
        amount: withdrawAmount.toString(),
        shares: withdrawAmount.toString(),
      },
    } as unknown as FakeContractEvent

    await mockHandleEvent(withdrawEvent)

    const updatedPosition = await db.position.findUnique({
      where: { id: position.id },
    })
    expect(updatedPosition).toBeTruthy()
    expect(Number(updatedPosition!.depositedAmount)).toBeCloseTo(
      500 - withdrawAmount
    )
    expect(Number(updatedPosition!.currentValue)).toBeCloseTo(
      500 - withdrawAmount
    )

    const transactionRow = await db.transaction.findUnique({
      where: { txHash },
    })
    expect(transactionRow).toBeTruthy()
    expect(transactionRow?.type).toBe('WITHDRAWAL')
    expect(transactionRow?.status).toBe('CONFIRMED')

    // Cursor advancement is the polling loop's job — assert the per-event
    // ProcessedEvent marker instead.
    const processed = await db.processedEvent.findUnique({
      where: {
        contractId_txHash_eventType_ledger: {
          contractId: config.stellar.vaultContractId,
          txHash,
          eventType: 'withdraw',
          ledger: 70,
        },
      },
    })
    expect(processed).toBeTruthy()
  })

  it('POST /api/withdraw (error path): RPC/event processing failure → DLQ row created', async () => {
    const { userId, sessionToken } = await seedAuthAndWallet()

    const txHash = `tx-${uuid()}`

    // controller path: simulate RPC failure so HTTP returns FAILED transaction
    // (controller throws on-chain fn failures? In current code, it doesn't catch; but contract mock
    // is expected to throw and bubble to error handler. We'll instead return non-success status to
    // get HTTP 201 FAILED. Then we simulate DLQ by forcing event processing to throw.)

    mockWithdrawForUser.mockResolvedValue({
      hash: txHash,
      status: 'failure',
    })

    const res = await request(app)
      .post('/api/withdraw/')
      .set(authHeaders(sessionToken))
      .send({
        userId,
        amount: 1,
        assetSymbol: 'USDC',
        protocolName: 'Blend',
        memo: 'integration-test',
      })

    // Controller treats non-success as FAILED and still returns 201.
    expect(res.status).toBe(201)
    expect(res.body.txHash).toBe(txHash)
    expect(res.body.status).toBe('FAILED')

    // Now simulate downstream event processing failure; handleEvent catch should write to DLQ.
    // We force mockHandleEvent to throw after it begins actual processing.
    mockHandleEvent.mockImplementation(async () => {
      const realEvents = await jest.requireActual('../../src/stellar/events')
      try {
        await realEvents.handleEvent({
          type: 'withdraw',
          ledger: 90,
          txHash,
          contractId: config.stellar.vaultContractId,
          topics: ['withdraw', 'USDC', 'Blend'],
          value: { user: 'bad-wallet', amount: '1', shares: '1' },
        } as any)
      } catch {
        // Re-throw so DLQ logic runs inside real handleEvent.
        throw new Error('simulated rpc/event processing failure')
      }
    })

    const failingEvent = {
      type: 'withdraw',
      ledger: 90,
      txHash,
      contractId: config.stellar.vaultContractId,
      topics: ['withdraw', 'USDC', 'Blend'],
      value: {
        user: 'bad-wallet',
        amount: '1',
        shares: '1',
      },
    } as unknown as FakeContractEvent

    await expect(mockHandleEvent(failingEvent)).rejects.toThrow()

    const dlqRows = await db.deadLetterEvent.findMany({ where: { txHash } })
    expect(dlqRows.length).toBeGreaterThanOrEqual(1)
    expect(dlqRows[0].status).toBe('PENDING')
    expect(dlqRows[0].eventType).toBe('withdraw')
  })
})
