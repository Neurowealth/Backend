/**
 * #498 — Expanded unit coverage for request validation, sanitization, and
 * security-related helper functions.
 *
 * The acceptance criteria ask for direct unit tests on the critical validation
 * helpers, malformed inputs, and the edge cases around sanitization. The
 * helpers covered here are the ones every request and every emitted event
 * flows through:
 *
 *   - src/validators/email-validators.ts   (email normalization contract)
 *   - src/validators/webhook-validators.ts (inbound Twilio webhook + outbound
 *                                           webhook subscription config)
 *   - src/validators/alert-validators.ts   (user-authored alert rules, incl.
 *                                           the recursive condition tree)
 *   - src/validators/event-validator.ts    (on-chain contract events)
 *   - src/utils/pagination.ts              (query-string coercion)
 *   - src/utils/errorResponse.ts           (the canonical error contract)
 *   - src/utils/api-formatters.ts          (mapUserEventPayloadToResponse —
 *                                           the socket-payload allowlist that
 *                                           keeps unreviewed fields off the
 *                                           user's realtime stream)
 */

import {
  emailAddressSchema,
  requestEmailVerificationSchema,
  verifyEmailTokenSchema,
} from '../../../src/validators/email-validators'
import {
  whatsappWebhookSchema,
  createWebhookSchema,
  updateWebhookSchema,
} from '../../../src/validators/webhook-validators'
import {
  createAlertRuleSchema,
  updateAlertRuleSchema,
  compositeAlertRuleSchema,
  ALERT_METRICS,
} from '../../../src/validators/alert-validators'
import {
  DepositEventSchema,
  WithdrawEventSchema,
  ContractEventSchema,
} from '../../../src/validators/event-validator'
import {
  paginationSchema,
  getPaginationParams,
} from '../../../src/utils/pagination'
import {
  buildErrorResponse,
  ErrorResponses,
  ErrorCodes,
} from '../../../src/utils/errorResponse'
import { mapUserEventPayloadToResponse } from '../../../src/utils/api-formatters'

describe('email-validators (#498)', () => {
  it('normalizes email addresses to a single canonical identity form', () => {
    // Stored emails are trimmed + lowercased so casing/whitespace can never
    // create a second identity for the same mailbox.
    expect(emailAddressSchema.parse('  User@Example.COM \n')).toBe(
      'user@example.com'
    )
  })

  it('rejects malformed emails', () => {
    expect(emailAddressSchema.safeParse('not-an-email').success).toBe(false)
    expect(emailAddressSchema.safeParse('missing@tld').success).toBe(false)
    expect(emailAddressSchema.safeParse('').success).toBe(false)
    // Whitespace-only input trims to '' and must fail the min(1) check.
    expect(emailAddressSchema.safeParse('   ').success).toBe(false)
  })

  it('requires an email for verification requests and a token for verification', () => {
    expect(requestEmailVerificationSchema.safeParse({}).success).toBe(false)
    expect(
      requestEmailVerificationSchema.safeParse({ email: 'a@b.co' }).success
    ).toBe(true)

    expect(verifyEmailTokenSchema.safeParse({ token: '  ' }).success).toBe(
      false
    )
    expect(verifyEmailTokenSchema.safeParse({ token: ' tok ' }).success).toBe(
      true
    )
    // Parsing yields the trimmed token, not the raw input.
    expect(verifyEmailTokenSchema.parse({ token: ' tok ' }).token).toBe('tok')
  })
})

