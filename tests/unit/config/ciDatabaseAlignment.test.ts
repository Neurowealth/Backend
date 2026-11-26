/**
 * Jest loads .env.test with override:true (tests/setup-env.ts), so every DB
 * suite — including admin-audit immutability — connects to that URL, not the
 * DATABASE_URL exported by the workflow. The Node CI job migrates only the
 * database in its own env block. Those two URLs must be the same (#852).
 */
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../../..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
}

describe('CI and Jest database alignment (#852)', () => {
  it('points .env.test at the database the Node CI job migrates', () => {
    const envUrl = read('.env.test').match(/^DATABASE_URL=(\S+)\s*$/m)?.[1]
    const workflow = read('.github/workflows/node-ci.yml')
    const ciJob = workflow.slice(
      workflow.indexOf('\n  ci:'),
      workflow.indexOf('\n  docker-image-verify:')
    )
    const ciUrl = ciJob.match(/^\s*DATABASE_URL:\s*(\S+)\s*$/m)?.[1]

    expect(envUrl).toBe('postgresql://user:pass@localhost:5432/db')
    expect(ciUrl).toBe(envUrl)
  })
})
