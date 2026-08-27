/**
 * Tax report assembly (#284, extended by #317, #356). A pure read over the
 * LotDisposal ledger — disposal rows snapshot cost basis / proceeds / gain
 * at disposal time, so the report never recomputes money from mutable
 * state. Totals include only fully priced disposals; unpriced ones are
 * flagged and counted in caveats, never zeroed into the sums.
 *
 * Method selection (#317): this report shows the disposals that actually
 * happened, recorded under whichever method was active on the account at
 * each withdrawal — it does not hypothetically re-simulate history under a
 * different method (that would produce numbers that don't match what the
 * real withdrawals actually did, lot-for-lot). `method`, if passed, is
 * therefore a confirmation gate: it must match the account's current
 * `accountingMethod` or the call is rejected (MethodMismatchError) — never
 * a silent recompute switch.
 *
 * Jurisdiction (#356): tax-year boundaries, holding-period long/short
 * classification, and any flat allowance are all delegated to
 * src/tax/jurisdictions/ via `User.taxJurisdiction` (default US, which
 * reproduces the pre-#356 UTC-calendar-year behavior byte-for-byte). This
 * module still owns 100% of the money math — a profile only tells it which
 * disposals belong to "this year" and how to annotate/allowance them.
 */
import { AccountingMethod, Prisma, TaxJurisdiction } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import db from '../db'
import { CsvValue } from '../utils/csv'
import { resolveJurisdiction, TaxProfile } from './jurisdictions'

type Db = typeof db | Prisma.TransactionClient

export class MethodMismatchError extends Error {
  readonly requestedMethod: AccountingMethod
  readonly actualMethod: AccountingMethod

  constructor(
    requestedMethod: AccountingMethod,
    actualMethod: AccountingMethod
  ) {
    super(
      `Requested report method '${requestedMethod}' does not match the account's configured method '${actualMethod}'`
    )
    this.name = 'MethodMismatchError'
    this.requestedMethod = requestedMethod
    this.actualMethod = actualMethod
  }
}

export interface TaxReportDisposal {
  disposedAt: string
  assetSymbol: string
  amount: string
  withdrawalTxHash: string | null
  acquiredAt: string
  acquisitionTxHash: string | null
  acquisitionPrice: string | null
  disposalPrice: string | null
  costBasis: string | null
  proceeds: string | null
  realizedGain: string | null
  priced: boolean
  // #356 — derived from the jurisdiction profile's holdingPeriod rule;
  // null when the profile draws no long/short distinction (e.g. UK).
  holdingPeriodDays: number
  longTerm: boolean | null
}

export interface TaxReport {
  userId: string
  year: number
  method: AccountingMethod
  // #356 — the jurisdiction this report was built under, and the tax-year
  // window that resolved to (which is NOT always the UTC calendar year —
  // see src/tax/jurisdictions/).
  jurisdiction: TaxJurisdiction
  taxYearLabel: string
  taxYearStart: string
  taxYearEnd: string
  disposals: TaxReportDisposal[]
  totals: {
    proceeds: string
    costBasis: string
    realizedGain: string
    pricedDisposalCount: number
    // #356 — present only for jurisdictions with a long/short split
    // (holdingPeriod.longTermEffect.kind !== 'NONE'); null otherwise so a
    // UK/DE-style report doesn't imply a distinction it doesn't make.
    shortTermGain: string | null
    longTermGain: string | null
    // #356 — the profile's flat annual allowance and the realized gain
    // remaining after it is applied (never below zero; an allowance does
    // not create a loss).
    allowanceApplied: string
    realizedGainAfterAllowance: string
  }
  caveats: {
    unpricedDisposalCount: number
    unpricedAssets: string[]
    stablecoinAssumption: string
    rebalancesNotIncluded: string
    // #317 — set only when the account's method changed mid-year (see
    // methodEffectiveAt): explains that this year's disposals are not all
    // one method, per the issue's "must not silently mix methods" rule.
    methodChangeNote: string | null
    // #356 — always present: this report is bookkeeping output, not filed
    // tax advice, and jurisdiction rules simplify real-world edge cases.
    jurisdictionDisclaimer: string
  }
}

function holdingPeriodDaysBetween(acquiredAt: Date, disposedAt: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000
  return Math.floor((disposedAt.getTime() - acquiredAt.getTime()) / msPerDay)
}

function isLongTerm(profile: TaxProfile, holdingPeriodDays: number): boolean | null {
  if (profile.holdingPeriod.longTermEffect.kind === 'NONE') {
    return null
  }
  return holdingPeriodDays >= profile.holdingPeriod.longTermThresholdDays
}

const str = (value: Decimal | null): string | null =>
  value === null ? null : new Decimal(value).toString()

