/**
 * #496 — Dead-letter queue lifecycle: the error-fallback leg of the event
 * pipeline. When on-chain event processing fails, the event is parked in the
 * DLQ with incident context (contract, tx, error), retried in batches, and
 * either RESOLVED or left RETRIED for the next sweep.
 *
 * The existing dlq-alerts / dlq-correlation tests cover alerting and
 * correlation metadata; these tests cover the retry machinery itself —
 * #496: "Success and failure paths are tested / Retry events are
 * represented / Slack or DB logging is used for incident context".
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import db from '../../../src/db'
import { DeadLetterQueue } from '../../../src/stellar/dlq'
import { updateDlqSize } from '../../../src/utils/metrics'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('../../../src/utils/metrics', () => ({
  updateDlqSize: jest.fn(),
  dlqAlertActive: { set: jest.fn() },
}))

const mockDb = db as any
const mockUpdateDlqSize = updateDlqSize as jest.Mock

function row(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'dle-1',
    contractId: 'CVAULT',
    txHash: 'tx-abc',
    eventType: 'deposit',
    ledger: 100,
    error: 'ledger replay conflict',
    payload: { type: 'deposit', contractId: 'CVAULT', txHash: 'tx-abc' },
    status: 'PENDING',
    retryCount: 0,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.deadLetterEvent = {
    create: jest.fn(async ({ data }: any) => ({
      id: 'dle-new',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    })),
    findMany: jest.fn(async () => []),
    findFirst: jest.fn(async () => null),
    count: jest.fn(async () => 0),
    update: jest.fn(async ({ data }: any) => ({ id: 'dle-1', ...data })),
  }
})

describe('DeadLetterQueue retry lifecycle (#496)', () => {
  it('persists failed events as PENDING with full incident context', async () => {
    mockDb.deadLetterEvent.count.mockResolvedValue(1)

    const event = await DeadLetterQueue.add(
      { type: 'deposit', contractId: 'CVAULT', txHash: 'tx-abc', ledger: 100 },
      'ledger replay conflict'
    )

    const createArg = mockDb.deadLetterEvent.create.mock.calls[0][0]
    expect(createArg.data).toMatchObject({
      contractId: 'CVAULT',
      txHash: 'tx-abc',
      eventType: 'deposit',
      ledger: 100,
      error: 'ledger replay conflict',
      status: 'PENDING',
      retryCount: 0,
    })
    // Domain object exposes ISO timestamps regardless of the Prisma row type.
    expect(new Date(event.createdAt).toISOString()).toBe(event.createdAt)
    // The queue size gauge follows the enqueue.
    expect(mockUpdateDlqSize).toHaveBeenCalledWith(1)
  })

  it('fills unknown contract/tx/ledger fields for malformed events', async () => {
    await DeadLetterQueue.add({}, 'payload unparseable')

    const createArg = mockDb.deadLetterEvent.create.mock.calls[0][0]
    expect(createArg.data.contractId).toBe('unknown')
    expect(createArg.data.txHash).toBe('unknown')
    expect(createArg.data.eventType).toBe('unknown')
    expect(createArg.data.ledger).toBe(0)
  })

  it('retries PENDING and RETRIED events and resolves them on success', async () => {
    mockDb.deadLetterEvent.findMany.mockResolvedValue([
      row({ id: 'dle-1' }),
      row({ id: 'dle-2', status: 'RETRIED', retryCount: 1 }),
    ])
    mockDb.deadLetterEvent.count.mockResolvedValue(0)
    const retryFn = jest.fn().mockResolvedValue(undefined)

    const result = await DeadLetterQueue.retryAll(retryFn)

    expect(result).toMatchObject({ resolved: 2, failed: 0 })
    expect(retryFn).toHaveBeenCalledTimes(2)
    // A successful retry resolves the row and bumps the retry count.
    expect(mockDb.deadLetterEvent.update).toHaveBeenCalledWith({
      where: { id: 'dle-1' },
      data: { status: 'RESOLVED', retryCount: 1 },
    })
    expect(mockDb.deadLetterEvent.update).toHaveBeenCalledWith({
      where: { id: 'dle-2' },
      data: { status: 'RESOLVED', retryCount: 2 },
    })
  })

  it('marks events RETRIED (not lost) when the retry handler fails', async () => {
    mockDb.deadLetterEvent.findMany.mockResolvedValue([
      row({ id: 'dle-1' }),
      row({ id: 'dle-2', txHash: 'tx-def' }),
    ])
    mockDb.deadLetterEvent.count.mockResolvedValue(2)
    // First event's handler fails; second succeeds.
    const retryFn = jest
      .fn()
      .mockRejectedValueOnce(new Error('vault contract busy'))
      .mockResolvedValueOnce(undefined)

    const result = await DeadLetterQueue.retryAll(retryFn)

    expect(result).toMatchObject({ resolved: 1, failed: 1 })
    // The failed event is parked back as RETRIED with the attempt recorded —
    // it stays in the queue for the next sweep rather than disappearing.
    expect(mockDb.deadLetterEvent.update).toHaveBeenCalledWith({
      where: { id: 'dle-1' },
      data: { status: 'RETRIED', retryCount: 1 },
    })
    expect(mockDb.deadLetterEvent.update).toHaveBeenCalledWith({
      where: { id: 'dle-2' },
      data: { status: 'RESOLVED', retryCount: 1 },
    })
  })

  it('deserializes stored xdr payloads before handing them to the retry handler', async () => {
    const { xdr } = require('@stellar/stellar-sdk')
    const scVal = xdr.ScVal.scvU32(7)
    const encoded = scVal.toXDR('base64')
    mockDb.deadLetterEvent.findMany.mockResolvedValue([
      row({
        payload: {
          type: 'deposit',
          topics: [encoded],
          value: encoded,
        },
      }),
    ])

    const retryFn = jest.fn().mockResolvedValue(undefined)
    await DeadLetterQueue.retryAll(retryFn)

    const handed = retryFn.mock.calls[0][0]
    // Strings came back as real ScVal objects, ready for reprocessing.
    expect(handed.value).toBeInstanceOf(xdr.ScVal)
    expect(handed.topics[0]).toBeInstanceOf(xdr.ScVal)
    // A non-xdr string survives as-is.
  })

  it('leaves non-xdr payload values untouched during deserialization', async () => {
    mockDb.deadLetterEvent.findMany.mockResolvedValue([
      row({ payload: { type: 'deposit', amount: '10', note: 'plain' } }),
    ])

    const retryFn = jest.fn().mockResolvedValue(undefined)
    await DeadLetterQueue.retryAll(retryFn)

    expect(retryFn.mock.calls[0][0]).toMatchObject({
      type: 'deposit',
      amount: '10',
      note: 'plain',
    })
  })

  it('resolves a single event and reports failure for missing rows', async () => {
    expect(await DeadLetterQueue.resolve('dle-1')).toBe(true)

    mockDb.deadLetterEvent.update.mockRejectedValueOnce(
      new Error('record not found')
    )
    expect(await DeadLetterQueue.resolve('missing')).toBe(false)
  })

  it('migrates the legacy file-backed queue idempotently', async () => {
    const tmp = path.join(os.tmpdir(), `dlq-migrate-${Date.now()}.json`)
    try {
      // No file → nothing to do.
      expect(await DeadLetterQueue.migrateFromLegacyFile(tmp)).toEqual({
        imported: 0,
        skipped: 0,
      })

      const events = [
        {
          id: 'legacy-1',
          contractId: 'CVAULT',
          txHash: 'tx-1',
          eventType: 'deposit',
          ledger: 1,
          error: 'e1',
          payload: {},
          status: 'PENDING',
          retryCount: 0,
        },
        {
          id: 'legacy-2',
          contractId: 'CVAULT',
          txHash: 'tx-2',
          eventType: 'withdraw',
          ledger: 2,
          error: 'e2',
          payload: {},
          status: 'PENDING',
          retryCount: 0,
        },
      ]
      fs.writeFileSync(tmp, JSON.stringify(events))

      // First row already exists in the DB → skipped as a duplicate.
      mockDb.deadLetterEvent.findFirst.mockResolvedValueOnce(
        row({ id: 'db-1' })
      )

      const result = await DeadLetterQueue.migrateFromLegacyFile(tmp)

      expect(result).toEqual({ imported: 1, skipped: 1 })
      expect(mockDb.deadLetterEvent.create).toHaveBeenCalledTimes(1)
      // The file is renamed so subsequent boots skip the work.
      expect(fs.existsSync(`${tmp}.migrated`)).toBe(true)
    } finally {
      fs.rmSync(tmp, { force: true })
      fs.rmSync(`${tmp}.migrated`, { force: true })
    }
  })
})
