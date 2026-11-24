import fs from 'fs'
import path from 'path'

function collectFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectFiles(full))
    } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

describe('timing-safe token/secret comparisons', () => {
  it('does not use ===/!== with process.env token/secret values in src', () => {
    const srcDir = path.resolve(__dirname, '../../../src')
    const files = collectFiles(srcDir)
    const offenders: string[] = []
    const pattern =
      /(?:===|!==)\s*process\.env\.[A-Za-z0-9_]*(?:TOKEN|SECRET)\b|\bprocess\.env\.[A-Za-z0-9_]*(?:TOKEN|SECRET)\b\s*(?:===|!==)/

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8')
      const lines = content.split(/\r?\n/)
      lines.forEach((line, idx) => {
        if (pattern.test(line)) {
          offenders.push(
            `${path.relative(srcDir, file)}:${idx + 1}: ${line.trim()}`
          )
        }
      })
    }

    expect(offenders).toEqual([])
  })
})
