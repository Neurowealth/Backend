import { z } from 'zod'
import db from '../db'
import { logger } from '../utils/logger'
import {
  AccountingExportFormat,
  AccountingReconciliation,
  assertReconciled,
} from '../accounting/reconciliation'
import { toQbo, toXeroCsv } from '../accounting/exporters'

const accountingExportSchema = z.object({
  format: z.enum(['qbo', 'xero-csv']),
  from: z
    .string()
    .optional()
    .refine(
      (value) => value === undefined || !Number.isNaN(Date.parse(value)),
      {
        message: 'from must be an ISO-8601 date',
      }
    ),
  to: z
    .string()
    .optional()
    .refine(
      (value) => value === undefined || !Number.isNaN(Date.parse(value)),
      {
        message: 'to must be an ISO-8601 date',
      }
    ),
})

export interface AccountingExportResult {
  success: boolean
  data?: string
  contentType?: string
  filename?: string
  rowCount?: number
  checksum?: string
  reconciliation?: AccountingReconciliation
  error?: string
  statusCode?: number
}

function periodLabel(fromDate: Date, toDate: Date): string {
  return `${fromDate.toISOString().split('T')[0]}-${
    toDate.toISOString().split('T')[0]
  }`
}

export async function exportAccountingData(
  userId: string,
  query: unknown
): Promise<AccountingExportResult> {
  try {
    const parsed = accountingExportSchema.parse(query)

    const fromDate = parsed.from ? new Date(parsed.from) : new Date(0)
    const toDate = parsed.to ? new Date(parsed.to) : new Date()

    if (fromDate.getTime() > toDate.getTime()) {
      return {
        success: false,
        error: 'Invalid date range: from must be before or equal to to',
        statusCode: 400,
      }
    }

    const transactions = await db.transaction.findMany({
      where: {
        userId,
        createdAt: {
          gte: fromDate,
          lte: toDate,
        },
      },
      select: {
        type: true,
        amount: true,
        assetSymbol: true,
        fee: true,
        createdAt: true,
        protocolName: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    })

    const mappedTransactions = transactions.map((tx) => ({
      ...tx,
      amount: tx.amount.toString(),
      fee: tx.fee != null ? tx.fee.toString() : null,
    }))

    if (transactions.length === 0) {
      logger.info(
        `No transactions found for user ${userId} in the specified date range`
      )
    }

    const format = parsed.format as AccountingExportFormat
    const data =
      format === 'qbo'
        ? toQbo(mappedTransactions)
        : toXeroCsv(mappedTransactions)

    // The safety gate (#669): parse the generated file back and prove it
    // reproduces the ledger. A mismatch never reaches the caller as a
    // downloadable file — it becomes a 422 with the diff.
    const reconciliation = assertReconciled(format, data, mappedTransactions)

    const contentType = 'text/csv; charset=utf-8'
    const filename = `neurowealth-export-${userId}-${periodLabel(
      fromDate,
      toDate
    )}.${format === 'qbo' ? 'qbo' : 'xero'}.csv`

    logger.info('[AccountingExport] Generated and reconciled export', {
      action: 'ACCOUNTING_EXPORT',
      userId,
      format,
      period: { from: fromDate.toISOString(), to: toDate.toISOString() },
      transactionCount: transactions.length,
      rowCount: reconciliation.rowCount,
      checksum: reconciliation.checksum,
      totals: reconciliation.totals,
    })

    return {
      success: true,
      data,
      contentType,
      filename,
      rowCount: reconciliation.rowCount,
      checksum: reconciliation.checksum,
      reconciliation,
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid query parameters',
        statusCode: 400,
      }
    }

    if (
      error instanceof Error &&
      error.name === 'AccountingReconciliationError'
    ) {
      const reconciliation = (
        error as Error & { reconciliation?: AccountingReconciliation }
      ).reconciliation
      logger.error(
        '[AccountingExport] Reconciliation failed — download blocked',
        {
          action: 'ACCOUNTING_EXPORT_RECONCILIATION_FAILED',
          userId,
          error: error.message,
          rowCount: reconciliation?.rowCount,
          checksum: reconciliation?.checksum,
          totals: reconciliation?.totals,
          diffs: reconciliation?.diffs,
        }
      )
      return {
        success: false,
        error: error.message,
        statusCode: 422,
        rowCount: reconciliation?.rowCount,
        checksum: reconciliation?.checksum,
        reconciliation,
      }
    }

    logger.error('Failed to generate accounting export', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      success: false,
      error: 'Failed to generate accounting export',
      statusCode: 500,
    }
  }
}
