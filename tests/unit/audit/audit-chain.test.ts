import { Prisma } from '@prisma/client'
import {
  GENESIS_AUDIT_HASH,
  appendAuditBlock,
  canonicalizeAuditPayload,
  computeAuditHash,
  type AuditBlockType,
  verifyAuditChain,
} from '../../../src/audit/chain'

describe('audit chain', () => {
  it('serializes decimal-like values without float coercion', () => {
    const value = {
      amount: new Prisma.Decimal('123.4500'),
      fee: new Prisma.Decimal('0.0100'),
      nested: {
        total: new Prisma.Decimal('9.0000'),
      },
      arr: [new Prisma.Decimal('1.2300'), 'ok'],
    }

    const serialized = canonicalizeAuditPayload(value)

    expect(serialized).toContain('"amount":"123.45"')
    expect(serialized).toContain('"fee":"0.01"')
    expect(serialized).toContain('"total":"9"')
    expect(serialized).toContain('"arr":["1.23","ok"]')
    expect(serialized).not.toContain('"amount":123.45')
    expect(serialized).not.toContain('"fee":0.01')
  })

  it('builds a chained hash from the genesis anchor', () => {
    const hashA = computeAuditHash({
      height: 1,
      prevHash: GENESIS_AUDIT_HASH,
      payloadHash: 'abc123',
      blockType: 'EVENT_BATCH',
      timestamp: '2026-01-01T00:00:00.000Z',
    })

    const hashB = computeAuditHash({
      height: 2,
      prevHash: hashA,
      payloadHash: 'def456',
      blockType: 'TXN_BATCH',
      timestamp: '2026-01-01T00:00:01.000Z',
    })

    expect(hashA).not.toBe(GENESIS_AUDIT_HASH)
    expect(hashB).not.toBe(hashA)
    expect(hashA.startsWith('sha256:')).toBe(true)
    expect(hashB.startsWith('sha256:')).toBe(true)
  })

  it('accepts a valid chain and rejects tampering', () => {
    const blocks = [
      {
        height: 0,
        prevHash: GENESIS_AUDIT_HASH,
        hash: GENESIS_AUDIT_HASH,
        blockType: 'ANCHOR' as AuditBlockType,
        payloadHash: 'genesis',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        height: 1,
        prevHash: GENESIS_AUDIT_HASH,
        hash: computeAuditHash({
          height: 1,
          prevHash: GENESIS_AUDIT_HASH,
          payloadHash: 'payload-one',
          blockType: 'EVENT_BATCH',
          timestamp: '2026-01-01T00:00:01.000Z',
        }),
        blockType: 'EVENT_BATCH' as AuditBlockType,
        payloadHash: 'payload-one',
        createdAt: '2026-01-01T00:00:01.000Z',
      },
    ]

    expect(verifyAuditChain(blocks)).toEqual({
      valid: true,
      height: 1,
      blocksChecked: 2,
    })

    const tampered = [...blocks]
    tampered[1] = {
      ...tampered[1],
      blockType: 'EVENT_BATCH' as AuditBlockType,
      payloadHash: 'payload-two',
    }
    tampered[1].hash = 'sha256:wrong-hash'

    expect(verifyAuditChain(tampered)).toMatchObject({
      valid: false,
      height: 1,
      blocksChecked: 2,
      firstInvalidBlock: expect.objectContaining({ height: 1 }),
    })
  })

  it('appends a new block using the latest head and verifies the chain rules', async () => {
    const previous = {
      id: 'genesis',
      height: 0,
      prevHash: GENESIS_AUDIT_HASH,
      hash: GENESIS_AUDIT_HASH,
      blockType: 'ANCHOR' as AuditBlockType,
      payloadHash: 'genesis',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }

    const head = await appendAuditBlock({
      prevHash: previous.hash,
      payloadHash: 'payload-one',
      blockType: 'EVENT_BATCH',
      createdAt: new Date('2026-01-01T00:00:01.000Z'),
      height: previous.height + 1,
      payloads: [{ kind: 'processed_event', correlationId: 'abc' }],
    })

    expect(head.height).toBe(1)
    expect(head.prevHash).toBe(GENESIS_AUDIT_HASH)
    expect(head.hash.startsWith('sha256:')).toBe(true)
    const proof = verifyAuditChain([
      previous,
      {
        height: head.height,
        prevHash: head.prevHash,
        hash: head.hash,
        blockType: head.blockType,
        payloadHash: head.payloadHash,
        createdAt: head.createdAt.toISOString(),
      },
    ])
    expect(proof.valid).toBe(true)
  })
})
