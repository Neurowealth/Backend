/**
 * Guards the api-contract workflow's protected-route probe (#798).
 *
 * The previous step probed bare paths with no handlers and accepted 404 as a
 * pass, so it could not detect a missing requireAuth. This test reads the
 * workflow source directly so the escape hatch cannot silently return.
 */
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

const workflowPath = path.resolve(
  __dirname,
  '../../../.github/workflows/api-contract.yml'
)
const source = fs.readFileSync(workflowPath, 'utf8')
const workflow = yaml.load(source) as {
  jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>
}

function protectedRouteStep(): string {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.name === '401 on protected routes without token') {
        return step.run ?? ''
      }
    }
  }
  throw new Error('protected-route step not found in api-contract.yml')
}

describe('api-contract protected-route probe (#798)', () => {
  const step = protectedRouteStep()

  it('probes real v1 protected routes', () => {
    expect(step).toContain('/api/v1/vault/balance')
    expect(step).toContain('/api/v1/transactions/detail/x')
  })

  it('does not probe handler-less legacy aliases', () => {
    expect(step).not.toContain('/api/portfolio')
    expect(step).not.toContain('/api/transactions ')
    expect(step).not.toContain('/api/vault ')
  })

  it('requires exactly 401 with no 404 escape hatch', () => {
    expect(step).toContain('!= "401"')
    expect(step).not.toContain('= "404"')
  })

  it('does not use curl -f, which hides the status on 401', () => {
    expect(step).toContain('curl -s ')
    expect(step).not.toContain('curl -sf')
  })

  it('uses the standardised application port', () => {
    expect(source).not.toContain('localhost:3000')
    expect(source).toContain('localhost:3001')
  })
})
