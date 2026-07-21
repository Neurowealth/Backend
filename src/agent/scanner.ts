/**
 * Scanner - Fetches real APY rates from Stellar yield protocols
 */

import { logger } from '../utils/logger'
import { YieldProtocol, ProtocolRate } from './types'
import db from '../db'
import { fetchWithRetry } from '../utils/fetchWithRetry'

const ASSET_SYMBOL = 'USDC'
const MINIMUM_TVL = 10000

// Metrics tracking
const metrics: Record<
  string,
  { duration: number; failures: number; lastFetched: number }
> = {}

function recordMetric(name: string, duration: number, failed: boolean) {
  const prev = metrics[name] || { duration: 0, failures: 0, lastFetched: 0 }
  metrics[name] = {
    duration,
    failures: failed ? prev.failures + 1 : 0,
    lastFetched: Date.now(),
  }
}

function isStale(name: string, maxAgeMs = 300000): boolean {
  const m = metrics[name]
  if (!m) return true
  return Date.now() - m.lastFetched > maxAgeMs
}

/**
 * Fetch APY from Blend protocol (real)
 */
async function fetchBlendApy(): Promise<YieldProtocol | null> {
  const start = Date.now()
  try {
    const network =
      process.env.STELLAR_NETWORK?.toLowerCase() === 'mainnet'
        ? 'https://api.blend.capital'
        : 'https://testnet-api.blend.capital'

    const poolId =
      process.env.BLEND_POOL_ID ||
      'GBUQWP3BOUZX34PISXEAMBNIZJLNCLVNX77MHAHVXHVVB4CMYAOK6BAC'

    const data = await fetchWithRetry(`${network}/api/v1/pool/${poolId}`, {
      timeout: 5000,
      retries: 3,
    })

    // Extract USDC reserve APY and TVL from response
    const reserve = data?.reserves?.find(
      (r: any) => r.asset?.code === 'USDC' || r.asset?.symbol === 'USDC'
    )

    const apyRate = reserve?.supplyApy
      ? parseFloat(reserve.supplyApy) * 100
      : null

    const tvl = reserve?.totalSupply ? parseFloat(reserve.totalSupply) : null

    if (apyRate === null)
      throw new Error('Could not parse Blend APY from response')

    recordMetric('Blend', Date.now() - start, false)

    return {
      name: 'Blend',
      apy: apyRate,
      tvl: tvl ?? undefined,
      assetSymbol: ASSET_SYMBOL,
      lastUpdated: new Date(),
      isAvailable: true,
    }
  } catch (error) {
    recordMetric('Blend', Date.now() - start, true)
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'
    logger.error('Blend APY fetch failed', { error: errorMessage })
    return null
  }
}

/**
 * Fetch APY from Stellar DEX pools (real via Horizon)
 */
async function fetchStellarDexApy(): Promise<YieldProtocol | null> {
  const start = Date.now()
  try {
    const horizonUrl = process.env.HORIZON_URL || 'https://horizon.stellar.org'
    const usdcIssuer =
      process.env.USDC_ISSUER ||
      'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

    const data = await fetchWithRetry(
      `${horizonUrl}/liquidity_pools?reserves=${ASSET_SYMBOL}:${usdcIssuer}&limit=10&order=desc`,
      { timeout: 5000, retries: 3 }
    )

    const pools = data?._embedded?.records || []
    if (pools.length === 0) throw new Error('No Stellar DEX pools found')

    // Aggregate: weighted average fee APY by TVL
    let totalTvl = 0
    let weightedApy = 0

    for (const pool of pools) {
      const tvlValue = parseFloat(pool.total_shares || '0')
      const feeApy = (parseFloat(pool.fee_bp || '30') / 10000) * 365
      totalTvl += tvlValue
      weightedApy += feeApy * tvlValue
    }

    const apyRate = totalTvl > 0 ? weightedApy / totalTvl : 0

    recordMetric('Stellar DEX', Date.now() - start, false)

    return {
      name: 'Stellar DEX',
      apy: apyRate,
      tvl: totalTvl,
      assetSymbol: ASSET_SYMBOL,
      lastUpdated: new Date(),
      isAvailable: true,
    }
  } catch (error) {
    recordMetric('Stellar DEX', Date.now() - start, true)
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'
    logger.error('Stellar DEX APY fetch failed', { error: errorMessage })
    return null
  }
}

