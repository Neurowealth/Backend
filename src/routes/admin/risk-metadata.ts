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
import db from '../../db'
import {
  upsertRiskMetadata,
  RiskMetadataValidationError,
} from '../../config/riskMetadataAdmin'

const router = Router()
const handle =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res).catch(next)
  }

const protocolParamSchema = z.object({
  protocolName: z.string().min(1).max(100),
})

const upsertSchema = z.object({
  auditStatus: z.enum(['UNAUDITED', 'SELF_REPORTED', 'THIRD_PARTY_AUDITED']),
  auditReference: z.string().min(1).max(500),
  sourceUrl: z.string().url().max(500).optional(),
  dataConfidence: z
    .enum(['VERIFIED', 'SELF_REPORTED', 'UNVERIFIED'])
    .optional(),
  inceptionDate: z.coerce.date(),
  nextReviewDueAt: z.coerce.date(),
})

router.use(requireAdminAuth)

router.get(
  '/',
  requireAdminScope('risk-metadata:read'),
  handle(async (_req, res) => {
    const now = new Date()
    const entries = await db.protocolRiskMetadataEntry.findMany({
      orderBy: { protocolName: 'asc' },
    })
    res.json({
      entries: entries.map((e) => ({ ...e, stale: e.nextReviewDueAt < now })),
    })
  })
)

router.put(
  '/:protocolName',
  requireAdminScope('risk-metadata:write'),
  validate({ params: protocolParamSchema, body: upsertSchema }),
  handle(async (req, res) => {
    const admin = getAdminAuth(res)!
    try {
      const entry = await upsertRiskMetadata(
        req.params.protocolName,
        upsertSchema.parse(req.body),
        { id: admin.id, name: admin.name, role: admin.role }
      )
      res.json({ entry })
    } catch (error) {
      if (error instanceof RiskMetadataValidationError) {
        res.status(400).json({ error: error.message })
        return
      }
      throw error
    }
  })
)

export default router
