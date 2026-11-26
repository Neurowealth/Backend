import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  PDF_LIMITS,
  PdfConcurrencyError,
  PdfLimitError,
  generateSimplePdf,
  pdfGenerationsInFlight,
  toSimplePdf,
  withPdfSlot,
} from '../../../src/utils/pdf'
import {
  sweepPdfTempFiles,
  withPdfTempFile,
} from '../../../src/utils/pdfTempFiles'

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

describe('PDF generation guards (#670)', () => {
  it('renders a valid PDF within the caps', () => {
    const pdf = toSimplePdf('Report', ['hello', 'world'])
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.toString()).toContain('%%EOF')
  })

  it('rejects too many lines with a 422 error', () => {
    const lines = Array.from({ length: PDF_LIMITS.maxLines + 1 }, () => 'x')
    expect(() => toSimplePdf('Report', lines)).toThrow(PdfLimitError)
    try {
      toSimplePdf('Report', lines)
    } catch (error) {
      expect((error as PdfLimitError).statusCode).toBe(422)
    }
  })

  it('rejects an over-long line with a 422 error', () => {
    expect(() =>
      toSimplePdf('Report', ['x'.repeat(PDF_LIMITS.maxLineLength + 1)])
    ).toThrow(/exceeds the maximum length/)
  })

  it('rejects oversized input bytes with a 422 error', () => {
    const line = 'x'.repeat(PDF_LIMITS.maxLineLength)
    const lines = Array.from(
      { length: Math.ceil(PDF_LIMITS.maxInputBytes / line.length) + 1 },
      () => line
    )
    expect(() => toSimplePdf('Report', lines)).toThrow(PdfLimitError)
  })

  it('rejects a concurrent generation with a 429 error and Retry-After hint', async () => {
    let release!: () => void
    const held = withPdfSlot(
      () => new Promise<number>((resolve) => (release = () => resolve(1))),
      1
    )
    expect(pdfGenerationsInFlight()).toBe(1)

    await expect(withPdfSlot(() => 2, 1)).rejects.toBeInstanceOf(
      PdfConcurrencyError
    )
    try {
      await withPdfSlot(() => 2, 1)
    } catch (error) {
      expect((error as PdfConcurrencyError).statusCode).toBe(429)
      expect((error as PdfConcurrencyError).retryAfter).toBeGreaterThan(0)
    }

    release()
    await expect(held).resolves.toBe(1)
    expect(pdfGenerationsInFlight()).toBe(0)
  })

  it('generateSimplePdf uses the same semaphore', async () => {
    let release!: () => void
    const held = withPdfSlot(
      () => new Promise<void>((resolve) => (release = resolve)),
      1
    )
    await expect(generateSimplePdf('Report', ['x'], 1)).rejects.toBeInstanceOf(
      PdfConcurrencyError
    )
    release()
    await held
  })
})

describe('PDF temp-file hygiene (#670)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-test-'))
    process.env.PDF_TEMP_DIR = dir
  })

  afterEach(async () => {
    delete process.env.PDF_TEMP_DIR
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('removes the temp file after a successful render/callback', async () => {
    let seen = ''
    await withPdfTempFile(Buffer.from('pdf'), 'report.pdf', async (file) => {
      seen = file
      await expect(fs.stat(file)).resolves.toBeDefined()
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    })
    await expect(fs.stat(seen)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('removes the temp file when the callback throws', async () => {
    let seen = ''
    await expect(
      withPdfTempFile(Buffer.from('pdf'), 'report.pdf', async (file) => {
        seen = file
        throw new Error('render failed')
      })
    ).rejects.toThrow('render failed')
    await expect(fs.stat(seen)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('sweeps stale files but leaves fresh ones', async () => {
    const stale = path.join(dir, 'stale.pdf')
    const fresh = path.join(dir, 'fresh.pdf')
    await fs.writeFile(stale, 'old')
    await fs.writeFile(fresh, 'new')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await fs.utimes(stale, old, old)

    const removed = await sweepPdfTempFiles(60 * 60 * 1000)

    expect(removed).toBe(1)
    await expect(fs.stat(stale)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(fresh)).resolves.toBeDefined()
  })
})
