/**
 * Regenerate the generated tables in docs/RATE_LIMITING.md (#614).
 *
 * The prose in that document is hand-written; the two tables are generated
 * from src/middleware/rateLimitTiers.ts. This script rewrites the blocks
 * between the GENERATED markers, so a contributor who changes a tier or adds
 * a route can refresh the doc with one command:
 *
 *     npm run docs:rate-limits
 *
 * tests/unit/middleware/rateLimitTierMatrix.test.ts asserts the committed
 * doc still matches what this script would write, so a stale doc fails CI.
 */

import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

// The env must be loaded before src/config/env.ts validates it, and a static
// import of the catalogue would be hoisted above this line — hence the
// dynamic import below.
dotenv.config({
  path: path.join(__dirname, '..', '.env.test'),
  override: true,
})

const DOC_PATH = path.join(__dirname, '..', 'docs', 'RATE_LIMITING.md')

const BLOCKS = [
  { marker: 'matrix', render: 'renderRateLimitMatrixMarkdown' },
  { marker: 'tier-catalog', render: 'renderRateLimitTierCatalogMarkdown' },
] as const

async function main(): Promise<void> {
  const catalogue = await import('../src/middleware/rateLimitTiers')

  let doc = fs.readFileSync(DOC_PATH, 'utf8')

  for (const block of BLOCKS) {
    const begin = `<!-- BEGIN GENERATED: ${block.marker} -->`
    const end = `<!-- END GENERATED: ${block.marker} -->`
    const start = doc.indexOf(begin)
    const stop = doc.indexOf(end)

    if (start === -1 || stop === -1) {
      throw new Error(
        `docs/RATE_LIMITING.md is missing the "${block.marker}" generated block`
      )
    }

    const table = catalogue[block.render]()
    doc =
      doc.slice(0, start + begin.length) +
      '\n' +
      table +
      '\n' +
      doc.slice(stop)
  }

  fs.writeFileSync(DOC_PATH, doc)
  console.log(`Updated ${path.relative(process.cwd(), DOC_PATH)}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
