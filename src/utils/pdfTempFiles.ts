/**
 * Temp-file hygiene for PDF generation (#670).
 *
 * The current download path renders straight to a Buffer, but PDF pipelines
 * often need a filename for large reports. This helper keeps that future path
 * safe: 0700 directory, 0600 file, unconditional unlink in `finally`, plus an
 * age-based sweep for files left behind by a hard process kill.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { logger } from './logger'

const DEFAULT_TTL_MS = 60 * 60 * 1000

export function pdfTempDir(): string {
  return process.env.PDF_TEMP_DIR || path.join(os.tmpdir(), 'neurowealth-pdf')
}

function safeBasename(name: string): string {
  const basename = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')
  return basename.length > 0 ? basename : 'document.pdf'
}

export async function sweepPdfTempFiles(
  maxAgeMs: number = DEFAULT_TTL_MS
): Promise<number> {
  const dir = pdfTempDir()
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }

  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  for (const entry of entries) {
    const file = path.join(dir, entry)
    try {
      const stat = await fs.stat(file)
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        await fs.unlink(file)
        removed++
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('[PdfTempFiles] Failed to sweep temp file', { file, error })
      }
    }
  }
  return removed
}

/**
 * Write `buffer` to a private temp file, hand the path to `fn`, and remove the
 * file whether `fn` succeeds, throws, or rejects. A best-effort TTL sweep runs
 * first so the directory is bounded even after an unclean shutdown.
 */
export async function withPdfTempFile<T>(
  buffer: Buffer,
  filename: string,
  fn: (filePath: string) => Promise<T> | T
): Promise<T> {
  const dir = pdfTempDir()
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await sweepPdfTempFiles().catch(() => undefined)

  const filePath = path.join(
    dir,
    `${process.pid}-${crypto.randomUUID()}-${safeBasename(filename)}`
  )

  await fs.writeFile(filePath, buffer, { mode: 0o600 })
  try {
    return await fn(filePath)
  } finally {
    await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        logger.warn('[PdfTempFiles] Failed to remove temp file', {
          filePath,
          error,
        })
      }
    })
  }
}
