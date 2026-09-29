import { Decimal } from '@prisma/client/runtime/library'
import {
  PriceConfidence,
  PriceFeedProvider,
  PriceFeedResult,
  PriceGranularity,
} from './types'

export interface SeedPriceOptions {
  asOfDate?: Date
  confidence?: PriceConfidence
  granularity?: PriceGranularity
  caveat?: string | null
}

/**
 * Deterministic mock price feed provider for testing and sandbox environments.
 */
export class MockPriceFeedProvider implements PriceFeedProvider {
  readonly name = 'mock'
  private readonly prices = new Map<string, PriceFeedResult>()
  private simulateOutage = false

  private buildKey(assetSymbol: string, asOfDate?: Date): string {
    const datePart = asOfDate ? asOfDate.toISOString().slice(0, 10) : 'spot'
    return `${assetSymbol.toUpperCase()}:${datePart}`
  }

  /**
   * Seed a deterministic price for an asset and optional date.
   */
  seedPrice(
    assetSymbol: string,
    price: Decimal | string | number,
    options?: SeedPriceOptions
  ): void {
    const key = this.buildKey(assetSymbol, options?.asOfDate)
    this.prices.set(key, {
      price: new Decimal(price),
      confidence: options?.confidence ?? 'HIGH',
      granularity:
        options?.granularity ?? (options?.asOfDate ? 'DAILY_CLOSE' : 'SPOT'),
      asOfDate: options?.asOfDate ?? new Date(),
      caveat: options?.caveat ?? null,
      sourceName: this.name,
    })
  }

  /**
   * Toggle simulated outage state.
   */
  setOutage(enabled: boolean): void {
    this.simulateOutage = enabled
  }

  /**
   * Reset all seeded prices and states.
   */
  clear(): void {
    this.prices.clear()
    this.simulateOutage = false
  }

  /**
   * Resolve seeded price matching asset and target date.
   */
  async getPrice(
    assetSymbol: string,
    asOfDate?: Date
  ): Promise<PriceFeedResult | null> {
    if (this.simulateOutage) {
      throw new Error('Simulated feed outage')
    }

    const exactKey = this.buildKey(assetSymbol, asOfDate)
    const exactMatch = this.prices.get(exactKey)
    if (exactMatch) {
      return exactMatch
    }

    if (asOfDate) {
      const spotKey = this.buildKey(assetSymbol)
      const spotMatch = this.prices.get(spotKey)
      if (spotMatch) {
        return {
          price: spotMatch.price,
          confidence: 'LOW',
          granularity: 'FALLBACK_NEAREST',
          asOfDate,
          caveat:
            'Historical trade data unavailable for exact date; using nearest available quote',
          sourceName: this.name,
        }
      }
    }

    return null
  }
}