describe('webhook-validators (#498)', () => {
  it('accepts a WhatsApp webhook carrying text, media, or both', () => {
    expect(
      whatsappWebhookSchema.safeParse({
        From: 'whatsapp:+15551234567',
        Body: 'hi',
      }).success
    ).toBe(true)
    expect(
      whatsappWebhookSchema.safeParse({
        From: 'whatsapp:+15551234567',
        NumMedia: '1',
        MediaUrl0: 'https://example.com/audio.ogg',
        MediaContentType0: 'audio/ogg',
      }).success
    ).toBe(true)
  })

  it('rejects content-free WhatsApp webhooks (no Body and no media)', () => {
    // Without the refinement, an empty payload would pass straight through to
    // signature validation — it must be rejected with 400 instead.
    expect(
      whatsappWebhookSchema.safeParse({ From: 'whatsapp:+15551234567' }).success
    ).toBe(false)
    expect(
      whatsappWebhookSchema.safeParse({
        From: 'whatsapp:+15551234567',
        Body: '   ',
      }).success
    ).toBe(false)
    // A media marker without a valid URL is rejected too.
    expect(
      whatsappWebhookSchema.safeParse({
        From: 'whatsapp:+15551234567',
        NumMedia: '1',
        MediaUrl0: 'not-a-url',
      }).success
    ).toBe(false)
  })

  it('keeps Twilio passthrough fields so body signature validation still matches', () => {
    const parsed = whatsappWebhookSchema.parse({
      From: 'whatsapp:+15551234567',
      Body: 'hi',
      To: 'whatsapp:+15550000000',
      ProfileName: 'Twilio Sandbox',
    })
    // Twilio signs the raw body; the parse must not add or drop keys.
    expect(parsed.To).toBe('whatsapp:+15550000000')
    expect(parsed.ProfileName).toBe('Twilio Sandbox')
  })

  it('validates webhook subscription configuration', () => {
    expect(
      createWebhookSchema.safeParse({
        url: 'https://ops.example.com/hook',
        events: ['deposit.received'],
      }).success
    ).toBe(true)
    expect(
      createWebhookSchema.safeParse({
        url: 'not-a-url',
        events: ['deposit.received'],
      }).success
    ).toBe(false)
    // An empty event list would silently subscribe to nothing.
    expect(
      createWebhookSchema.safeParse({
        url: 'https://ops.example.com/hook',
        events: [],
      }).success
    ).toBe(false)
    // Unknown event types are rejected — typos must not create dead subscriptions.
    expect(
      createWebhookSchema.safeParse({
        url: 'https://ops.example.com/hook',
        events: ['not.a.real.event'],
      }).success
    ).toBe(false)
    expect(updateWebhookSchema.safeParse({ isActive: true }).success).toBe(true)
    // Documented current behavior: unlike updateAlertRuleSchema (which
    // explicitly rejects empty PATCHes), every field here is optional, so a
    // no-op `{}` PATCH parses successfully and updates nothing.
    expect(updateWebhookSchema.safeParse({}).success).toBe(true)
  })

  it('exposes the durable-outbox failure event for operator subscriptions', () => {
    // outbox.op_failed (#325) is the notification leg of a money-moving op
    // exhausting its retries; operators must be able to subscribe to it.
    expect(
      createWebhookSchema.safeParse({
        url: 'https://ops.example.com/hook',
        events: ['outbox.op_failed'],
      }).success
    ).toBe(true)
  })
})

