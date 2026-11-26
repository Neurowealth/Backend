/**
 * Minimal PDF writer for plain-text reports. Hand-rolled on purpose, matching
 * csv.ts's precedent — no new dependency for a single export feature (#538).
 *
 * Builds a valid single/multi-page PDF (Letter size, base-14 Helvetica, no
 * font embedding needed) directly from an array of text lines.
 */

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const MARGIN = 48
const FONT_SIZE = 10
const LINE_HEIGHT = 14
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - MARGIN * 2) / LINE_HEIGHT)

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Hard limits for PDF generation (#670). PDF rendering is synchronous and
 * memory-heavy on the same pods that serve traffic, so an unbounded report can
 * starve every other request. Limits are configurable for load testing but
 * always finite.
 */
export const PDF_LIMITS = {
  maxLines: envInt('PDF_MAX_LINES', 10_000),
  maxLineLength: envInt('PDF_MAX_LINE_LENGTH', 4_000),
  maxInputBytes: envInt('PDF_MAX_INPUT_BYTES', 4 * 1024 * 1024),
  maxConcurrent: envInt('PDF_MAX_CONCURRENT', 2),
  retryAfterSeconds: envInt('PDF_RETRY_AFTER_SECONDS', 5),
} as const

/** Input exceeded a size/line cap — the caller should return 422. */
export class PdfLimitError extends Error {
  readonly statusCode = 422
  readonly code = 'PDF_INPUT_TOO_LARGE'
  readonly details: Record<string, number>

  constructor(message: string, details: Record<string, number>) {
    super(message)
    this.name = 'PdfLimitError'
    this.details = details
  }
}

/** Too many generations in flight — the caller should return 429. */
export class PdfConcurrencyError extends Error {
  readonly statusCode = 429
  readonly code = 'PDF_GENERATION_BUSY'
  readonly retryAfter = PDF_LIMITS.retryAfterSeconds

  constructor() {
    super('PDF generation is temporarily busy; retry shortly')
    this.name = 'PdfConcurrencyError'
  }
}

let activeGenerations = 0

/** Number of PDF generations currently holding a concurrency slot. */
export function pdfGenerationsInFlight(): number {
  return activeGenerations
}

/**
 * Run a generation under the process-wide semaphore. We reject immediately
 * rather than queueing: a queue would only move the same memory pressure a few
 * milliseconds later and hide it from the caller.
 */
export async function withPdfSlot<T>(
  task: () => Promise<T> | T,
  limit: number = PDF_LIMITS.maxConcurrent
): Promise<T> {
  if (activeGenerations >= limit) throw new PdfConcurrencyError()
  activeGenerations++
  try {
    return await task()
  } finally {
    activeGenerations--
  }
}

function validatePdfInput(title: string, lines: string[]): void {
  if (typeof title !== 'string') {
    throw new PdfLimitError('PDF title must be a string', {
      maxInputBytes: PDF_LIMITS.maxInputBytes,
    })
  }
  if (!Array.isArray(lines)) {
    throw new PdfLimitError('PDF lines must be an array', {
      maxLines: PDF_LIMITS.maxLines,
    })
  }
  if (lines.length > PDF_LIMITS.maxLines) {
    throw new PdfLimitError(
      `PDF input has too many lines (${lines.length}); maximum is ${PDF_LIMITS.maxLines}`,
      { maxLines: PDF_LIMITS.maxLines, actualLines: lines.length }
    )
  }

  let bytes = Buffer.byteLength(title, 'utf-8')
  for (const line of lines) {
    if (typeof line !== 'string') {
      throw new PdfLimitError('Every PDF line must be a string', {
        maxLineLength: PDF_LIMITS.maxLineLength,
      })
    }
    if (line.length > PDF_LIMITS.maxLineLength) {
      throw new PdfLimitError(
        `PDF line exceeds the maximum length of ${PDF_LIMITS.maxLineLength}`,
        { maxLineLength: PDF_LIMITS.maxLineLength, actualLength: line.length }
      )
    }
    bytes += Buffer.byteLength(line, 'utf-8') + 1
  }

  if (bytes > PDF_LIMITS.maxInputBytes) {
    throw new PdfLimitError(
      `PDF input exceeds the maximum size of ${PDF_LIMITS.maxInputBytes} bytes`,
      { maxInputBytes: PDF_LIMITS.maxInputBytes, actualBytes: bytes }
    )
  }
}

/** Escape characters PDF's literal-string syntax treats specially. */
function escapePdfText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size))
  return out
}

/**
 * Render a title and body lines as a paginated PDF document.
 * @returns a Buffer ready to be sent as `application/pdf`.
 */
export function toSimplePdf(title: string, lines: string[]): Buffer {
  validatePdfInput(title, lines)

  const pages = chunk(lines, LINES_PER_PAGE - 2) // reserve 2 lines for the title/spacer on page 1
  if (pages.length === 0) pages.push([])

  const objects: string[] = []
  const pageObjNums: number[] = []
  const contentObjNums: number[] = []

  // Object 1: Catalog, Object 2: Pages (filled in after we know page object numbers).
  // Object 3: Font. Page + content objects follow.
  const FONT_OBJ = 3
  let nextObj = 4

  const pageIds: number[] = pages.map(() => nextObj++)
  const contentIds: number[] = pages.map(() => nextObj++)
  pageObjNums.push(...pageIds)
  contentObjNums.push(...contentIds)

  pages.forEach((pageLines, i) => {
    const streamLines: string[] = []
    let y = PAGE_HEIGHT - MARGIN
    streamLines.push(`BT /F1 ${FONT_SIZE} Tf ${MARGIN} ${y} Td`)
    if (i === 0) {
      streamLines.push(
        `(${escapePdfText(title)}) Tj 0 -${LINE_HEIGHT * 1.5} Td`
      )
    }
    for (const line of pageLines) {
      streamLines.push(`(${escapePdfText(line)}) Tj 0 -${LINE_HEIGHT} Td`)
    }
    streamLines.push('ET')
    const stream = streamLines.join('\n')

    objects[contentIds[i]! - 1] =
      `<< /Length ${Buffer.byteLength(stream, 'utf-8')} >>\nstream\n${stream}\nendstream`
    objects[pageIds[i]! - 1] =
      `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${FONT_OBJ} 0 R >> >> /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents ${contentIds[i]} 0 R >>`
  })

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
  objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'utf-8'))
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }

  const xrefStart = Buffer.byteLength(pdf, 'utf-8')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`

  return Buffer.from(pdf, 'utf-8')
}

/**
 * Async entry point used by download routes: enforces input caps and the
 * concurrency semaphore, then renders to an in-memory Buffer. No temp file is
 * written on this path, so there is nothing to leak on success or failure.
 */
export async function generateSimplePdf(
  title: string,
  lines: string[],
  limit: number = PDF_LIMITS.maxConcurrent
): Promise<Buffer> {
  return withPdfSlot(() => toSimplePdf(title, lines), limit)
}
