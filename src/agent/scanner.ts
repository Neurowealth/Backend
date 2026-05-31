/**
 * Scanner - Fetches real APY rates from Stellar yield protocols
 */

import { logger } from '../utils/logger';
import { YieldProtocol, ProtocolRate } from './types';
import db from '../db';

const PROTOCOLS = ['Blend', 'Stellar DEX', 'Luma'];
const ASSET_SYMBOL = 'USDC';
const MINIMUM_TVL = 10000; // Minimum TVL to consider a protocol

/**
 * Fetch APY from Blend testnet
 */
async function fetchBlendApy(): Promise<YieldProtocol | null> {
  try {
    // Mock implementation - in production, call actual Blend API
    // https://testnet-api.blend.capital/api/v1/pool/GBUQWP3BOUZX34PISXEAMBNIZJLNCLVNX77MHAHVXHVVB4CMYAOK6BAC

    const apyRate = 4.25;
    const tvl = 50000000;

    return {
      name: 'Blend',
      apy: apyRate,
      tvl,
      assetSymbol: ASSET_SYMBOL,
      lastUpdated: new Date(),
      isAvailable: true,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error fetching Blend APY';
    logger.error('Blend APY fetch failed', { error: errorMessage });
    return null;
  }
}

/**
 * Fetch APY from Stellar DEX pools
 */
async function fetchStellarDexApy(): Promise<YieldProtocol | null> {
  try {
    // Mock implementation - in production, aggregate DEX pool rates
    // Could use SoroswapRouter or other DEX aggregators

    const apyRate = 3.85;
    const tvl = 25000000;

    return {
      name: 'Stellar DEX',
      apy: apyRate,
      tvl,
      assetSymbol: ASSET_SYMBOL,
      lastUpdated: new Date(),
      isAvailable: true,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error fetching Stellar DEX APY';
    logger.error('Stellar DEX APY fetch failed', { error: errorMessage });
    return null;
  }
}

/**
 * Fetch APY from Luma
 */
async function fetchLumaApy(): Promise<YieldProtocol | null> {
  try {
    // Mock implementation - in production, call Luma API

    const apyRate = 4.10;
    const tvl = 35000000;

    return {
      name: 'Luma',
      apy: apyRate,
      tvl,
      assetSymbol: ASSET_SYMBOL,
      lastUpdated: new Date(),
      isAvailable: true,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error fetching Luma APY';
    logger.error('Luma APY fetch failed', { error: errorMessage });
    return null;
  }
}

/**
 * Scan all protocol APY rates
 * Uses Promise.allSettled to continue even if one protocol fails
 */
export async function scanAllProtocols(): Promise<YieldProtocol[]> {
  const fetchPromises = [
    fetchBlendApy(),
    fetchStellarDexApy(),
    fetchLumaApy(),
  ];

  const results = await Promise.allSettled(fetchPromises);

  const protocols: YieldProtocol[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      protocols.push(result.value);
    } else if (result.status === 'rejected') {
      logger.warn('Protocol fetch promise rejected', {
        error: result.reason instanceof Error ? result.reason.message : 'Unknown error',
      });
    }
  }

  // Sort by APY descending (highest first)
  protocols.sort((a, b) => b.apy - a.apy);

  // Filter by minimum TVL
  const filtered = protocols.filter(p => !p.tvl || p.tvl >= MINIMUM_TVL);

  logger.info('Protocol scan complete', {
    protocols: filtered.length,
    topApy: filtered[0]?.apy,
    topProtocol: filtered[0]?.name,
  });

  // Save snapshot to database
  await saveProtocolRates(filtered);

  return filtered;
}

/**
 * Normalize STELLAR_NETWORK to valid network label
 * Supports: mainnet, testnet, futurenet
 */
function normalizeNetwork(): string {
  const network = process.env.STELLAR_NETWORK?.toLowerCase()

  const validNetworks = ['mainnet', 'testnet', 'futurenet']
  if (!network || !validNetworks.includes(network)) {
    throw new Error(
      `Invalid STELLAR_NETWORK: "${process.env.STELLAR_NETWORK}". Must be one of: ${validNetworks.join(', ')}`
    )
  }

  // Map to uppercase for database storage
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
          // Prisma Decimal type wrapper isn't exposed consistently across tooling;
          // passing number values is enough for Prisma to coerce.
          supplyApy: protocol.apy as any,
          tvl: protocol.tvl === undefined ? undefined : (protocol.tvl as any),
          network: networkLabel as any,
        },
      });
    }
  } catch (error) {
    logger.error('Failed to save protocol rates', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Get current on-chain APY for active user positions
 */
export async function getCurrentOnChainApy(protocolName: string): Promise<number | null> {
  try {
    const latestRate = await db.protocolRate.findFirst({
      where: {
        protocolName,
        assetSymbol: ASSET_SYMBOL,
      },
      orderBy: {
        fetchedAt: 'desc',
      },
    });

    if (!latestRate) {
      logger.warn(`No on-chain APY found for ${protocolName}`);
      return null;
    }

    return latestRate.supplyApy.toNumber();
  } catch (error) {
    logger.error('Failed to get current on-chain APY', {
      protocolName,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
  }
}

/**
 * Get best protocol from latest scan
 */
export async function getBestProtocol(): Promise<YieldProtocol | null> {
  const protocols = await scanAllProtocols();
  return protocols.length > 0 ? protocols[0] : null;
}
