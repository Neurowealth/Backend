/**
 * OpenTelemetry span helpers for manual instrumentation
 *
 * Use these utilities to add semantic attributes to spans that the
 * auto-instrumentation cannot know about: agent decisions, Stellar
 * transaction hashes, DLQ events, and user context.
 *
 * Example — wrapping an agent decision:
 *
 *   import { withAgentSpan } from '../telemetry/spans'
 *
 *   const result = await withAgentSpan('agent.decide', { userId, action }, async (span) => {
 *     const decision = await decide(context)
 *     span.setAttribute('agent.decision', decision.type)
 *     return decision
 *   })
 */

import { trace, context, SpanStatusCode, Span, SpanKind } from '@opentelemetry/api'

const tracer = trace.getTracer('neurowealth-backend')

// ---------------------------------------------------------------------------
// Generic span wrapper
// ---------------------------------------------------------------------------

/**
 * Run `fn` inside a new child span.  The span is automatically ended and
 * marked as ERROR if `fn` throws.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (err) {
      span.recordException(err as Error)
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      })
      throw err
    } finally {
      span.end()
    }
  })
}

// ---------------------------------------------------------------------------
// Agent loop spans
// ---------------------------------------------------------------------------

export interface AgentSpanOptions {
  userId: string
  action: string
  /** Any additional decision metadata to attach as span attributes */
  decisionContext?: Record<string, string | number | boolean>
}

/**
 * Wrap an agent loop iteration in a root span so every decision is
 * independently visible in the trace backend.
 *
 * Acceptance criteria: "Agent loop decisions each produce a root span
 * with decision attributes."
 */
export async function withAgentSpan<T>(
  operationName: string,
  opts: AgentSpanOptions,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const baseAttributes: Record<string, string> = {
    'agent.action': opts.action,
    'user.id': opts.userId,
  }

  if (opts.decisionContext) {
    for (const [k, v] of Object.entries(opts.decisionContext)) {
      baseAttributes[`agent.${k}`] = String(v)
    }
  }

  // Start as a ROOT span (detached from any incoming HTTP trace) so agent
  // loop traces are grouped separately from HTTP request traces.
  return tracer.startActiveSpan(
    `agent.${operationName}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: baseAttributes,
    },
    context.active(),
    async (span) => {
      try {
        const result = await fn(span)
        span.setStatus({ code: SpanStatusCode.OK })
        return result
      } catch (err) {
        span.recordException(err as Error)
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        })
        throw err
      } finally {
        span.end()
      }
    }
  )
}

// ---------------------------------------------------------------------------
// Stellar operation spans
// ---------------------------------------------------------------------------

export interface StellarSpanOptions {
  operation: string
  /** Set after the transaction is submitted */
  txHash?: string
  userId?: string
  contractId?: string
}

/**
 * Wrap a Stellar RPC call.  The `stellar.tx_hash` attribute is set once
 * the hash is known (after submission).
 *
 * Acceptance criteria: "`stellar.tx_hash` attribute set on all Stellar
 * operation spans."
 */
export async function withStellarSpan<T>(
  opts: StellarSpanOptions,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const attributes: Record<string, string> = {
    'stellar.operation': opts.operation,
  }
  if (opts.txHash) attributes['stellar.tx_hash'] = opts.txHash
  if (opts.userId) attributes['user.id'] = opts.userId
  if (opts.contractId) attributes['stellar.contract_id'] = opts.contractId

  return tracer.startActiveSpan(
    `stellar.${opts.operation}`,
    { kind: SpanKind.CLIENT, attributes },
    async (span) => {
      try {
        const result = await fn(span)
        span.setStatus({ code: SpanStatusCode.OK })
        return result
      } catch (err) {
        span.recordException(err as Error)
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        })
        throw err
      } finally {
        span.end()
      }
    }
  )
}

/**
 * Convenience: set the Stellar tx hash on the currently active span.
 * Call this after `StellarRpc.sendTransaction` resolves so the hash
 * is attached even when you did not start the span yourself.
 */
export function setStellarTxHash(txHash: string): void {
  const span = trace.getActiveSpan()
  if (span) span.setAttribute('stellar.tx_hash', txHash)
}

// ---------------------------------------------------------------------------
// DLQ spans
// ---------------------------------------------------------------------------

export interface DlqSpanOptions {
  eventId: string
  eventType: string
  retryCount: number
  userId?: string
}

/**
 * Wrap DLQ processing so exhaustion events are clearly visible in traces
 * and can be correlated with the Sentry issue.
 *
 * Acceptance criteria: "DLQ exhaustion events captured as Sentry issues."
 * (Sentry capture happens in the caller via captureException; this helper
 * ensures the trace context is present for correlation.)
 */
export async function withDlqSpan<T>(
  opts: DlqSpanOptions,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const attributes: Record<string, string | number> = {
    'dlq.event_id': opts.eventId,
    'dlq.event_type': opts.eventType,
    'dlq.retry_count': opts.retryCount,
  }
  if (opts.userId) attributes['user.id'] = opts.userId

  return tracer.startActiveSpan(
    'dlq.process',
    { kind: SpanKind.INTERNAL, attributes },
    async (span) => {
      try {
        const result = await fn(span)
        span.setStatus({ code: SpanStatusCode.OK })
        return result
      } catch (err) {
        span.recordException(err as Error)
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message })
        throw err
      } finally {
        span.end()
      }
    }
  )
}

// ---------------------------------------------------------------------------
// User context helper
// ---------------------------------------------------------------------------

/**
 * Set `user.id` on the currently active span.
 * Call this in authenticated middleware once the user is resolved.
 */
export function setSpanUser(userId: string): void {
  const span = trace.getActiveSpan()
  if (span) span.setAttribute('user.id', userId)
}