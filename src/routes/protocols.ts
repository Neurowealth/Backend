import { Router, Request, Response } from 'express'
import { db } from '../db'
import { whatsappFormatters } from '../whatsapp/formatters'
import { logger } from '../utils/logger'

const router = Router()

/**
 * GET /api/protocols/rates
 * Get current rates and APYs for available protocols (no auth required for discovery)
 */
router.get('/rates', async (req: Request, res: Response) => {
  try {
    // Get the latest protocol rates across all networks
    const now = new Date()
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    const rates = await db.protocolRate.findMany({
      where: {
        fetchedAt: {
          gte: oneDayAgo,
          lte: now
        }
      },
      orderBy: [{ fetchedAt: 'desc' }, { protocolName: 'asc' }],
      distinct: ['protocolName', 'assetSymbol']
    })

    // Group by protocol and asset
    const protocolMap: Record<string, Array<{ name: string; asset: string; apy: string; tvl?: string }>> = {}

    rates.forEach((rate: any) => {
      const key = rate.protocolName
      if (!protocolMap[key]) {
        protocolMap[key] = []
      }

      protocolMap[key].push({
        name: rate.protocolName,
        asset: rate.assetSymbol,
        apy: rate.supplyApy.toString(),
        tvl: rate.tvl?.toString()
      })
    })

    const protocolsData = {
      fetchedAt: now,
      protocols: Object.values(protocolMap).flat(),
      count: Object.values(protocolMap).flat().length,
      whatsappReply: whatsappFormatters.formatProtocolRates({
        protocols: Object.values(protocolMap).flat()
      })
    }

    res.status(200).json(protocolsData)
  } catch (error) {
    logger.error('Protocol rates endpoint error', { error })
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/protocols/agent/status
 * Get the current status and performance of the agent
 */
router.get('/agent/status', async (req: Request, res: Response) => {
  try {
    // Get the most recent agent action
    const lastLog = await db.agentLog.findFirst({
      orderBy: { createdAt: 'desc' },
      take: 1
    })

    if (!lastLog) {
      const statusData = {
        status: 'IDLE',
        lastAction: 'None',
        lastActionTime: new Date().toISOString(),
        successRate: '0',
        whatsappReply: whatsappFormatters.formatAgentStatus({
          status: 'IDLE',
          lastAction: 'No activity',
          lastActionTime: 'N/A',
          successRate: '0'
        })
      }
      res.status(200).json(statusData)
      return
    }

    // Calculate success rate from recent logs (last 100 actions)
    const recentLogs = await db.agentLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100
    })

    const successCount = recentLogs.filter((log: any) => log.status === 'SUCCESS').length
    const successRate = ((successCount / recentLogs.length) * 100).toFixed(1)

    const statusData = {
      status: lastLog.status,
      lastAction: lastLog.action,
      lastActionTime: lastLog.createdAt.toISOString(),
      successRate: successRate,
      responseTimeMs: lastLog.durationMs || 0,
      whatsappReply: whatsappFormatters.formatAgentStatus({
        status: lastLog.status,
        lastAction: lastLog.action,
        lastActionTime: lastLog.createdAt.toLocaleString(),
        successRate: successRate
      })
    }

    res.status(200).json(statusData)
  } catch (error) {
    logger.error('Agent status endpoint error', { error })
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
