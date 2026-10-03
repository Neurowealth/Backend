import { z } from 'zod'
import db from '../db'
import { logger } from '../utils/logger'
import { toQbo, toXeroCsv } from '../accounting/exporters'

const accountingExportSchema = z.object({
  format: z.enum(['qbo', 'xero-csv']),
  from: z.string().optional(),
  to: z.string().optional(),
})

export async function exportAccountingData(
  userId: string,
  query: unknown
): Promise<{ success: boolean; data?: string; contentType?: string; filename?: string; error?: string }> {
  try {
    const parsed = accountingExportSchema.parse(query)

    const fromDate = parsed.from ? new Date(parsed.from) : new Date(0)
    const toDate = parsed.to ? new Date(parsed.to) : new Date()

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
      logger.info(`No transactions found for user ${userId} in the specified date range`)
    }

    let data: string
    let contentType: string
    let filename: string

    if (parsed.format === 'qbo') {
      data = toQbo(mappedTransactions)
      contentType = 'text/csv'
      filename = `neurowealth-export-${userId}-${fromDate.toISOString().split('T')[0]}-${toDate.toISOString().split('T')[0]}.qbo.csv`
    } else {
      data = toXeroCsv(mappedTransactions)
      contentType = 'text/csv'
      filename = `neurowealth-export-${userId}-${fromDate.toISOString().split('T')[0]}-${toDate.toISOString().split('T')[0]}.xero.csv`
    }

    logger.info(`Generated accounting export for user ${userId}`, {
      format: parsed.format,
      transactionCount: transactions.length,
    })

    return { success: true, data, contentType, filename }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid query parameters',
      }
    }
    logger.error('Failed to generate accounting export', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      success: false,
      error: 'Failed to generate accounting export',
    }
  }
}