describe('alert-validators (#498)', () => {
  it('requires protocolName only for PROTOCOL_APY rules', () => {
    const apy = {
      metric: 'PROTOCOL_APY',
      comparator: 'LT',
      threshold: 5,
      deliveryChannel: 'WEBHOOK',
    }
    expect(createAlertRuleSchema.safeParse(apy).success).toBe(false)

    const withProtocol = { ...apy, protocolName: 'Valor' }
    expect(createAlertRuleSchema.safeParse(withProtocol).success).toBe(true)

    // protocolName is meaningless for portfolio-wide metrics — reject it so
    // rules cannot carry silently ignored fields.
    const drawdown = {
      metric: 'POSITION_DRAWDOWN',
      comparator: 'GT',
      threshold: 20,
      deliveryChannel: 'WHATSAPP',
      protocolName: 'Valor',
    }
    expect(createAlertRuleSchema.safeParse(drawdown).success).toBe(false)
  })

  it('bounds cooldownMinutes to the documented 1..10080 range', () => {
    const base = {
      metric: 'PORTFOLIO_VALUE',
      comparator: 'GTE',
      threshold: 1000,
      deliveryChannel: 'WEBHOOK',
    }
    expect(
      createAlertRuleSchema.safeParse({ ...base, cooldownMinutes: 0 }).success
    ).toBe(false)
    expect(
      createAlertRuleSchema.safeParse({ ...base, cooldownMinutes: 1 }).success
    ).toBe(true)
    expect(
      createAlertRuleSchema.safeParse({ ...base, cooldownMinutes: 10080 })
        .success
    ).toBe(true)
    expect(
      createAlertRuleSchema.safeParse({ ...base, cooldownMinutes: 10081 })
        .success
    ).toBe(false)
  })

  it('rejects empty PATCH payloads on alert rules', () => {
    expect(updateAlertRuleSchema.safeParse({}).success).toBe(false)
    expect(updateAlertRuleSchema.safeParse({ isActive: false }).success).toBe(
      true
    )
  })

  it('validates the recursive alert condition tree', () => {
    const singleCondition = {
      root: {
        operator: 'CONDITION',
        metric: 'PROTOCOL_APY',
        comparator: 'LT',
        threshold: 5,
      },
      deliveryChannel: 'WEBHOOK',
    }
    expect(compositeAlertRuleSchema.safeParse(singleCondition).success).toBe(
      true
    )

    const andTree = {
      root: {
        operator: 'AND',
        children: [
          {
            operator: 'CONDITION',
            metric: 'PROTOCOL_APY',
            comparator: 'LT',
            threshold: 5,
          },
          {
            operator: 'CONDITION',
            metric: 'DRIFT',
            comparator: 'GT',
            threshold: 0.2,
          },
        ],
      },
      deliveryChannel: 'WEBHOOK',
    }
    expect(compositeAlertRuleSchema.safeParse(andTree).success).toBe(true)

    // AND/OR require at least two children; NOT requires exactly one.
    const loneAnd = {
      root: {
        operator: 'AND',
        children: [
          {
            operator: 'CONDITION',
            metric: 'DRIFT',
            comparator: 'GT',
            threshold: 1,
          },
        ],
      },
      deliveryChannel: 'WEBHOOK',
    }
    expect(compositeAlertRuleSchema.safeParse(loneAnd).success).toBe(false)

    const doubleNot = {
      root: {
        operator: 'NOT',
        children: [
          {
            operator: 'CONDITION',
            metric: 'DRIFT',
            comparator: 'GT',
            threshold: 1,
          },
          {
            operator: 'CONDITION',
            metric: 'ANOMALY',
            comparator: 'GT',
            threshold: 1,
          },
        ],
      },
      deliveryChannel: 'WEBHOOK',
    }
    expect(compositeAlertRuleSchema.safeParse(doubleNot).success).toBe(false)

    // A NOT nested inside an AND must resolve through the lazy schema.
    const nested = {
      root: {
        operator: 'AND',
        children: [
          {
            operator: 'NOT',
            children: [
              {
                operator: 'CONDITION',
                metric: 'ANOMALY',
                comparator: 'GT',
                threshold: 0,
              },
            ],
          },
          {
            operator: 'CONDITION',
            metric: 'DRIFT',
            comparator: 'LTE',
            threshold: 0.5,
          },
        ],
      },
      deliveryChannel: 'BOTH',
    }
    expect(compositeAlertRuleSchema.safeParse(nested).success).toBe(true)
  })

  it('exposes the metric enum the alert evaluator relies on', () => {
    expect(ALERT_METRICS).toContain('ANOMALY')
    expect(ALERT_METRICS).toContain('VOLATILITY_REGIME')
  })
})

describe('event-validator (#498)', () => {
  const deposit = {
    user: 'GABCDEF',
    amount: '10.5',
    shares: '9.8',
    assetSymbol: 'XLM',
    protocolName: 'Valor',
    network: 'TESTNET',
  }

  it('accepts a well-formed deposit event', () => {
    expect(DepositEventSchema.safeParse(deposit).success).toBe(true)
  })

  it('rejects malformed amounts and unknown networks', () => {
    expect(
      DepositEventSchema.safeParse({ ...deposit, amount: '-1' }).success
    ).toBe(false)
    expect(
      DepositEventSchema.safeParse({ ...deposit, amount: 'NaN' }).success
    ).toBe(false)
    expect(
      DepositEventSchema.safeParse({
        ...deposit,
        amount: '10',
        shares: undefined,
      }).success
    ).toBe(false)
    expect(
      DepositEventSchema.safeParse({ ...deposit, network: 'MAINNET' }).success
    ).toBe(true)
    expect(
      DepositEventSchema.safeParse({ ...deposit, network: 'DEVNET' }).success
    ).toBe(false)
    expect(WithdrawEventSchema.safeParse(deposit).success).toBe(true)
  })

  it('validates the contract event envelope (type, ledger, txHash, contractId)', () => {
    const event = {
      type: 'deposit',
      ledger: 12345,
      txHash: 'abc',
      contractId: 'CABCDEF',
    }
    expect(ContractEventSchema.safeParse(event).success).toBe(true)
    expect(
      ContractEventSchema.safeParse({ ...event, type: 'transfer' }).success
    ).toBe(false)
    expect(
      ContractEventSchema.safeParse({ ...event, ledger: -1 }).success
    ).toBe(false)
    expect(
      ContractEventSchema.safeParse({ ...event, txHash: '' }).success
    ).toBe(false)
  })
})

