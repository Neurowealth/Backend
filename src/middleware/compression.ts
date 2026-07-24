import compression from 'compression'
import type { Request, Response } from 'express'

/**
 * Compression middleware configuration.
 *
 * Features:
 * - Brotli (br) preferred when the client advertises support (Accept-Encoding: br),
 *   falling back to gzip, then deflate.
 * - Threshold: only compress responses larger than 1 KB.
 * - Excludes the /metrics endpoint (Prometheus scraper handles its own format).
 *
 * The compression package (v1.7+) uses Node's native zlib.createBrotliCompress when
 * available, so no additional dependencies are required for brotli support.
 */

const EXCLUDED_PATHS = ['/metrics']

function compressionFilter(req: Request, res: Response): boolean {
  // Never compress the Prometheus metrics endpoint
  if (EXCLUDED_PATHS.includes(req.path)) {
    return false
  }

  // Fall back to the default filter (checks Content-Type is compressible)
  return compression.filter(req, res)
}

const compressionMiddleware = compression({
  // Compress responses larger than 1 KB
  threshold: 1024,

  // Custom filter to exclude /metrics
  filter: compressionFilter,
})

export default compressionMiddleware
