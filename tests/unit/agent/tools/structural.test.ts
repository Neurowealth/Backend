/**
 * Structural guarantee for the assistant tool registry (#318).
 *
 * THIS IS THE ACCEPTANCE CRITERION, not a style check: "Tool registry is the
 * only model-visible surface; no path to raw stellar/db primitives." A tool
 * that imported src/stellar/contract.ts (the raw on-chain write functions) or
 * src/stellar/wallet.ts (key custody) directly would let a hallucinated or
 * misparsed model call move funds or touch a private key with no verified,
 * audited path in between — the whole reason this feature exists.
 *
 * Same specifier-parsing approach as tests/unit/outbox/structural.test.ts and
 * tests/integration/agent/strategy-follow.integration.test.ts.
 */

import fs from 'fs'
import path from 'path'

const SRC_DIR = path.join(__dirname, '../../../../src')
const TOOLS_DIR = path.join(SRC_DIR, 'agent', 'tools')

const FORBIDDEN_SPECIFIER_SUFFIXES = ['stellar/contract', 'stellar/wallet']

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

/** All `from '...'` module specifiers a file imports, static ES imports only. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const importRegex = /import\s+[^'"]*?from\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = importRegex.exec(source)) !== null) {
    specifiers.push(match[1])
  }
  return specifiers
}

describe('src/agent/tools/ — no-bypass structural guarantee', () => {
  it('the tools directory exists and is non-trivial', () => {
    expect(fs.existsSync(TOOLS_DIR)).toBe(true)
    const files = walk(TOOLS_DIR)
    expect(files.length).toBeGreaterThanOrEqual(3)
  })

  const toolFiles = walk(TOOLS_DIR)

  it.each(toolFiles)(
    '%s does not import from stellar/contract or stellar/wallet',
    (file) => {
      const source = fs.readFileSync(file, 'utf8')
      const specifiers = importSpecifiers(source)
      const forbidden = specifiers.filter((s) =>
        FORBIDDEN_SPECIFIER_SUFFIXES.some((suffix) => s.includes(suffix))
      )
      expect(forbidden).toEqual([])
    }
  )

  it('every tool wraps an existing service-layer function, not a raw db.$transaction write', () => {
    // actionTools.ts is the only file in this directory allowed to move money
    // or change durable state, and it must do so exclusively by calling into
    // controllers/, agent/router.ts, or strategy/service.ts — never by
    // opening its own db.$transaction. Read tools (readTools.ts) touch the
    // db directly, but only ever via findMany/findUnique/findFirst (reads).
    const actionToolsSource = fs.readFileSync(
      path.join(TOOLS_DIR, 'actionTools.ts'),
      'utf8'
    )
    expect(actionToolsSource).not.toMatch(/db\.\$transaction/)

    const readToolsSource = fs.readFileSync(
      path.join(TOOLS_DIR, 'readTools.ts'),
      'utf8'
    )
    const dbCalls = readToolsSource.match(/db\.\w+\.(\w+)\(/g) ?? []
    for (const call of dbCalls) {
      expect(call).toMatch(/\.(findMany|findUnique|findFirst)\(/)
    }
  })

  it('every registered tool declares a subAccountPermission (delegated-access gate)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ALL_TOOLS } = require('../../../../src/agent/tools/registry')
    expect(ALL_TOOLS.length).toBeGreaterThan(0)
    for (const tool of ALL_TOOLS) {
      expect(typeof tool.subAccountPermission).toBe('string')
      expect(tool.subAccountPermission.length).toBeGreaterThan(0)
    }
  })

  it('every non-read-only tool is marked requiresConfirmation', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ALL_TOOLS } = require('../../../../src/agent/tools/registry')
    for (const tool of ALL_TOOLS) {
      if (!tool.isReadOnly) {
        expect(tool.requiresConfirmation).toBe(true)
      }
    }
  })
})
