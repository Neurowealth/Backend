/**
 * Admin review queue, bulk decisions and monthly calibration for flagged
 * referral conversions (#619).
 */
import { Prisma } from '@prisma/client'
import db from '../db'
import { config } from '../config'
import { logger } from '../utils/logger'

export type ReviewState = 'pending' | 'approved' | 'rejected' | 'all'

export interface ReviewQueueFilters {
  state: ReviewState
  scoreMin?: number
  scoreMax?: number
  flag?: string
  from?: Date
  to?: Date
  page: number
  pageSize: number
}

export function buildQueueWhere(
  f: Omit<ReviewQueueFilters, 'page' | 'pageSize'>
): Prisma.ReferralConversionWhereInput {
  const and: Prisma.ReferralConversionWhereInput[] = [
    { fraudCheckScore: { not: null } },
  ]
  if (f.state === 'pending') {
    and.push({ manualReviewRequired: true, manualReviewRejected: false })
  } else if (f.state === 'approved') {
    and.push({
      manualReviewRequired: false,
      manualReviewRejected: false,
      reviewedAt: { not: null },
    })
  } else if (f.state === 'rejected') {
    and.push({ manualReviewRejected: true })
  } else {
    and.push({
      OR: [{ manualReviewRequired: true }, { reviewedAt: { not: null } }],
    })
  }
  if (f.scoreMin !== undefined) {
    and.push({ fraudCheckScore: { gte: f.scoreMin } })
  }
  if (f.scoreMax !== undefined) {
    and.push({ fraudCheckScore: { lte: f.scoreMax } })
  }
  if (f.flag) and.push({ fraudCheckFlags: { has: f.flag } })
  if (f.from) and.push({ createdAt: { gte: f.from } })
  if (f.to) and.push({ createdAt: { lt: f.to } })
  return { AND: and }
}

export async function listReviewQueue(filters: ReviewQueueFilters) {
  const where = buildQueueWhere(filters)
  const [total, items] = await Promise.all([
    db.referralConversion.count({ where }),
    db.referralConversion.findMany({
      where,
      orderBy: [{ fraudCheckScore: 'desc' }, { createdAt: 'asc' }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      include: {
        referralCode: { select: { ownerUserId: true, code: true } },
        referredUser: { select: { id: true, email: true, createdAt: true } },
      },
    }),
  ])
  return {
    items,
    page: filters.page,
    pageSize: filters.pageSize,
    total,
    totalPages: Math.ceil(total / filters.pageSize),
  }
}

export interface BulkReviewAdmin {
  id: string
  name: string
  role: string
}

export interface BulkReviewResult {
  succeeded: string[]
  skipped: Array<{ id: string; reason: string }>
}

/**
 * Applies one decision to many pending conversions. Each conversion is
 * decided and audited in its own transaction, so one stale id cannot roll
 * back the rest; non-pending or unknown ids are reported as skipped.
 */
export async function bulkReviewConversions(
  ids: string[],
  decision: 'approve' | 'reject',
  admin: BulkReviewAdmin,
  reason?: string
): Promise<BulkReviewResult> {
  const result: BulkReviewResult = { succeeded: [], skipped: [] }

  for (const id of [...new Set(ids)]) {
    const outcome = await db.$transaction(async (tx) => {
      const conversion = await tx.referralConversion.findUnique({
        where: { id },
      })
      if (!conversion) return 'not found'
      if (!conversion.manualReviewRequired || conversion.manualReviewRejected) {
        return 'not pending review'
      }
      await tx.referralConversion.update({
        where: { id },
        data: {
          manualReviewRequired: false,
          manualReviewRejected: decision === 'reject',
          reviewedBy: admin.name,
          reviewedAt: new Date(),
          reviewDecision: decision === 'approve' ? 'approved' : 'rejected',
          ...(decision === 'reject' ? { rejectionReason: reason ?? null } : {}),
        },
      })
      await tx.adminAuditLog.create({
        data: {
          adminKeyId: admin.id,
          adminName: admin.name,
          adminRole: admin.role,
          action:
            decision === 'approve'
              ? 'REFERRAL_BULK_APPROVE'
              : 'REFERRAL_BULK_REJECT',
          target: id,
          result: 'SUCCESS',
          details: {
            fraudCheckScore: conversion.fraudCheckScore,
            fraudCheckFlags: conversion.fraudCheckFlags,
            reason: reason ?? null,
          },
        },
      })
      return null
    })
    if (outcome) result.skipped.push({ id, reason: outcome })
    else result.succeeded.push(id)
  }

  logger.info('[Referral] Bulk review applied', {
    decision,
    reviewer: admin.name,
    succeeded: result.succeeded.length,
    skipped: result.skipped.length,
  })
  return result
}

export interface ScoredReview {
  score: number
  rejected: boolean
}

export interface CalibrationReport {
  month: string
  scored: number
  distribution: Array<{ band: string; count: number }>
  reviewed: number
  approvedCount: number
  rejectedCount: number
  falsePositiveRate: number | null
  currentReviewScore: number
  suggestedReviewScore: number | null
  suggestion: string
}

const BAND_WIDTH = 20

export function scoreDistribution(scores: number[]) {
  const buckets = new Map<number, number>()
  for (const s of scores) {
    const b = Math.floor(s / BAND_WIDTH) * BAND_WIDTH
    buckets.set(b, (buckets.get(b) ?? 0) + 1)
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, count]) => ({
      band: `${start}-${start + BAND_WIDTH - 1}`,
      count,
    }))
}

