/**
 * FX conversion utility (#534).
 *
 * Converts USD amounts to a user's preferred display currency.
 * Uses a simple static rate table for common currencies.
 * Gracefully returns null when rate is unavailable — callers omit displayAmount.
 */

const FX_RATES: Record<string, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  JPY: 149.5,
  CAD: 1.36,
  AUD: 1.53,
  CHF: 0.88,
  CNY: 7.24,
  INR: 83.12,
  BRL: 4.97,
  MXN: 17.05,
  SGD: 1.34,
  HKD: 7.82,
  KRW: 1320.0,
}

export function getSupportedCurrencies(): string[] {
  return Object.keys(FX_RATES)
}

export function isCurrencySupported(currency: string): boolean {
  return currency in FX_RATES
}

/**
 * Convert a USD amount to the target currency.
 * Returns null if the currency is not supported.
 * Result is rounded to 2 decimal places for display only.
 */
export function convertUsdToCurrency(
  amountUsd: number,
  targetCurrency: string
): number | null {
  const rate = FX_RATES[targetCurrency]
  if (rate == null) return null
  return Math.round(amountUsd * rate * 100) / 100
}

/**
 * Attach displayAmount/displayCurrency to a response object.
 * Never replaces the canonical USD amount.
 * Gracefully omits displayAmount when FX rate unavailable.
 */
export function withDisplayCurrency<T extends { amountUsd: number }>(
  obj: T,
  targetCurrency: string
): T & { displayAmount?: number; displayCurrency: string } {
  const displayAmount = convertUsdToCurrency(obj.amountUsd, targetCurrency)
  return {
    ...obj,
    displayAmount: displayAmount ?? undefined,
    displayCurrency: targetCurrency,
  }
}
