/**
 * Accounting export download (#549, #669).
 *
 * The controller performs post-generation reconciliation before returning any
 * bytes. This router is intentionally thin: the safety gate lives next to the
 * exporters so every future caller (web, mobile, scheduled export) gets it.
 */
import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/authenticate'
import { requireScope } from '../middleware/apiKeyAuth'
import { exportAccountingData } from '../controllers/accounting-controller'

const router = Router()

/**
 * GET /accounting/export?format=qbo|xero-csv&from=<iso>&to=<iso>
 *
 * Returns the file only when its parsed totals match the ledger for the
 * period. A mismatch is a 422 with the diff; no partial/corrupt file is sent.
 */
router.get(
  '/export',
  requireAuth,
  requireScope('transactions:read'),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const result = await exportAccountingData(userId, req.query)

    if (!result.success) {
      return res.status(result.statusCode ?? 500).json({
        error: result.error ?? 'Failed to generate accounting export',
        ...(result.reconciliation
          ? {
              reconciliation: {
                reconciled: result.reconciliation.reconciled,
                rowCount: result.reconciliation.rowCount,
                checksum: result.reconciliation.checksum,
                diffs: result.reconciliation.diffs,
                totals: result.reconciliation.totals,
              },
            }
          : {}),
      })
    }

    res.setHeader(
      'Content-Type',
      result.contentType ?? 'text/csv; charset=utf-8'
    )
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename ?? 'accounting-export.csv'}"`
    )
    // The file contains transaction history (PII): never let a shared cache
    // or browser retain it.
    res.setHeader('Cache-Control', 'private, no-store, max-age=0')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    res.setHeader('X-Export-Row-Count', String(result.rowCount ?? 0))
    res.setHeader('X-Export-Checksum', result.checksum ?? '')
    res.setHeader('X-Export-Reconciled', 'true')

    return res.status(200).send(result.data)
  }
)

export default router
