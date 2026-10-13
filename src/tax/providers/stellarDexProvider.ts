import { Decimal } from '@prisma/client/runtime/library'
import { fetchWithRetry } from '../../utils/fetchWithRetry'
import { logger } from '../../utils/logger'
import { findStrictSendPath } from '../../stellar/routing'
import {
  PriceConfidence,
  PriceFeedProvider,
  PriceFeedResult,
  PriceGranularity,
} from './types'

const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org'
const DEFAULT_USDC_ISSUER =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const MILLISECONDS_IN_DAY = 86_400_000
const LOOKBACK_DAYS_FALLBACK = 7

interface TradeAggregationRecord {
  timestamp: number | string
  count: number | string
  close?: string
  avg?: string
  base_volume?: string
  counter_volume?: string
}

/**
 * Stellar DEX market-data price feed provider.
 * Queries Horizon trade aggregations for historical pricing and path finding for spot quotes.
 */
export class StellarDexPriceFeedProvider implements PriceFeedProvider {
  readonly name = 'stellar-dex'
  private readonly horizonUrl: string
  private readonly usdcIssuer: string

  constructor(horizonUrl?: string, usdcIssuer?: string) {
    this.horizonUrl = (
      horizonUrl ||
      process.env.HORIZON_URL ||
      DEFAULT_HORIZON_URL
    ).replace(/\/+$/, '')
    this.usdcIssuer =
      usdcIssuer || process.env.USDC_ISSUER || DEFAULT_USDC_ISSUER
  }

  private resolveAssetParams(assetSymbol: string): {
    assetType: 'native' | 'credit_alphanum4' | 'credit_alphanum12'
    assetCode?: string
    assetIssuer?: string
    formattedAsset: string
  } {
    const upper = assetSymbol.trim().toUpperCase()
    if (upper === 'XLM' || upper === 'NATIVE') {
      return {
        assetType: 'native',
        formattedAsset: 'XLM',
      }
    }

    if (upper.includes(':')) {
      const [code, issuer] = upper.split(':')
      const assetType =
        code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12'
      return {
        assetType,
        assetCode: code,
        assetIssuer: issuer,
        formattedAsset: upper,
      }
    }

    const assetType =
      upper.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12'
    return {
      assetType,
      assetCode: upper,
      assetIssuer: this.usdcIssuer,
      formattedAsset: `${upper}:${this.usdcIssuer}`,
    }
  }

  private buildAggregationUrl(
    baseParams: ReturnType<typeof this.resolveAssetParams>,
    startTimeMs: number,
    endTimeMs: number
  ): string {
    const params = new URLSearchParams({
      counter_asset_type: 'credit_alphanum4',
      counter_asset_code: 'USDC',
      counter_asset_issuer: this.usdcIssuer,
      resolution: MILLISECONDS_IN_DAY.toString(),
      start_time: startTimeMs.toString(),
      end_time: endTimeMs.toString(),
      limit: '1',
      order: 'desc',
    })

    if (baseParams.assetType === 'native') {
      params.set('base_asset_type', 'native')
    } else {
      params.set('base_asset_type', baseParams.assetType)
      if (baseParams.assetCode) {
        params.set('base_asset_code', baseParams.assetCode)
      }
      if (baseParams.assetIssuer) {
        params.set('base_asset_issuer', baseParams.assetIssuer)
      }
    }

    return `${this.horizonUrl}/trade_aggregations?${params.toString()}`
  }

  private async fetchTradeAggregation(
    url: string
  ): Promise<TradeAggregationRecord | null> {
    try {
      const response = await fetchWithRetry(url, {
        timeout: 5000,
        retries: 2,
      })
      const records = response?._embedded?.records
      if (Array.isArray(records) && records.length > 0) {
        return records[0] as TradeAggregationRecord
      }
      return null
    } catch (error) {
      logger.warn(
        `[StellarDexPriceFeedProvider] Trade aggregation request failed: ${url}`,
        { error }
      )
      return null
    }
  }

