import { Request, Response } from 'express'
import db from '../db'
import { logger } from '../utils/logger'
import { authenticateStreamRequest } from '../middleware/streamAuth'
import { subscribeToUserStream } from '../events/hub'
import {
  USER_EVENT_TOPICS,
  type UserEventTopic,
  type UserEventEnvelope,
} from '../events/types'

export const SSE_HEARTBEAT_MS = 15000
export const SSE_MAX_BUFFER_BYTES = 64 * 1024 // 64KB backpressure threshold

export async function handleSseConnection(
  req: Request,
  res: Response
): Promise<void> {
  let closed = false
  let heartbeatInterval: NodeJS.Timeout | null = null
  let unsubscribe: (() => void) | null = null

  function cleanup() {
    closed = true
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval)
      heartbeatInterval = null
    }
    if (unsubscribe) {
      try {
        unsubscribe()
      } catch {
        // ignore
      }
      unsubscribe = null
    }
  }

  // Attach close listener immediately before any asynchronous operation
  req.on('close', () => {
    cleanup()
  })

  const auth = await authenticateStreamRequest(
    req.headers as any,
    req.query as any
  )

  if (closed || res.destroyed) {
    cleanup()
    return
  }

  if (
    !auth.ok ||
    !auth.viewerUserId ||
    !auth.streamUserId ||
    !auth.allowedTopics
  ) {
    res.status(401).json({ error: auth.error || 'Unauthorized' })
    return
  }

  // Parse requested topics
  const requestedTopicsStr =
    typeof req.query.topics === 'string' ? req.query.topics : ''
  const requestedTopics = requestedTopicsStr
    ? (requestedTopicsStr.split(',').map((t) => t.trim()) as UserEventTopic[])
    : auth.allowedTopics

  // Intersect with allowedTopics
  const activeTopics = requestedTopics.filter((t) =>
    auth.allowedTopics!.includes(t)
  )
  if (activeTopics.length === 0) {
    res.status(403).json({ error: 'No permitted topics selected' })
    return
  }

  // Configure SSE HTTP headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const viewerUserId = auth.viewerUserId
  const streamUserId = auth.streamUserId

  // Check Last-Event-ID or afterSeq
  const lastEventIdHeader = req.headers['last-event-id']
  const afterSeqParam = req.query.afterSeq
  let afterSeq = 0
  if (
    typeof lastEventIdHeader === 'string' &&
    !isNaN(parseInt(lastEventIdHeader, 10))
  ) {
    afterSeq = parseInt(lastEventIdHeader, 10)
  } else if (
    typeof afterSeqParam === 'string' &&
    !isNaN(parseInt(afterSeqParam, 10))
  ) {
    afterSeq = parseInt(afterSeqParam, 10)
  }

  let isReplaying = afterSeq > 0
  const liveBuffer: UserEventEnvelope[] = []
  const deliveredSeqs = new Set<string>()

  // Subscribe to live hub events FIRST to avoid missing envelopes during replay
  unsubscribe = subscribeToUserStream({
    streamUserId,
    viewerUserId,
    deliver: (envelope: UserEventEnvelope) => {
      if (closed || res.destroyed || res.writableEnded) return

      // Filter by active topics
      if (!activeTopics.includes(envelope.topic)) return

      if (isReplaying) {
        liveBuffer.push(envelope)
        return
      }

      const seqStr = String(envelope.seq)
      if (deliveredSeqs.has(seqStr)) return
      deliveredSeqs.add(seqStr)

      // Backpressure check
      if (res.writableLength > SSE_MAX_BUFFER_BYTES) {
        res.write(
          `event: overflow\ndata: ${JSON.stringify({ message: 'Connection dropped due to slow consumer buffer overflow' })}\n\n`
        )
        cleanup()
        res.end()
        return
      }

      res.write(
        `id: ${envelope.seq}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope.payload)}\n\n`
      )
    },
  })

  // Perform replay if requested
  if (afterSeq > 0) {
    try {
      const retainedEvents = await db.userEvent.findMany({
        where: {
          userId: streamUserId,
          topic: { in: activeTopics },
          seq: { gt: BigInt(afterSeq) },
        },
        orderBy: { seq: 'asc' },
        take: 500,
      })

      if (closed || res.destroyed || res.writableEnded) {
        cleanup()
        return
      }

      if (retainedEvents.length === 0 && afterSeq > 0) {
        const earliest = await db.userEvent.findFirst({
          where: { userId: streamUserId },
          orderBy: { seq: 'asc' },
        })
        if (earliest && Number(earliest.seq) > afterSeq) {
          res.write(
            `event: replay_truncated\ndata: ${JSON.stringify({ earliestAvailableSeq: Number(earliest.seq) })}\n\n`
          )
        }
      }

      for (const evt of retainedEvents) {
        if (closed || res.destroyed || res.writableEnded) {
          cleanup()
          return
        }
        const seqStr = String(evt.seq)
        deliveredSeqs.add(seqStr)
        res.write(
          `id: ${evt.seq}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt.payload)}\n\n`
        )
      }
    } catch (err: any) {
      logger.warn('[SSE] Failed to replay retained events', {
        error: err.message,
      })
    }
  }

  // End of replay: flush the buffered live envelopes deduped by seq
  isReplaying = false
  for (const envelope of liveBuffer) {
    if (closed || res.destroyed || res.writableEnded) {
      cleanup()
      return
    }

    const seqStr = String(envelope.seq)
    if (deliveredSeqs.has(seqStr)) continue
    deliveredSeqs.add(seqStr)

    if (res.writableLength > SSE_MAX_BUFFER_BYTES) {
      res.write(
        `event: overflow\ndata: ${JSON.stringify({ message: 'Connection dropped due to slow consumer buffer overflow' })}\n\n`
      )
      cleanup()
      res.end()
      return
    }

    res.write(
      `id: ${envelope.seq}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope.payload)}\n\n`
    )
  }
  liveBuffer.length = 0

  if (closed || res.destroyed || res.writableEnded) {
    cleanup()
    return
  }

  // Periodic heartbeat
  heartbeatInterval = setInterval(() => {
    if (closed || res.destroyed || res.writableEnded) {
      cleanup()
      return
    }
    res.write(': keep-alive\n\n')
  }, SSE_HEARTBEAT_MS)
}
