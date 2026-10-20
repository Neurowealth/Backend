/**
 * Regenerate the generated scope tables in docs/API_KEYS.md (#615).
 *
 * The prose in that document is hand-written; the two scope tables are
 * generated from the catalogues in src/auth/scopes.ts and
 * src/middleware/adminAuth.ts. This script rewrites the blocks between the
 * GENERATED markers:
 *
 *     npm run docs:scopes
 *
 * tests/unit/auth/scopeCatalog.test.ts asserts the committed doc still
 * matches what this script would write, so a stale doc fails CI.
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

const DOC_PATH = path.join(__dirname, '..', 'docs', 'API_KEYS.md')

async function main(): Promise<void> {
  const { getAdminScopeCatalog, getUserScopeCatalog } = await import(
    '../src/auth/scopeCoverage'
  )
  const { renderScopeCatalogMarkdown } = await import(
    '../src/auth/scopeCatalog'
  )

  const blocks = [
    {
      marker: 'user-scope-catalog',
      table: renderScopeCatalogMarkdown(getUserScopeCatalog()),
    },
    {
      marker: 'admin-scope-catalog',
      table: renderScopeCatalogMarkdown(getAdminScopeCatalog()),
    },
  ]

  let doc = fs.readFileSync(DOC_PATH, 'utf8')

  for (const block of blocks) {
    const begin = `<!-- BEGIN GENERATED: ${block.marker} -->`
    const end = `<!-- END GENERATED: ${block.marker} -->`
    const start = doc.indexOf(begin)
    const stop = doc.indexOf(end)

    if (start === -1 || stop === -1) {
      throw new Error(
        `docs/API_KEYS.md is missing the "${block.marker}" generated block`
      )
    }

    doc =
      doc.slice(0, start + begin.length) +
      '\n' +
      block.table +
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