describe('pagination helpers (#498)', () => {
  it('coerces query strings into bounded integers', () => {
    const parsed = paginationSchema.parse({ page: '3', limit: '10' })
    expect(parsed).toEqual({ page: 3, limit: 10 })
  })

  it('falls back to defaults for missing or garbage input', () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, limit: 5 })
    // Non-numeric garbage cannot be coerced — the schema must reject it
    // rather than silently produce NaN.
    expect(paginationSchema.safeParse({ page: 'abc' }).success).toBe(false)
  })

  it('computes Prisma-compatible skip offsets', () => {
    expect(getPaginationParams({ page: 1, limit: 5 })).toEqual({
      page: 1,
      limit: 5,
      skip: 0,
    })
    expect(getPaginationParams({ page: 3, limit: 10 })).toEqual({
      page: 3,
      limit: 10,
      skip: 20,
    })
    // Garbage query values degrade to page 1 / default limit, not NaN math.
    expect(getPaginationParams({ page: 'x', limit: 'y' })).toEqual({
      page: 1,
      limit: 5,
      skip: 0,
    })
  })
})

describe('errorResponse contract (#498)', () => {
  it('emits the canonical flat envelope with status, requestId and ISO timestamp', () => {
    const res = buildErrorResponse(400, 'BAD_REQUEST', 'nope', 'req-1', {
      field: 'amount',
    })
    expect(res).toMatchObject({
      status: 400,
      code: 'BAD_REQUEST',
      message: 'nope',
      details: { field: 'amount' },
      requestId: 'req-1',
    })
    // Legacy clients keep reading the deprecated `error` alias of `message`.
    expect(res.error).toBe('nope')
    expect(new Date(res.timestamp).toISOString()).toBe(res.timestamp)
  })

  it('omits details when none are provided', () => {
    const res = buildErrorResponse(404, 'NOT_FOUND', 'missing', 'req-2')
    expect(res).not.toHaveProperty('details')
    expect(res.code).toBe('NOT_FOUND')
    expect(res.status).toBe(404)
  })

  it('maps every convenience builder to its canonical code', () => {
    expect(ErrorResponses.badRequest('m', 'r').code).toBe(
      ErrorCodes.BAD_REQUEST
    )
    expect(ErrorResponses.unauthorized('m', 'r').code).toBe(
      ErrorCodes.UNAUTHORIZED
    )
    expect(ErrorResponses.forbidden('m', 'r').code).toBe(ErrorCodes.FORBIDDEN)
    expect(ErrorResponses.notFound('m', 'r').code).toBe(ErrorCodes.NOT_FOUND)
    expect(ErrorResponses.conflict('m', 'r').code).toBe(ErrorCodes.CONFLICT)
    expect(ErrorResponses.rateLimited('m', 'r').code).toBe(
      ErrorCodes.RATE_LIMITED
    )
    expect(ErrorResponses.validationError('m', 'r').code).toBe(
      ErrorCodes.VALIDATION_ERROR
    )
    expect(ErrorResponses.internalError('m', 'r').code).toBe(
      ErrorCodes.INTERNAL_ERROR
    )
    expect(ErrorResponses.serviceUnavailable('m', 'r').code).toBe(
      ErrorCodes.SERVICE_UNAVAILABLE
    )
  })
})

describe('mapUserEventPayloadToResponse — socket payload redaction (#498)', () => {
  it('projects payloads onto the per-type allowlist', () => {
    const out = mapUserEventPayloadToResponse('deposit.received', {
      txHash: 'abc',
      amount: '10',
      shares: '9.8',
      assetSymbol: 'XLM',
      protocolName: 'Valor',
      network: 'TESTNET',
    })
    expect(out).toEqual({
      txHash: 'abc',
      amount: '10',
      shares: '9.8',
      assetSymbol: 'XLM',
      protocolName: 'Valor',
      network: 'TESTNET',
    })
  })

  it('never leaks fields outside the allowlist (e.g. the wallet address)', () => {
    // `user` is deliberately absent from the deposit allowlist: a delegated
    // parent connection must not learn the child's wallet from a frame.
    const out = mapUserEventPayloadToResponse('deposit.received', {
      user: 'GSECRETWALLET',
      txHash: 'abc',
      amount: '10',
      internalNote: 'raw-provider-response',
    })
    expect(out).not.toHaveProperty('user')
    expect(out).not.toHaveProperty('internalNote')
    expect(out).toHaveProperty('txHash')
  })

  it('returns an empty object for unknown event types and drops undefined values', () => {
    // A type nobody has reviewed is a type whose fields nobody has reviewed.
    expect(mapUserEventPayloadToResponse('made.up.event', { a: 1 })).toEqual({})
    const out = mapUserEventPayloadToResponse('deposit.received', {
      txHash: 'abc',
      shares: undefined,
    })
    expect(out).toEqual({ txHash: 'abc' })
  })
})
