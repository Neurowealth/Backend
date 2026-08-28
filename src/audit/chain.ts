import crypto from 'node:crypto'
import { Prisma } from '@prisma/client'

export type AuditBlockType =
  'EVENT_BATCH' | 'TXN_BATCH' | 'ADMIN_BATCH' | 'ANCHOR'

export interface AuditBlockLike {
  height: number
  prevHash: string
  hash: string
  blockType: AuditBlockType
  payloadHash: string
  payloadCount?: number
  createdAt: string | Date
}

export interface AuditHashInput {
  height: number
  prevHash: string
  payloadHash: string
  blockType: AuditBlockType
  timestamp: string
}

export const GENESIS_AUDIT_HASH =
  'sha256:' +
  crypto.createHash('sha256').update('neuro-audit-genesis-v1').digest('hex')

export function canonicalizeAuditPayload(value: unknown): string {
  const stable = (input: unknown): unknown => {
    if (input === null || input === undefined) return input

    if (typeof input === 'string') return input
    if (typeof input === 'boolean') return input
    if (typeof input === 'number')
      return Number.isFinite(input) ? String(input) : String(input)
    if (typeof input === 'bigint') return input.toString()
    if (typeof input === 'symbol') return input.toString()

    if (typeof input === 'object') {
      if (input instanceof Date) {
        return input.toISOString()
      }
      if (Buffer.isBuffer(input)) {
        return input.toString('base64')
      }
      if (input instanceof Prisma.Decimal || Prisma.Decimal.isDecimal(input)) {
        return input.toString()
      }
      if (Array.isArray(input)) {
        return input.map((item) => stable(item))
      }

      const obj = input as Record<string, unknown>
      return Object.keys(obj)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = stable(obj[key])
          return acc
        }, {})
    }

    return String(input)
  }

  return JSON.stringify(stable(value))
}

export function aggregatePayloadHash(payloads: unknown[]): string {
  const normalized = payloads
    .map((entry) => canonicalizeAuditPayload(entry))
    .sort()
    .join('|')

  return (
    'sha256:' + crypto.createHash('sha256').update(normalized).digest('hex')
  )
}

export function computeAuditHash({
  height,
  prevHash,
  payloadHash,
  blockType,
  timestamp,
}: AuditHashInput): string {
  const material = `${height}|${prevHash}|${payloadHash}|${blockType}|${timestamp}`
  return 'sha256:' + crypto.createHash('sha256').update(material).digest('hex')
}

export function verifyAuditChain(blocks: AuditBlockLike[]): {
  valid: boolean
  height: number
  blocksChecked: number
  firstInvalidBlock?: AuditBlockLike & { reason: string }
} {
  const ordered = [...blocks].sort((a, b) => a.height - b.height)

  if (ordered.length === 0) {
    return {
      valid: false,
      height: 0,
      blocksChecked: 0,
      firstInvalidBlock: {
        height: 0,
        prevHash: '',
        hash: '',
        blockType: 'ANCHOR',
        payloadHash: '',
        createdAt: new Date().toISOString(),
        reason: 'Genesis missing',
      },
    }
  }

  let previous: AuditBlockLike | null = null

  for (let index = 0; index < ordered.length; index++) {
    const block = ordered[index]
    const expectedTimestamp = new Date(block.createdAt).toISOString()

    if (index === 0) {
      if (block.height !== 0) {
        return {
          valid: false,
          height: block.height,
          blocksChecked: index + 1,
          firstInvalidBlock: {
            ...block,
            reason: 'Genesis block must be height 0',
          },
        }
      }

      if (block.prevHash !== GENESIS_AUDIT_HASH) {
        return {
          valid: false,
          height: block.height,
          blocksChecked: index + 1,
          firstInvalidBlock: {
            ...block,
            reason: 'Genesis prevHash does not match the documented constant',
          },
        }
      }

      if (block.hash !== GENESIS_AUDIT_HASH) {
        return {
          valid: false,
          height: block.height,
          blocksChecked: index + 1,
          firstInvalidBlock: {
            ...block,
            reason: 'Genesis hash does not match the documented constant',
          },
        }
      }
    } else {
      if (block.height !== (previous?.height ?? 0) + 1) {
        return {
          valid: false,
          height: block.height,
          blocksChecked: index + 1,
          firstInvalidBlock: {
            ...block,
            reason: `Height drift: expected ${(previous?.height ?? 0) + 1} but received ${block.height}`,
          },
        }
      }

      if (block.prevHash !== previous!.hash) {
        return {
          valid: false,
          height: block.height,
          blocksChecked: index + 1,
          firstInvalidBlock: {
            ...block,
            reason: `Prev hash mismatch: expected ${previous!.hash} but received ${block.prevHash}`,
          },
        }
      }

      const expectedHash = computeAuditHash({
        height: block.height,
        prevHash: block.prevHash,
        payloadHash: block.payloadHash,
        blockType: block.blockType,
        timestamp: expectedTimestamp,
      })

      if (block.hash !== expectedHash) {
        return {
          valid: false,
          height: block.height,
          blocksChecked: index + 1,
          firstInvalidBlock: {
            ...block,
            reason: `Hash mismatch: expected ${expectedHash} but received ${block.hash}`,
          },
        }
      }
    }

    previous = block
  }

  return {
    valid: true,
    height: previous?.height ?? 0,
    blocksChecked: ordered.length,
  }
}

export function appendAuditBlock(params: {
  height: number
  prevHash: string
  payloadHash: string
  blockType: AuditBlockType
  createdAt: Date
  payloads?: unknown[]
}): {
  id?: string
  height: number
  prevHash: string
  hash: string
  blockType: AuditBlockType
  payloadCount: number
  payloadHash: string
  createdAt: Date
} {
  const timestamp = params.createdAt.toISOString()
  const hash = computeAuditHash({
    height: params.height,
    prevHash: params.prevHash,
    payloadHash: params.payloadHash,
    blockType: params.blockType,
    timestamp,
  })

  return {
    height: params.height,
    prevHash: params.prevHash,
    hash,
    blockType: params.blockType,
    payloadCount: params.payloads?.length ?? 0,
    payloadHash: params.payloadHash,
    createdAt: params.createdAt,
  }
}

export function serializeAuditRow(payload: unknown): string {
  return canonicalizeAuditPayload(payload)
}

export function isGenesisAnchored(blocks: AuditBlockLike[]): boolean {
  if (blocks.length === 0) return false
  const genesis = [...blocks].sort((a, b) => a.height - b.height)[0]
  return genesis.height === 0 && genesis.prevHash === GENESIS_AUDIT_HASH
}

export function auditPayloadHashFor(value: unknown): string {
  return (
    'sha256:' +
    crypto
      .createHash('sha256')
      .update(canonicalizeAuditPayload(value))
      .digest('hex')
  )
}

export function canonicalizeAuditPayloadForTest(value: unknown): string {
  return canonicalizeAuditPayload(value)
}