  private async fetchSpotQuote(
    formattedSourceAsset: string
  ): Promise<PriceFeedResult | null> {
    try {
      const destAsset = `USDC:${this.usdcIssuer}`
      const quote = await findStrictSendPath({
        sourceAsset: formattedSourceAsset,
        sourceAmount: '1',
        destAsset,
      })

      const destAmount = quote.estDestAmount || quote.destAmountMin
      if (!destAmount || Number.isNaN(Number(destAmount))) {
        return null
      }

      const isThin = Array.isArray(quote.path) && quote.path.length > 2

      return {
        price: new Decimal(destAmount),
        confidence: isThin ? 'LOW' : 'HIGH',
        granularity: 'SPOT',
        asOfDate: new Date(),
        caveat: isThin
          ? 'Thin DEX liquidity on path-payment route; price impact elevated'
          : null,
        sourceName: this.name,
      }
    } catch (error) {
      logger.warn(
        `[StellarDexPriceFeedProvider] Spot path finding failed for ${formattedSourceAsset}`,
        { error }
      )
      return null
    }
  }

  /**
   * Retrieve historical or spot price quote for an asset.
   */
  async getPrice(
    assetSymbol: string,
    asOfDate?: Date
  ): Promise<PriceFeedResult | null> {
    const upper = assetSymbol.trim().toUpperCase()
    if (upper === 'USDC') {
      return {
        price: new Decimal(1),
        confidence: 'HIGH',
        granularity: asOfDate ? 'DAILY_CLOSE' : 'SPOT',
        asOfDate: asOfDate ?? new Date(),
        caveat: null,
        sourceName: this.name,
      }
    }

    const assetParams = this.resolveAssetParams(upper)

    if (!asOfDate) {
      return this.fetchSpotQuote(assetParams.formattedAsset)
    }

    const startOfDayMs = Date.UTC(
      asOfDate.getUTCFullYear(),
      asOfDate.getUTCMonth(),
      asOfDate.getUTCDate(),
      0,
      0,
      0,
      0
    )
    const endOfDayMs = Date.UTC(
      asOfDate.getUTCFullYear(),
      asOfDate.getUTCMonth(),
      asOfDate.getUTCDate(),
      23,
      59,
      59,
      999
    )

    const exactUrl = this.buildAggregationUrl(
      assetParams,
      startOfDayMs,
      endOfDayMs
    )
    const exactRecord = await this.fetchTradeAggregation(exactUrl)

    if (exactRecord) {
      const priceStr = exactRecord.close ?? exactRecord.avg
      if (priceStr && !Number.isNaN(Number(priceStr))) {
        const tradeCount = Number(exactRecord.count ?? 0)
        const counterVol = Number(exactRecord.counter_volume ?? 0)
        const isThin = tradeCount < 5 || counterVol < 50

        return {
          price: new Decimal(priceStr),
          confidence: isThin ? 'LOW' : 'HIGH',
          granularity: 'DAILY_CLOSE',
          asOfDate,
          caveat: isThin
            ? 'Thin trading volume on Stellar DEX for date; price may exhibit elevated variance'
            : null,
          sourceName: this.name,
        }
      }
    }

    const lookbackStartMs =
      startOfDayMs - LOOKBACK_DAYS_FALLBACK * MILLISECONDS_IN_DAY
    const lookbackUrl = this.buildAggregationUrl(
      assetParams,
      lookbackStartMs,
      endOfDayMs
    )
    const lookbackRecord = await this.fetchTradeAggregation(lookbackUrl)

    if (lookbackRecord) {
      const priceStr = lookbackRecord.close ?? lookbackRecord.avg
      if (priceStr && !Number.isNaN(Number(priceStr))) {
        const recordTs = Number(lookbackRecord.timestamp ?? startOfDayMs)
        const dayDifference = Math.max(
          1,
          Math.round(Math.abs(startOfDayMs - recordTs) / MILLISECONDS_IN_DAY)
        )

        return {
          price: new Decimal(priceStr),
          confidence: 'LOW',
          granularity: 'FALLBACK_NEAREST',
          asOfDate,
          caveat: `Feed has no exact historical trades for date; using nearest available trade aggregation (${dayDifference}d gap)`,
          sourceName: this.name,
        }
      }
    }

    const ageMs = Math.abs(Date.now() - asOfDate.getTime())
    if (ageMs <= MILLISECONDS_IN_DAY) {
      const spotQuote = await this.fetchSpotQuote(assetParams.formattedAsset)
      if (spotQuote) {
        return {
          ...spotQuote,
          confidence: 'LOW',
          asOfDate,
          caveat:
            'Historical trade data unavailable for date; fell back to spot quote',
        }
      }
    }

    return null
  }
}
