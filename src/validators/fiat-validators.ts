import { z } from 'zod'
import { MAX_FIAT_AMOUNT, MIN_FIAT_AMOUNT } from '../config/financial-limits'

/** Fiat on-ramp / off-ramp request validators (#290). */

export const fiatDirectionSchema = z.enum(['ON_RAMP', 'OFF_RAMP'])

// ISO 4217-ish: 3-letter currency code. Kept permissive (upper-cased) rather
// than an exhaustive enum so new fiat currencies don't require a code change.
const fiatCurrencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'fiatCurrency must be a 3-letter ISO code')
  .transform((s) => s.toUpperCase())

const fiatAmountSchema = z
  .number()
  .finite('fiatAmount must be a finite number')
  .min(MIN_FIAT_AMOUNT, `fiatAmount must be at least ${MIN_FIAT_AMOUNT}`)
  .max(MAX_FIAT_AMOUNT, `fiatAmount must not exceed ${MAX_FIAT_AMOUNT}`)

const assetSymbolSchema = z.string().trim().min(1).max(20)

export const fiatQuoteSchema = z.object({
  direction: fiatDirectionSchema,
  fiatAmount: fiatAmountSchema,
  fiatCurrency: fiatCurrencySchema,
  assetSymbol: assetSymbolSchema,
})

/** GET /api/v1/fiat/quotes — same shape, read as query params (#313). */
export const bestExecutionQuoteQuerySchema = z.object({
  direction: fiatDirectionSchema,
  fiatAmount: z.coerce.number().pipe(fiatAmountSchema),
  fiatCurrency: fiatCurrencySchema,
  assetSymbol: assetSymbolSchema,
})

export const createFiatOrderSchema = z.object({
  userId: z.string().uuid(),
  direction: fiatDirectionSchema,
  fiatAmount: fiatAmountSchema,
  fiatCurrency: fiatCurrencySchema,
  assetSymbol: assetSymbolSchema,
  // Best-execution (#313): either pin a specific provider, reference a
  // locked quote from GET /fiat/quotes, or supply neither and let the
  // registry's default selection policy choose. quoteId takes precedence
  // when both are present since it carries an already-priced, time-boxed rate.
  provider: z.string().trim().min(1).max(50).optional(),
  quoteId: z.string().uuid().optional(),
})

export const fiatOrderHistoryParamsSchema = z.object({
  userId: z.string().uuid(),
})

export type FiatQuoteInput = z.infer<typeof fiatQuoteSchema>
export type BestExecutionQuoteQuery = z.infer<
  typeof bestExecutionQuoteQuerySchema
>
export type CreateFiatOrderInput = z.infer<typeof createFiatOrderSchema>