/**
 * Lowest threshold t among observed review scores where the share of
 * rejections among reviews with score >= t reaches targetPrecision. A
 * threshold higher than the current one means the queue is over-flagging.
 */
export function suggestReviewThreshold(
  reviews: ScoredReview[],
  targetPrecision: number
): number | null {
  const candidates = [...new Set(reviews.map((r) => r.score))].sort(
    (a, b) => a - b
  )
  for (const t of candidates) {
    const above = reviews.filter((r) => r.score >= t)
    const precision = above.filter((r) => r.rejected).length / above.length
    if (precision >= targetPrecision) return t
  }
  return null
}

export async function buildCalibrationReport(
  month: string
): Promise<CalibrationReport> {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) throw new Error('month must be YYYY-MM')
  const start = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))
  const end = new Date(Date.UTC(Number(match[1]), Number(match[2]), 1))

  const [scoredRows, reviewedRows] = await Promise.all([
    db.referralConversion.findMany({
      where: {
        fraudCheckScore: { not: null },
        createdAt: { gte: start, lt: end },
      },
      select: { fraudCheckScore: true },
    }),
    db.referralConversion.findMany({
      where: {
        fraudCheckScore: { not: null },
        reviewedAt: { gte: start, lt: end },
      },
      select: { fraudCheckScore: true, manualReviewRejected: true },
    }),
  ])

  const reviews: ScoredReview[] = reviewedRows.map((r) => ({
    score: r.fraudCheckScore as number,
    rejected: r.manualReviewRejected,
  }))
  const rejectedCount = reviews.filter((r) => r.rejected).length
  const approvedCount = reviews.length - rejectedCount
  const falsePositiveRate =
    reviews.length > 0 ? approvedCount / reviews.length : null

  const { reviewScore, targetPrecision } = config.referral.fraud
  const suggested = suggestReviewThreshold(reviews, targetPrecision)

  let suggestion = 'Not enough manual reviews this month to suggest a change.'
  if (reviews.length > 0) {
    if (suggested === null) {
      suggestion = `No threshold reaches ${targetPrecision} precision; review the fraud weights (REFERRAL_FRAUD_WEIGHT_*).`
    } else if (suggested > reviewScore) {
      suggestion = `Raise REFERRAL_FRAUD_REVIEW_SCORE from ${reviewScore} to ${suggested} to cut false positives.`
    } else {
      suggestion = `Current REFERRAL_FRAUD_REVIEW_SCORE (${reviewScore}) meets the ${targetPrecision} precision target.`
    }
  }

  return {
    month,
    scored: scoredRows.length,
    distribution: scoreDistribution(
      scoredRows.map((r) => r.fraudCheckScore as number)
    ),
    reviewed: reviews.length,
    approvedCount,
    rejectedCount,
    falsePositiveRate,
    currentReviewScore: reviewScore,
    suggestedReviewScore: suggested,
    suggestion,
  }
}
