/**
 * Authenticated WebSocket server for the real-time stream (#316).
 *
 * Mounted on the existing HTTP server with `noServer: true` and a manual
 * `upgrade` handler, so authentication happens BEFORE the protocol switch: an
 * unauthenticated peer gets an HTTP 401 and never becomes a WebSocket at all.
 * Accepting the upgrade first and closing afterwards would mean every rejected
 * probe still cost a full socket — and would hand an unauthenticated caller a
 * live connection, however briefly.
 *
 * Only paths matching the configured WS path are claimed; any other upgrade
 * request is left alone for whatever else may be listening.
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { config } from '../config/env'
import { logger } from '../utils/logger'
import { recordWsHandshake, setWsConnectionsActive } from '../utils/metrics'
import { getLocalSubscribers } from '../events/hub'
import { authenticateHandshake } from './auth'
import { StreamConnection, WS_CLOSE } from './connection'

let wss: WebSocketServer | null = null
let upgradeHandler:
  ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null
let boundServer: HttpServer | null = null

const connections = new Set<StreamConnection>()

// ── Handshake flood guard ─────────────────────────────────────────────────────
//
// Same philosophy as src/middleware/rateLimiter.ts — fixed window, per source —
// but in-process and keyed on the raw socket address, because there is no
// Express request here and the check must run before any work is done. A
// connection flood is a denial-of-service vector even when every handshake
// fails authentication.

const handshakeWindows = new Map<string, { start: number; count: number }>()

function withinHandshakeRate(ip: string): boolean {
  const { windowMs, max } = config.websocket.handshakeRateLimit
  const now = Date.now()
  const window = handshakeWindows.get(ip)

  if (!window || now - window.start >= windowMs) {
    handshakeWindows.set(ip, { start: now, count: 1 })
    return true
  }

  window.count++
  return window.count <= max
}

/** Drop stale rate-limit windows so the map cannot grow with unique IPs. */
function pruneHandshakeWindows(): void {
  const cutoff = Date.now() - config.websocket.handshakeRateLimit.windowMs
  for (const [ip, window] of handshakeWindows) {
    if (window.start < cutoff) handshakeWindows.delete(ip)
  }
}

function clientIp(req: IncomingMessage): string {
  // Behind the same proxies the REST surface sits behind; TRUST_PROXY governs
  // whether X-Forwarded-For is meaningful, so honour the first hop when present.
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim()
  }
  return req.socket.remoteAddress ?? 'unknown'
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ error: message })
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body
  )
  socket.destroy()
}

function refreshConnectionGauges(): void {
  let self = 0
  let delegated = 0
  for (const connection of connections) {
    if (connection.delegated) delegated++
    else self++
  }
  setWsConnectionsActive('self', self)
  setWsConnectionsActive('delegated', delegated)
}

function countConnectionsFor(viewerUserId: string): number {
  let count = 0
  for (const connection of connections) {
    if (connection.viewerUserId === viewerUserId) count++
  }
  return count
}

/**
 * Attach the WebSocket endpoint to a running HTTP server.
 * Idempotent: calling it twice returns the existing server.
 */
export function attachWebSocketServer(server: HttpServer): WebSocketServer {
  if (wss) return wss

  wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.websocket.maxMessageBytes,
  })
  boundServer = server

  upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://placeholder').pathname
    } catch {
      return
    }

    // Not ours — leave the socket for another upgrade listener.
    if (pathname !== config.websocket.path) return

    pruneHandshakeWindows()

    if (!withinHandshakeRate(clientIp(req))) {
      recordWsHandshake('rate_limited')
      rejectUpgrade(socket, 429, 'Too Many Requests')
      return
    }

    void (async () => {
      const result = await authenticateHandshake(req)

      if (!result.ok) {
        recordWsHandshake(
          result.reason === 'forbidden' ? 'forbidden' : 'unauthorized'
        )
        rejectUpgrade(
          socket,
          result.reason === 'forbidden' ? 403 : 401,
          result.message
        )
        return
      }

      if (
        countConnectionsFor(result.auth.viewerUserId) >=
        config.websocket.maxConnectionsPerUser
      ) {
        recordWsHandshake('too_many')
        rejectUpgrade(socket, 429, 'Too many concurrent connections')
        return
      }

      wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        recordWsHandshake('accepted')
        const connection = new StreamConnection({
          ws,
          auth: result.auth,
          onClosed: (closed) => {
            connections.delete(closed)
            refreshConnectionGauges()
          },
        })
        connections.add(connection)
        refreshConnectionGauges()

        connection.start().catch((error) => {
          logger.error('[WS] Connection start failed', {
            error: error instanceof Error ? error.message : String(error),
          })
          connection.close(WS_CLOSE.NORMAL, 'Initialisation failed')
        })
      })
    })()
  }

  server.on('upgrade', upgradeHandler)
  logger.info(`[WS] WebSocket endpoint mounted at ${config.websocket.path}`)

  return wss
}

/**
 * Close every socket with a draining frame, then shut the server down.
 *
 * Awaited by the graceful-shutdown sequence BEFORE `httpServer.close()`: an
 * open WebSocket is a live HTTP connection, so closing the HTTP server first
 * would simply block on these sockets until the drain timeout fired and then
 * cut them without warning.
 */
export async function closeWebSocketServer(
  timeoutMs = config.websocket.drainRetryAfterMs * 5
): Promise<void> {
  if (!wss) return

  if (boundServer && upgradeHandler) {
    // Stop claiming new upgrades immediately — draining sockets while still
    // accepting fresh ones never terminates.
    boundServer.off('upgrade', upgradeHandler)
  }

  const draining = Array.from(connections)
  logger.info(`[WS] Draining ${draining.length} connection(s)`)
  for (const connection of draining) connection.drain()

  const server = wss
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      logger.warn('[WS] Drain timeout — terminating remaining sockets')
      for (const client of server.clients) client.terminate()
      resolve()
    }, timeoutMs)

    server.close(() => {
      clearTimeout(timer)
      resolve()
    })
  })

  connections.clear()
  handshakeWindows.clear()
  refreshConnectionGauges()
  wss = null
  boundServer = null
  upgradeHandler = null
  logger.info('[WS] WebSocket server closed')
}

/**
 * Force-close every socket bound to a user's stream.
 *
 * The per-connection session recheck already catches revocation within
 * WS_SESSION_RECHECK_MS; this is the immediate path for code that knows a
 * session died right now (logout, account deactivation) and does not want to
 * wait out that interval. Local to this pod — the recheck remains the backstop
 * for sockets held elsewhere.
 */
export function closeUserSockets(streamUserId: string, reason: string): number {
  const subscribers = getLocalSubscribers(streamUserId)
  let closed = 0

  for (const connection of connections) {
    if (connection.streamUserId !== streamUserId) continue
    connection.close(WS_CLOSE.AUTH_REVOKED, reason)
    closed++
  }

  if (closed > 0) {
    logger.info('[WS] Force-closed sockets for user', {
      streamUserId,
      closed,
      knownSubscribers: subscribers.length,
      reason,
    })
  }

  return closed
}

/** Live connection count — used by tests and the readiness surface. */
export function getConnectionCount(): number {
  return connections.size
}
