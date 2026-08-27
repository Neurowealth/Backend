/**
 * WebSocket handshake authentication and topic scoping (#316).
 *
 * Runs the SAME checks as src/middleware/authenticate.ts — signature, live
 * session row, expiry, active user — rather than a socket-flavoured variant of
 * them, because "the WebSocket auth path" is exactly the sort of place a second
 * set of rules rots. There is no anonymous fallback: a handshake that does not
 * authenticate is closed before a single byte of user data is written.
 *
 * ── Where the token comes from ────────────────────────────────────────────────
 * `Authorization: Bearer <jwt>` for server-side clients, or the
 * `Sec-WebSocket-Protocol: bearer, <jwt>` subprotocol pair for browsers, which
 * cannot set headers on a WebSocket. A `?token=` query parameter is deliberately
 * NOT accepted: URLs land in access logs, proxy logs, and referrers, and this
 * token is a live session.
 */

import type { IncomingMessage } from 'node:http'
import { SubAccountPermission } from '@prisma/client'
import { JwtAdapter } from '../config'
import db from '../db'
import { logger } from '../utils/logger'
import { USER_EVENT_TOPICS, type UserEventTopic } from '../events/types'

export interface AuthenticatedHandshake {
  /** Identity that authenticated — always the token holder. */
  viewerUserId: string
  /** Stream to bind to: the viewer's own, or a permitted child's. */
  streamUserId: string
  sessionId: string
  token: string
  /** Topics this connection is allowed to subscribe to. */
  allowedTopics: UserEventTopic[]
  delegated: boolean
}

export type HandshakeFailure =
  | { ok: false; code: 4401; reason: 'unauthorized'; message: string }
  | { ok: false; code: 4403; reason: 'forbidden'; message: string }

export type HandshakeResult =
  { ok: true; auth: AuthenticatedHandshake } | HandshakeFailure

/**
 * Topics a parent may see on a child's stream, per sub-account permission.
 *
 * VIEW is read-only visibility, so it opens the read-only topics. Strategy
 * changes are a management concern and ride on MANAGE_STRATEGY — the same split
 * the REST routes enforce. DEPOSIT/WITHDRAW grant the ability to move money on
 * the child's behalf, and the resulting confirmations are already covered by
 * `transactions` under VIEW, so they add no topics of their own.
 */
const TOPICS_BY_PERMISSION: Partial<
  Record<SubAccountPermission, UserEventTopic[]>
> = {
  VIEW: ['portfolio', 'transactions', 'agent', 'alerts'],
  MANAGE_STRATEGY: ['strategies'],
}

const unauthorized = (message: string): HandshakeFailure => ({
  ok: false,
  code: 4401,
  reason: 'unauthorized',
  message,
})

const forbidden = (message: string): HandshakeFailure => ({
  ok: false,
  code: 4403,
  reason: 'forbidden',
  message,
})

/**
 * Extract the bearer token from the Authorization header or the
 * `Sec-WebSocket-Protocol` pair. Returns null when neither carries one.
 */
export function extractHandshakeToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim()
    if (token.length > 0) return token
  }

  const protocols = req.headers['sec-websocket-protocol']
  if (typeof protocols === 'string') {
    const parts = protocols.split(',').map((p) => p.trim())
    const marker = parts.findIndex((p) => p === 'bearer')
    if (marker !== -1 && parts[marker + 1]) return parts[marker + 1]
  }

  return null
}

/** Read the optional `?actor=<userId>` scoping parameter off the upgrade URL. */
export function extractActorParam(req: IncomingMessage): string | null {
  try {
    const url = new URL(req.url ?? '/', 'http://placeholder')
    const actor = url.searchParams.get('actor')?.trim()
    return actor && actor.length > 0 ? actor : null
  } catch {
    return null
  }
}

/**
 * Verify the session behind a token, exactly as requireAuth does.
 * Reused by the periodic recheck on live connections, which is why it is
 * separate from the handshake itself.
 */
export async function verifySessionToken(
  token: string
): Promise<
  | { ok: true; userId: string; sessionId: string }
  | { ok: false; message: string }
> {
  const payload = await JwtAdapter.validateToken<{ id: string }>(token)
  if (!payload) return { ok: false, message: 'Invalid token' }

  const session = await db.session.findUnique({
    where: { token },
    include: { user: { select: { id: true, isActive: true } } },
  })

  if (!session) return { ok: false, message: 'Session not found' }
  if (session.expiresAt < new Date())
    return { ok: false, message: 'Session expired' }
  if (!session.user.isActive)
    return { ok: false, message: 'User account is inactive' }

  return { ok: true, userId: session.user.id, sessionId: session.id }
}

/**
 * Authenticate an upgrade request and resolve the stream it may read.
 *
 * For a delegated connection (`?actor=` naming someone other than the token
 * holder) the sub-account grant is looked up server-side and the topic set is
 * derived from its permissions — the client's opinion about what it may read is
 * never consulted, only its opinion about what it wants.
 */
export async function authenticateHandshake(
  req: IncomingMessage
): Promise<HandshakeResult> {
  const token = extractHandshakeToken(req)
  if (!token) {
    return unauthorized('Missing bearer token')
  }

  let session: Awaited<ReturnType<typeof verifySessionToken>>
  try {
    session = await verifySessionToken(token)
  } catch (error) {
    logger.error('[WS] Handshake verification error', {
      error: error instanceof Error ? error.message : String(error),
    })
    return unauthorized('Authentication failed')
  }

  if (!session.ok) return unauthorized(session.message)

  const viewerUserId = session.userId
  const actor = extractActorParam(req)

  if (!actor || actor === viewerUserId) {
    return {
      ok: true,
      auth: {
        viewerUserId,
        streamUserId: viewerUserId,
        sessionId: session.sessionId,
        token,
        allowedTopics: [...USER_EVENT_TOPICS],
        delegated: false,
      },
    }
  }

  // Delegated: the same ACTIVE-grant rule requireSubAccountPermission applies.
  let grant
  try {
    grant = await db.subAccount.findUnique({
      where: {
        parentUserId_childUserId: {
          parentUserId: viewerUserId,
          childUserId: actor,
        },
      },
      select: { permissions: true, status: true },
    })
  } catch (error) {
    logger.error('[WS] Sub-account lookup failed during handshake', {
      error: error instanceof Error ? error.message : String(error),
    })
    return forbidden('Forbidden')
  }

  if (!grant || grant.status !== 'ACTIVE') {
    return forbidden('No active sub-account grant for the requested actor')
  }

  const allowedTopics = Array.from(
    new Set(grant.permissions.flatMap((p) => TOPICS_BY_PERMISSION[p] ?? []))
  ) as UserEventTopic[]

  if (allowedTopics.length === 0) {
    return forbidden('Sub-account grant carries no readable topics')
  }

  logger.info('[WS] Delegated stream access granted', {
    parentUserId: viewerUserId,
    childUserId: actor,
    topics: allowedTopics,
  })

  return {
    ok: true,
    auth: {
      viewerUserId,
      streamUserId: actor,
      sessionId: session.sessionId,
      token,
      allowedTopics,
      delegated: true,
    },
  }
}