/**
 * Fetch APY from Luma (real)
 */
async function fetchLumaApy(): Promise<YieldProtocol | null> {
  const start = Date.now()
  try {
    const lumaUrl = process.env.LUMA_API_URL || 'https://api.luma.finance'

    const data = await fetchWithRetry(
      `${lumaUrl}/v1/rates?asset=${ASSET_SYMBOL}`,
      { timeout: 5000, retries: 3 }
    )

    const rate = data?.rates?.find(
      (r: any) => r.asset === ASSET_SYMBOL || r.symbol === ASSET_SYMBOL
    )

    if (!rate) throw new Error('USDC rate not found in Luma response')

    const apyRate = parseFloat(rate.apy) * 100
    const tvl = rate.tvl ? parseFloat(rate.tvl) : undefined

    recordMetric('Luma', Date.now() - start, false)

    return {
      name: 'Luma',
      apy: apyRate,
      tvl,
      assetSymbol: ASSET_SYMBOL,
      lastUpdated: new Date(),
      isAvailable: true,
    }
  } catch (error) {
    recordMetric('Luma', Date.now() - start, true)
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'
    logger.error('Luma APY fetch failed', { error: errorMessage })
    return null
  }
}

/**
 * Scan all protocol APY rates
 */
export async function scanAllProtocols(): Promise<YieldProtocol[]> {
  const fetchPromises = [fetchBlendApy(), fetchStellarDexApy(), fetchLumaApy()]

  const results = await Promise.allSettled(fetchPromises)
  const protocols: YieldProtocol[] = []

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      protocols.push(result.value)
    } else if (result.status === 'rejected') {
      logger.warn('Protocol fetch promise rejected', {
        error:
          result.reason instanceof Error
            ? result.reason.message
            : 'Unknown error',
      })
    }
  }

  protocols.sort((a, b) => b.apy - a.apy)
  const filtered = protocols.filter((p) => !p.tvl || p.tvl >= MINIMUM_TVL)

  // Log metrics
  logger.info('Protocol scan complete', {
    protocols: filtered.length,
    topApy: filtered[0]?.apy,
    topProtocol: filtered[0]?.name,
    metrics: Object.entries(metrics).map(([name, m]) => ({
      name,
      fetchDurationMs: m.duration,
      failures: m.failures,
      stale: isStale(name),
    })),
  })

  await saveProtocolRates(filtered)
  return filtered
}

function normalizeNetwork(): string {
  const network = process.env.STELLAR_NETWORK?.toLowerCase()
  const validNetworks = ['mainnet', 'testnet', 'futurenet']
  if (!network || !validNetworks.includes(network)) {
    throw new Error(
      `Invalid STELLAR_NETWORK: "${process.env.STELLAR_NETWORK}". Must be one of: ${validNetworks.join(', ')}`
    )
  }
  return network.toUpperCase()
}

/**
 * Save protocol rates to database for historical tracking
 */
async function saveProtocolRates(protocols: YieldProtocol[]): Promise<void> {
  try {
    const networkLabel = normalizeNetwork()
    for (const protocol of protocols) {
      await db.protocolRate.create({
        data: {
          protocolName: protocol.name,
          assetSymbol: protocol.assetSymbol,
          supplyApy: protocol.apy as any,
          tvl: protocol.tvl === undefined ? undefined : (protocol.tvl as any),
          network: networkLabel as any,
          rawResponse: JSON.stringify({
            fetchedAt: new Date(),
            source: protocol.name,
          }),
        },
      })
    }
  } catch (error) {
    logger.error('Failed to save protocol rates', {
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

export async function getCurrentOnChainApy(
  protocolName: string
): Promise<number | null> {
  try {
    const latestRate = await db.protocolRate.findFirst({
      where: { protocolName, assetSymbol: ASSET_SYMBOL },
      orderBy: { fetchedAt: 'desc' },
    })
    if (!latestRate) {
      logger.warn(`No on-chain APY found for ${protocolName}`)
      return null
    }
    return latestRate.supplyApy.toNumber()
  } catch (error) {
    logger.error('Failed to get current on-chain APY', {
      protocolName,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return null
  }
}

export async function getBestProtocol(): Promise<YieldProtocol | null> {
  const protocols = await scanAllProtocols()
  return protocols.length > 0 ? protocols[0] : null
}
