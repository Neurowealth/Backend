import { Router, Request, Response } from 'express'
import db from '../db'
import { getAgentStatus } from '../agent/loop'
import {
  formatAgentStatusReply,
  formatProtocolRatesReply,
} from '../whatsapp/formatters'

const router = Router()

/**
 * GET /api/protocols/rates
 * Returns current protocol rates
 * Requires authentication to prevent information disclosure
 */
router.get('/rates', async (req: Request, res: Response) => {
  const rates = await db.protocolRate.findMany({
    orderBy: { fetchedAt: 'desc' },
    take: 10,
  })

  const items = rates.map((rate: any) => ({
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

/**
 * GET /api/protocols/agent/status
 * Returns agent status information
 * Requires authentication to prevent information disclosure
 */
router.get('/agent/status', async (req: Request, res: Response) => {
  try {
    // Get real agent loop health instead of just latest log
    const agentStatus = getAgentStatus()

    // Also fetch latest log for supplemental information
    const latestLog = await db.agentLog.findFirst({
      orderBy: { createdAt: 'desc' },
    })

    const data = {
      isRunning: agentStatus.isRunning,
      healthStatus: agentStatus.healthStatus,
      lastRebalanceAt: agentStatus.lastRebalanceAt?.toISOString() || null,
      currentProtocol: agentStatus.currentProtocol,
      currentApy: agentStatus.currentApy ? Number(agentStatus.currentApy.toFixed(2)) : null,
      nextScheduledCheck: agentStatus.nextScheduledCheck.toISOString(),
      lastError: agentStatus.lastError,
      latestLog: latestLog ? {
        status: latestLog.status,
        action: latestLog.action,
        createdAt: latestLog.createdAt.toISOString(),
      } : null,
      timestamp: new Date().toISOString(),
    }

    return res.status(200).json({
      success: true,
      data,
      whatsappReply: formatAgentStatusReply({
        status: agentStatus.healthStatus,
        action: 'STATUS_CHECK',
        updatedAt: new Date().toISOString(),
      }),
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({
      success: false,
      error: errorMessage,
    })
  }
})

export default router
