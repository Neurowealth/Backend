/**
 * PDF memory profile (#670).
 *
 * Generates reports at several sizes and prints the process RSS / heap growth
 * so the documented ceiling in docs/PDF_EXPORTS.md can be re-verified after a
 * rendering change. Run: npm run profile:pdf
 */
import { PDF_LIMITS, toSimplePdf } from '../src/utils/pdf'

const SIZES = [100, 1_000, 5_000, PDF_LIMITS.maxLines]

function snapshot() {
  const mem = process.memoryUsage()
  return { rssMb: mem.rss / 1024 / 1024, heapMb: mem.heapUsed / 1024 / 1024 }
}

const baseline = snapshot()
const rows: Array<Record<string, string | number>> = []

for (const size of SIZES) {
  const lines = Array.from(
    { length: size },
    (_, i) =>
      `2026-01-${String((i % 28) + 1).padStart(2, '0')}  position-${i}  yield=${(
        i / 100
      ).toFixed(2)}  apy=7.25`
  )
  const before = snapshot()
  const buffer = toSimplePdf(`PDF memory profile — ${size} lines`, lines)
  const after = snapshot()
  rows.push({
    inputLines: size,
    pdfBytes: buffer.length,
    rssDeltaMb: (after.rssMb - before.rssMb).toFixed(1),
    heapDeltaMb: (after.heapMb - before.heapMb).toFixed(1),
  })
}

const peak = snapshot()
console.log(
  JSON.stringify(
    {
      limits: PDF_LIMITS,
      baseline,
      peak,
      totalRssDeltaMb: (peak.rssMb - baseline.rssMb).toFixed(1),
      rows,
    },
    null,
    2
  )
)