export async function buildTaxReport(
  userId: string,
  year: number,
  method?: AccountingMethod,
  database: Db = db
): Promise<TaxReport> {
  const user = await (database as any).user.findUnique({
    where: { id: userId },
    select: {
      accountingMethod: true,
      methodEffectiveAt: true,
      taxJurisdiction: true,
    },
  })
  if (!user) {
    throw new Error(`User ${userId} not found`)
  }
  if (method && method !== user.accountingMethod) {
    throw new MethodMismatchError(method, user.accountingMethod)
  }

  const profile = resolveJurisdiction(user.taxJurisdiction)
  const { start: yearStart, end: yearEnd, label: taxYearLabel } =
    profile.taxYearFor(new Date(Date.UTC(year, 0, 1)), year)

  const rows = await (database as any).lotDisposal.findMany({
    where: {
      userId,
      disposedAt: {
        gte: yearStart,
        lt: yearEnd,
      },
    },
    include: {
      lot: { include: { transaction: { select: { txHash: true } } } },
      transaction: { select: { txHash: true } },
    },
    orderBy: [{ disposedAt: 'asc' }, { createdAt: 'asc' }],
  })

  const disposals: TaxReportDisposal[] = rows.map((row: any) => {
    const holdingPeriodDays = holdingPeriodDaysBetween(
      row.lot.acquiredAt,
      row.disposedAt
    )
    return {
      disposedAt: row.disposedAt.toISOString(),
      assetSymbol: row.assetSymbol,
      amount: new Decimal(row.amount).toString(),
      withdrawalTxHash: row.transaction?.txHash ?? null,
      acquiredAt: row.lot.acquiredAt.toISOString(),
      acquisitionTxHash: row.lot.transaction?.txHash ?? null,
      acquisitionPrice: str(row.lot.acquisitionPrice),
      disposalPrice: str(row.disposalPrice),
      costBasis: str(row.costBasis),
      proceeds: str(row.proceeds),
      realizedGain: str(row.realizedGain),
      priced: row.realizedGain !== null,
      holdingPeriodDays,
      longTerm: isLongTerm(profile, holdingPeriodDays),
    }
  })

  let proceeds = new Decimal(0)
  let costBasis = new Decimal(0)
  let realizedGain = new Decimal(0)
  let shortTermGain = new Decimal(0)
  let longTermGain = new Decimal(0)
  let pricedDisposalCount = 0
  const unpricedAssets = new Set<string>()
  const hasLongShortSplit = profile.holdingPeriod.longTermEffect.kind !== 'NONE'

  for (const disposal of disposals) {
    if (disposal.priced) {
      proceeds = proceeds.plus(disposal.proceeds as string)
      costBasis = costBasis.plus(disposal.costBasis as string)
      realizedGain = realizedGain.plus(disposal.realizedGain as string)
      pricedDisposalCount++
      if (hasLongShortSplit) {
        if (disposal.longTerm) {
          longTermGain = longTermGain.plus(disposal.realizedGain as string)
        } else {
          shortTermGain = shortTermGain.plus(disposal.realizedGain as string)
        }
      }
    } else {
      unpricedAssets.add(disposal.assetSymbol)
    }
  }

  const allowance = new Decimal(profile.allowance.annualExemptAmount)
  const allowanceApplied = realizedGain.greaterThan(0)
    ? Decimal.min(allowance, realizedGain)
    : new Decimal(0)
  const realizedGainAfterAllowance = realizedGain.minus(allowanceApplied)

  const methodChangedDuringYear =
    user.methodEffectiveAt !== null &&
    user.methodEffectiveAt >= yearStart &&
    user.methodEffectiveAt < yearEnd

  return {
    userId,
    year,
    method: user.accountingMethod,
    jurisdiction: user.taxJurisdiction,
    taxYearLabel,
    taxYearStart: yearStart.toISOString(),
    taxYearEnd: yearEnd.toISOString(),
    disposals,
    totals: {
      proceeds: proceeds.toString(),
      costBasis: costBasis.toString(),
      realizedGain: realizedGain.toString(),
      pricedDisposalCount,
      shortTermGain: hasLongShortSplit ? shortTermGain.toString() : null,
      longTermGain: hasLongShortSplit ? longTermGain.toString() : null,
      allowanceApplied: allowanceApplied.toString(),
      realizedGainAfterAllowance: realizedGainAfterAllowance.toString(),
    },
    caveats: {
      unpricedDisposalCount: disposals.length - pricedDisposalCount,
      unpricedAssets: [...unpricedAssets].sort(),
      stablecoinAssumption:
        'USDC is priced at 1.00 USD by assumption (STABLECOIN_ASSUMPTION); no market price feed is used.',
      jurisdictionDisclaimer: `This report applies the ${profile.displayName} (${profile.jurisdiction}) tax profile (tax year ${taxYearLabel}). It is bookkeeping output, not tax advice — verify with a qualified professional for your situation.`,
      rebalancesNotIncluded:
        'Protocol rebalances are same-asset transfers and are not treated as taxable disposals in this report.',
      methodChangeNote: methodChangedDuringYear
        ? `The accounting method changed to ${user.accountingMethod} on ${user.methodEffectiveAt!.toISOString()}. Disposals before that date were recorded under the previously configured method; this report does not retroactively recompute them.`
        : null,
    },
  }
}

export const TAX_REPORT_CSV_HEADERS = [
  'disposedAt',
  'assetSymbol',
  'amount',
  'withdrawalTxHash',
  'acquiredAt',
  'acquisitionTxHash',
  'acquisitionPrice',
  'disposalPrice',
  'costBasis',
  'proceeds',
  'realizedGain',
  'priced',
  'holdingPeriodDays',
  'longTerm',
]

export function taxReportToCsvRows(report: TaxReport): CsvValue[][] {
  return report.disposals.map((d) => [
    d.disposedAt,
    d.assetSymbol,
    d.amount,
    d.withdrawalTxHash,
    d.acquiredAt,
    d.acquisitionTxHash,
    d.acquisitionPrice,
    d.disposalPrice,
    d.costBasis,
    d.proceeds,
    d.realizedGain,
    d.priced,
    d.holdingPeriodDays,
    d.longTerm,
  ])
}
