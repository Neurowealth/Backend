import compression from 'compression'
import { constants } from 'node:zlib'
import type { Request, Response } from 'express'

/**
 * Response compression middleware — gzip + brotli.
 *
 * - Threshold: 1 KB (responses smaller than this are sent uncompressed)
 * - Brotli: enabled when client sends Accept-Encoding: br
 * - /metrics excluded: Prometheus scraper handles its own format
 *
 * Must be mounted globally before route handlers in index.ts.
 */
export const compressionMiddleware = compression({
  // Only compress responses larger than 1 KB — below this the header/CPU
  // overhead outweighs any bandwidth savings.
  threshold: 1024,

  // Skip compression for /metrics — Prometheus scraper expects the raw
  // text/plain exposition format and handles its own transport encoding.
  filter: (req: Request, res: Response): boolean => {
    if (req.path === '/metrics') return false
    return compression.filter(req, res)
  },

  // Enable brotli with quality level 4 — a good balance between
  // compression ratio and CPU cost for API JSON payloads.
  brotli: {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 4,
    },
  },
})
