import { Router, Request, Response } from 'express'
import db from '../db'
import {
  formatAgentStatusReply,
  formatProtocolRatesReply,
} from '../whatsapp/formatters'

const router = Router()

router.get('/rates', async (req: Request, res: Response) => {
  const rates = await db.protocolRate.findMany({
    orderBy: { fetchedAt: 'desc' },
    take: 10,
  })

  const items = rates.map((rate) => ({
    protocolName: rate.protocolName,
    assetSymbol: rate.assetSymbol,
    supplyApy: Number(rate.supplyApy),
    borrowApy: rate.borrowApy ? Number(rate.borrowApy) : null,
    tvl: rate.tvl ? Number(rate.tvl) : null,
    network: rate.network,
    fetchedAt: rate.fetchedAt.toISOString(),
  }))

  return res.status(200).json({
    rates: items,
    whatsappReply: formatProtocolRatesReply({ rates: items }),
  })
})

router.get('/agent/status', async (req: Request, res: Response) => {
  const latest = await db.agentLog.findFirst({
    orderBy: { createdAt: 'desc' },
  })

  if (!latest) {
    return res.status(404).json({ error: 'Agent status not found' })
  }

  const data = {
    status: latest.status,
    action: latest.action,
    updatedAt: latest.createdAt.toISOString(),
  }

  return res.status(200).json({
    ...data,
    whatsappReply: formatAgentStatusReply(data),
  })
})

export default router
