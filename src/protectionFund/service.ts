/**
 * Protocol-Risk Protection Fund (#533).
 *
 * A platform-funded reserve pool that makes depositors partially or fully
 * whole after a covered protocol-level loss event. Funded by a configurable
 * revenue skim, governed by explicit published coverage terms.
 */

import { Prisma } from '@prisma/client'
import { db } from '../db'
import { config } from '../config/env'
import { logger } from '../utils/logger'
import { enqueueOutboxOp } from '../outbox/service'
import {
  aggregatePayloadHash,
  appendAuditBlock,
  GENESIS_AUDIT_HASH,
  type AuditBlockType,
} from '../audit/chain'

type Db = typeof db | Prisma.TransactionClient

/**
 * appendAuditBlock is pure — it hashes a block but never writes it. Anchor the
 * resulting block on the real audit chain, on the same client as the business
 * write so a failure rolls both back (see src/jobs/dataRetention.ts).
 */
async function recordAuditBlock(
  database: Db,
  blockType: AuditBlockType,
  payloads: unknown[]
): Promise<void> {
  const payloadHash = aggregatePayloadHash(payloads)
  const latest = await database.auditBlock.findFirst({
    orderBy: { height: 'desc' },
    select: { hash: true, height: true },
  })

  const block = appendAuditBlock({
    height: (latest?.height ?? 0) + 1,
    prevHash: latest?.hash ?? GENESIS_AUDIT_HASH,
    payloadHash,
    blockType,
    createdAt: new Date(),
    payloads,
  })

  await database.auditBlock.create({
    data: {
      height: block.height,
      prevHash: block.prevHash,
      hash: block.hash,
      blockType: block.blockType,
      payloadCount: block.payloadCount,
      payloadHash: block.payloadHash,
      createdAt: block.createdAt,
    },
  })
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CoverageTerms {
  perUserCoverageCap: number
  minHoldDurationMs: number
  coveredCauses: string[]
  excludedCauses: string[]
}

export interface DeclareEventInput {
  protocolName: string
  cause: string
  lossWindowStart: string
  lossWindowEnd: string
  totalPlatformExposure: number
  description: string
  declaredBy: string
}

export interface ClaimResult {
  claimId: string
  userId: string
  positionId: string
  actualLoss: number
  netLoss: number
  payoutAmount: number
  coverageType: 'FULL' | 'PRORATED' | 'ZERO'
  status: 'PENDING' | 'PAYOUT_QUEUED' | 'PAID' | 'REJECTED'
}

// ─── Coverage Terms ─────────────────────────────────────────────────────────

export function getCoverageTerms(): CoverageTerms {
  return {
    perUserCoverageCap: config.protectionFund.perUserCoverageCap,
    minHoldDurationMs: config.protectionFund.minHoldDurationMs,
    coveredCauses: ['EXPLOIT', 'INSOLVENCY', 'GOVERNANCE_FAILURE'],
    excludedCauses: ['MARKET_PRICE_LOSS', 'USER_ERROR', 'NORMAL_RISK'],
  }
}

// ─── Fund Balance ───────────────────────────────────────────────────────────

export async function getFundBalance(assetSymbol?: string) {
  const symbol = assetSymbol || config.protectionFund.defaultAssetSymbol
  const balance = await db.protectionFundBalance.findUnique({
    where: { assetSymbol: symbol },
  })
  return {
    assetSymbol: symbol,
    amount: balance ? Number(balance.amount) : 0,
    status: balance?.status || 'BOOTSTRAP',
  }
}

export async function recordContribution(
  input: {
    source: string
    assetSymbol: string
    amount: number
    sourceRef?: string
    createdBy?: string
  },
  database: Db = db
) {
  const contribution = await database.protectionFundContribution.create({
    data: {
      source: input.source,
      assetSymbol: input.assetSymbol,
      amount: new Prisma.Decimal(input.amount),
      sourceRef: input.sourceRef,
      createdBy: input.createdBy,
    },
  })

  await database.protectionFundBalance.upsert({
    where: { assetSymbol: input.assetSymbol },
    create: {
      assetSymbol: input.assetSymbol,
      amount: new Prisma.Decimal(input.amount),
      status: 'ACCUMULATING',
    },
    update: {
      amount: { increment: new Prisma.Decimal(input.amount) },
      status: 'ACCUMULATING',
    },
  })

  await recordAuditBlock(database, 'ADMIN_BATCH', [
    {
      type: 'PROTECTION_FUND_CONTRIBUTION',
      contributionId: contribution.id,
      amount: input.amount,
    },
  ])

  return contribution
}

// ─── Coverage Events ────────────────────────────────────────────────────────

export async function declareCoverageEvent(input: DeclareEventInput) {
  const terms = getCoverageTerms()

  if (!terms.coveredCauses.includes(input.cause)) {
    throw new Error(
      `Cause "${input.cause}" is not a covered event type. Covered: ${terms.coveredCauses.join(', ')}`
    )
  }

  const event = await db.coverageEvent.create({
    data: {
      protocolName: input.protocolName,
      cause: input.cause,
      lossWindowStart: input.lossWindowStart,
      lossWindowEnd: input.lossWindowEnd,
      totalPlatformExposure: new Prisma.Decimal(input.totalPlatformExposure),
      declaredBy: input.declaredBy,
      status: 'PENDING_REVIEW',
      coverageTerms: terms as any,
      description: input.description,
    },
  })

  await recordAuditBlock(db, 'ADMIN_BATCH', [
    {
      type: 'COVERAGE_EVENT_DECLARED',
      eventId: event.id,
      protocol: input.protocolName,
    },
  ])

  return event
}

export async function reviewCoverageEvent(
  eventId: string,
  approved: boolean,
  reviewedBy: string
) {
  const event = await db.coverageEvent.findUnique({ where: { id: eventId } })
  if (!event) throw new Error('Coverage event not found')
  if (event.status !== 'PENDING_REVIEW')
    throw new Error(`Event is not pending review (status: ${event.status})`)

  const updated = await db.coverageEvent.update({
    where: { id: eventId },
    data: {
      status: approved ? 'APPROVED' : 'REJECTED',
      reviewedBy,
    },
  })

  if (approved) {
    await computeClaimsForEvent(eventId)
  }

  return updated
}

// ─── Claim Computation ──────────────────────────────────────────────────────

export async function computeClaimsForEvent(eventId: string) {
  const event = await db.coverageEvent.findUnique({ where: { id: eventId } })
  if (!event) throw new Error('Coverage event not found')

  const terms = getCoverageTerms()
  const lossStart = new Date(event.lossWindowStart)
  const lossEnd = new Date(event.lossWindowEnd)

  const positions = await db.position.findMany({
    where: {
      protocolName: event.protocolName,
      status: { in: ['ACTIVE', 'CLOSED', 'LIQUIDATED'] },
    },
    include: { transactions: true },
  })

  const claims: ClaimResult[] = []
  const fundBalance = await getFundBalance()
  let remainingFund = fundBalance.amount

  for (const position of positions) {
    const holdDuration = lossStart.getTime() - position.openedAt.getTime()
    if (holdDuration < terms.minHoldDurationMs) continue

    const loss = computePositionLoss(position, lossStart, lossEnd)
    if (loss <= 0) continue

    const netLoss = loss
    const cappedLoss = Math.min(netLoss, terms.perUserCoverageCap)
    const payoutAmount = Math.min(cappedLoss, remainingFund)
    const coverageType =
      payoutAmount >= cappedLoss
        ? 'FULL'
        : payoutAmount > 0
          ? 'PRORATED'
          : 'ZERO'

    const claim = await db.coverageClaim.create({
      data: {
        eventId,
        userId: position.userId,
        positionId: position.id,
        actualLoss: new Prisma.Decimal(loss),
        netLoss: new Prisma.Decimal(netLoss),
        payoutAmount: new Prisma.Decimal(payoutAmount),
        coverageType,
        status: payoutAmount > 0 ? 'PENDING' : 'REJECTED',
      },
    })

    claims.push({
      claimId: claim.id,
      userId: position.userId,
      positionId: position.id,
      actualLoss: loss,
      netLoss,
      payoutAmount,
      coverageType,
      status: claim.status as 'PENDING' | 'PAID' | 'REJECTED',
    })

    remainingFund -= payoutAmount
    if (remainingFund <= 0) break
  }

  logger.info(
    `[ProtectionFund] Computed ${claims.length} claims for event ${eventId}`
  )
  return claims
}

function computePositionLoss(
  position: any,
  lossStart: Date,
  lossEnd: Date
): number {
  const relevantTxs = position.transactions.filter((tx: any) => {
    const txDate = new Date(tx.createdAt)
    return txDate >= lossStart && txDate <= lossEnd
  })

  let totalDeposited = 0
  let totalWithdrawn = 0
  for (const tx of relevantTxs) {
    if (tx.type === 'DEPOSIT' || tx.type === 'INBOUND_TRANSFER') {
      totalDeposited += Number(tx.amount)
    } else if (tx.type === 'WITHDRAWAL') {
      totalWithdrawn += Number(tx.amount)
    }
  }

  const netDeposited = totalDeposited - totalWithdrawn
  const currentValue = Number(position.currentValue)
  const loss = Math.max(0, netDeposited - currentValue)

  return loss
}

// ─── Payout ─────────────────────────────────────────────────────────────────

export async function executePayout(claimId: string) {
  return db.$transaction(async (tx) => {
    const claim = await tx.coverageClaim.findUnique({
      where: { id: claimId },
      include: { event: true },
    })
    if (!claim) throw new Error('Claim not found')
    if (claim.status !== 'PENDING')
      throw new Error(`Claim is not pending (status: ${claim.status})`)
    if (claim.payoutAmount.lte(0)) throw new Error('Claim has zero payout')
    const user = await tx.user.findUnique({
      where: { id: claim.userId },
      select: { walletAddress: true },
    })
    if (!user?.walletAddress)
      throw new Error(`User ${claim.userId} has no wallet address`)

    // Compare-and-set claim: exactly one concurrent caller moves PENDING to
    // PAYOUT_QUEUED. A loser (or a repeat POST) throws and rolls the whole
    // transaction back, so the fund can only ever be debited once.
    const claimed = await tx.coverageClaim.updateMany({
      where: { id: claimId, status: 'PENDING' },
      data: { status: 'PAYOUT_QUEUED' },
    })
    if (claimed.count !== 1) {
      throw new Error(`Claim is not pending (status: ${claim.status})`)
    }

    const assetSymbol = config.protectionFund.defaultAssetSymbol
    // Guard the decrement on the balance itself: a fund that cannot cover the
    // payout leaves the claim PENDING (the transaction rolls back) rather than
    // going negative.
    const debited = await tx.protectionFundBalance.updateMany({
      where: { assetSymbol, amount: { gte: claim.payoutAmount } },
      data: { amount: { decrement: claim.payoutAmount } },
    })
    if (debited.count !== 1) {
      throw new Error(
        `Insufficient protection fund balance for claim ${claimId}`
      )
    }

    const outboxOp = await enqueueOutboxOp(tx, {
      userId: claim.userId,
      kind: 'WITHDRAW',
      actor: 'SYSTEM',
      idempotencyKey: `PROTECTION_FUND_PAYOUT:${claimId}`,
      payload: {
        method: 'protection_fund_payout',
        userId: claim.userId,
        userAddress: user.walletAddress,
        amount: Number(claim.payoutAmount),
        assetSymbol,
        claimId,
        eventId: claim.eventId,
      },
      priority: 'CRITICAL',
    })

    await tx.coverageClaim.update({
      where: { id: claimId },
      data: { outboxOpId: outboxOp.id },
    })

    await recordAuditBlock(tx, 'TXN_BATCH', [
      {
        type: 'PROTECTION_FUND_PAYOUT',
        claimId,
        amount: Number(claim.payoutAmount),
      },
    ])

    return outboxOp
  })
}

// ─── Queries ────────────────────────────────────────────────────────────────

export async function getMyCoverage(userId: string) {
  const terms = getCoverageTerms()
  const positions = await db.position.findMany({
    where: { userId, status: 'ACTIVE' },
  })

  const coveredProtocols = new Set<string>()
  const exposure = []

  for (const pos of positions) {
    const openedTime = pos.openedAt
      ? pos.openedAt.getTime()
      : (pos as any).createdAt
        ? new Date((pos as any).createdAt).getTime()
        : Date.now()
    const holdDuration = Date.now() - openedTime
    const eligible = holdDuration >= terms.minHoldDurationMs

    exposure.push({
      positionId: pos.id,
      protocolName: pos.protocolName,
      assetSymbol: pos.assetSymbol,
      currentValue: Number(pos.currentValue),
      eligibleForCoverage: eligible,
      holdDurationMs: holdDuration,
      minHoldDurationMs: terms.minHoldDurationMs,
    })

    if (eligible) {
      coveredProtocols.add(pos.protocolName)
    }
  }

  const fundBalance = await getFundBalance()

  return {
    userId,
    totalPositions: positions.length,
    coveredProtocols: Array.from(coveredProtocols),
    exposure,
    fundBalance,
    coverageTerms: terms,
    estimatedCoverage: exposure
      .filter((e) => e.eligibleForCoverage)
      .reduce(
        (sum, e) => sum + Math.min(e.currentValue, terms.perUserCoverageCap),
        0
      ),
  }
}

export async function getProtectionFundStatus() {
  const fundBalance = await getFundBalance()
  const contributions = await db.protectionFundContribution.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  const events = await db.coverageEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
  })

  return {
    fundBalance,
    coverageTerms: getCoverageTerms(),
    recentContributions: contributions.map((c) => ({
      id: c.id,
      source: c.source,
      assetSymbol: c.assetSymbol,
      amount: Number(c.amount),
      createdAt: c.createdAt,
    })),
    historicalEvents: events.map((e) => ({
      id: e.id,
      protocolName: e.protocolName,
      cause: e.cause,
      status: e.status,
      totalPlatformExposure: Number(e.totalPlatformExposure),
      lossWindowStart: e.lossWindowStart,
      lossWindowEnd: e.lossWindowEnd,
      createdAt: e.createdAt,
    })),
  }
}
