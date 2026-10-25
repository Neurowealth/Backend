import {
  Router,
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from 'express'
import { z } from 'zod'
import {
  requireAdminAuth,
  requireAdminScope,
  getAdminAuth,
} from '../../middleware/adminAuth'
import { validate } from '../../middleware/validate'
import {
  listReviewQueue,
  bulkReviewConversions,
  buildCalibrationReport,
} from '../../referral/reviewQueue'

const router = Router()
const handle =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res).catch(next)
  }

const querySchema = z.object({
  state: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
  scoreMin: z.coerce.number().int().min(0).optional(),
  scoreMax: z.coerce.number().int().min(0).optional(),
  flag: z.string().min(1).max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
})

const bulkSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
  decision: z.enum(['approve', 'reject']),
  reason: z.string().min(1).max(500).optional(),
})

const calibrationSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
})

router.use(requireAdminAuth)

router.get(
  '/queue',
  requireAdminScope('referrals:read'),
  validate({ query: querySchema }),
  handle(async (req, res) => {
    res.json(await listReviewQueue(querySchema.parse(req.query)))
  })
)

router.post(
  '/bulk-review',
  requireAdminScope('referrals:write'),
  validate({ body: bulkSchema }),
  handle(async (req, res) => {
    const admin = getAdminAuth(res)!
    const { ids, decision, reason } = bulkSchema.parse(req.body)
    if (decision === 'reject' && !reason) {
      res.status(400).json({ error: 'reason is required when rejecting' })
      return
    }
    const result = await bulkReviewConversions(
      ids,
      decision,
      { id: admin.id, name: admin.name, role: admin.role },
      reason
    )
    res.json(result)
  })
)

router.get(
  '/calibration',
  requireAdminScope('referrals:read'),
  validate({ query: calibrationSchema }),
  handle(async (req, res) => {
    const { month } = calibrationSchema.parse(req.query)
    res.json(await buildCalibrationReport(month))
  })
)

export default router
