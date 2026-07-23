/**
 * Tax report assembly (#284). A pure read over the LotDisposal ledger —
 * disposal rows snapshot cost basis / proceeds / gain at disposal time, so the
 * report never recomputes money from mutable state. Totals include only fully
 * priced disposals; unpriced ones are flagged and counted in caveats, never
 * zeroed into the sums. Year boundaries are UTC.
 */
import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import db from '../db'
import { CsvValue } from '../utils/csv'

type Db = typeof db | Prisma.TransactionClient

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
}

export interface TaxReport {
  userId: string
  year: number
  method: 'FIFO'
  disposals: TaxReportDisposal[]
  totals: {
    proceeds: string
    costBasis: string
    realizedGain: string
    pricedDisposalCount: number
  }
  caveats: {
    unpricedDisposalCount: number
    unpricedAssets: string[]
    stablecoinAssumption: string
    rebalancesNotIncluded: string
  }
}

const str = (value: Decimal | null): string | null =>
  value === null ? null : new Decimal(value).toString()

export async function buildTaxReport(
  userId: string,
  year: number,
  database: Db = db
): Promise<TaxReport> {
  const rows = await (database as any).lotDisposal.findMany({
    where: {
      userId,
      disposedAt: {
        gte: new Date(Date.UTC(year, 0, 1)),
        lt: new Date(Date.UTC(year + 1, 0, 1)),
      },
    },
    include: {
      lot: { include: { transaction: { select: { txHash: true } } } },
      transaction: { select: { txHash: true } },
    },
    orderBy: [{ disposedAt: 'asc' }, { createdAt: 'asc' }],
  })

  const disposals: TaxReportDisposal[] = rows.map((row: any) => ({
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
  }))

  let proceeds = new Decimal(0)
  let costBasis = new Decimal(0)
  let realizedGain = new Decimal(0)
  let pricedDisposalCount = 0
  const unpricedAssets = new Set<string>()

  for (const disposal of disposals) {
    if (disposal.priced) {
      proceeds = proceeds.plus(disposal.proceeds as string)
      costBasis = costBasis.plus(disposal.costBasis as string)
      realizedGain = realizedGain.plus(disposal.realizedGain as string)
      pricedDisposalCount++
    } else {
      unpricedAssets.add(disposal.assetSymbol)
    }
  }

  return {
    userId,
    year,
    method: 'FIFO',
    disposals,
    totals: {
      proceeds: proceeds.toString(),
      costBasis: costBasis.toString(),
      realizedGain: realizedGain.toString(),
      pricedDisposalCount,
    },
    caveats: {
      unpricedDisposalCount: disposals.length - pricedDisposalCount,
      unpricedAssets: [...unpricedAssets].sort(),
      stablecoinAssumption:
        'USDC is priced at 1.00 USD by assumption (STABLECOIN_ASSUMPTION); no market price feed is used.',
      rebalancesNotIncluded:
        'Protocol rebalances are same-asset transfers and are not treated as taxable disposals in this report.',
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
  ])
}
