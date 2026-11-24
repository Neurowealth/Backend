/**
 * `npm run build` compiles with tsconfig.build.json and prebuild copies
 * docs/openapi.yaml into dist/docs. The image build fails when either file
 * is missing from the Docker context (#846).
 */
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../../..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
}

/**
 * Docker ignore rules: a later `!` exception re-includes a file only when a
 * parent directory was not itself excluded. `docs/*` excludes children and
 * leaves `docs/` in the context, so `!docs/openapi.yaml` is effective.
 */
function dockerignored(ignoreFile: string, filePath: string): boolean {
  const lines = ignoreFile
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))

  let ignored = false
  for (const line of lines) {
    const negate = line.startsWith('!')
    const pattern = negate ? line.slice(1) : line
    if (dockerPatternMatches(pattern, filePath)) ignored = !negate
  }
  return ignored
}

function dockerPatternMatches(pattern: string, filePath: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE::/g, '.*')
  const regex = new RegExp(`^(?:.*/)?${escaped}$`)
  return regex.test(filePath)
}

describe('Docker build context (#846)', () => {
  const dockerfile = read('Dockerfile')
  const ignore = read('.dockerignore')

  it('copies the tsconfig the production build compiles with', () => {
    expect(dockerfile).toMatch(/COPY tsconfig\.json tsconfig\.build\.json \.\//)
    expect(read('package.json')).toContain(
      '"build": "tsc -p tsconfig.build.json"'
    )
  })

  it('keeps docs/openapi.yaml available for prebuild', () => {
    expect(dockerfile).toMatch(
      /COPY docs\/openapi\.yaml \.\/docs\/openapi\.yaml/
    )
    expect(dockerignored(ignore, 'docs/openapi.yaml')).toBe(false)
    expect(fs.existsSync(path.join(ROOT, 'docs/openapi.yaml'))).toBe(true)
  })
})
