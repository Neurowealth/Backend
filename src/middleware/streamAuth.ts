import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { JwtAdapter } from '../config'
import db from '../db'
import { logger } from '../utils/logger'
import { USER_EVENT_TOPICS, type UserEventTopic } from '../events/types'
import { verifySessionToken } from '../ws/auth'

const STREAM_TICKET_SECRET =
  process.env.JWT_SECRET || 'neuro-stream-ticket-secret-key-32b'
const usedTicketIds = new Set<string>()

export interface StreamTicketPayload {
  ticketId: string
  viewerUserId: string
  streamUserId: string
  allowedTopics: UserEventTopic[]
  exp: number
}

/**
 * Creates a signed, single-use, ~60s TTL stream ticket for browser EventSource SSE connections.
 */
export function createStreamTicket(
  viewerUserId: string,
  streamUserId: string = viewerUserId,
  allowedTopics: UserEventTopic[] = [...USER_EVENT_TOPICS]
): string {
  const ticketId = crypto.randomUUID()
  const exp = Math.floor(Date.now() / 1000) + 60 // 60s TTL

  const payload: StreamTicketPayload = {
    ticketId,
    viewerUserId,
    streamUserId,
    allowedTopics,
    exp,
  }

  const payloadStr = JSON.stringify(payload)
  const signature = crypto
    .createHmac('sha256', STREAM_TICKET_SECRET)
    .update(payloadStr)
    .digest('base64url')

  const token = `${Buffer.from(payloadStr).toString('base64url')}.${signature}`
  return token
}

/**
 * Validates a single-use stream ticket. Returns null if expired, tampered with, or already used.
 */
export function verifyStreamTicket(
  ticketToken: string
): StreamTicketPayload | null {
  try {
    const parts = ticketToken.split('.')
    if (parts.length !== 2) return null

    const [payloadB64, signature] = parts
    const payloadStr = Buffer.from(payloadB64, 'base64url').toString('utf8')

    const expectedSig = crypto
      .createHmac('sha256', STREAM_TICKET_SECRET)
      .update(payloadStr)
      .digest('base64url')

    if (signature !== expectedSig) return null

    const payload: StreamTicketPayload = JSON.parse(payloadStr)

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null
    }

    // Single-use check
    if (usedTicketIds.has(payload.ticketId)) {
      logger.warn('[StreamAuth] Stream ticket replay attempt detected', {
        ticketId: payload.ticketId,
      })
      return null
    }

    usedTicketIds.add(payload.ticketId)

    // Auto-clean ticket ID after TTL
    setTimeout(() => {
      usedTicketIds.delete(payload.ticketId)
    }, 65000)

    return payload
  } catch (error) {
    return null
  }
}

/**
 * Transport-neutral authentication for streaming requests (WS / SSE).
 * Supports Authorization Bearer header, Sec-WebSocket-Protocol header, or ?ticket= URL param.
 */
export async function authenticateStreamRequest(
  headers: Record<string, string | string[] | undefined>,
  query: Record<string, string | string[] | undefined>
): Promise<{
  ok: boolean
  viewerUserId?: string
  streamUserId?: string
  allowedTopics?: UserEventTopic[]
  error?: string
}> {
  // 1. Check ticket param (for SSE EventSource)
  const ticket = typeof query.ticket === 'string' ? query.ticket.trim() : null
  if (ticket) {
    const ticketPayload = verifyStreamTicket(ticket)
    if (!ticketPayload) {
      return {
        ok: false,
        error: 'Invalid, expired, or already-used stream ticket',
      }
    }
    return {
      ok: true,
      viewerUserId: ticketPayload.viewerUserId,
      streamUserId: ticketPayload.streamUserId,
      allowedTopics: ticketPayload.allowedTopics,
    }
  }

  // 2. Check Authorization header
  const authHeader =
    typeof headers.authorization === 'string' ? headers.authorization : null
  let bearerToken: string | null = null
  if (authHeader?.startsWith('Bearer ')) {
    bearerToken = authHeader.slice(7).trim()
  }

  if (bearerToken) {
    const verified = await verifySessionToken(bearerToken)
    if (!verified.ok) {
      return { ok: false, error: verified.message }
    }
    return {
      ok: true,
      viewerUserId: verified.userId,
      streamUserId: verified.userId,
      allowedTopics: [...USER_EVENT_TOPICS],
    }
  }

  return { ok: false, error: 'Missing bearer token or stream ticket' }
}
