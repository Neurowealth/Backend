import fs from 'node:fs'
import path from 'node:path'
import { openApiSpec } from '../src/openapi/spec'

type RouteMount = {
  file: string
  prefix: string
}

const routeMounts: RouteMount[] = [
  { file: 'agent.ts', prefix: '/api/agent' },
  { file: 'analytics.ts', prefix: '/api/analytics' },
  { file: 'admin.ts', prefix: '/api/admin' },
  { file: 'auth.ts', prefix: '/api/auth' },
  { file: 'deposit.ts', prefix: '/api/deposit' },
  { file: 'portfolio.ts', prefix: '/api/portfolio' },
  { file: 'protocols.ts', prefix: '/api/protocols' },
  { file: 'stellar.ts', prefix: '/api/stellar' },
  { file: 'transactions.ts', prefix: '/api/transactions' },
  { file: 'vault.ts', prefix: '/api/vault' },
  { file: 'whatsapp.ts', prefix: '/api/whatsapp' },
  { file: 'withdraw.ts', prefix: '/api/withdraw' },
]

function collectDiscoveredOperations(): Set<string> {
  const operations = new Set<string>()
  const routesDir = path.join(process.cwd(), 'src', 'routes')

  for (const mount of routeMounts) {
    const filePath = path.join(routesDir, mount.file)
    const source = fs.readFileSync(filePath, 'utf8')
    const regex = /router\.(get|post|put|delete|patch)\s*\(\s*(['"])(.*?)\2/gs

    for (const match of source.matchAll(regex)) {
      const method = match[1].toLowerCase()
      const routePath = match[3]
      const normalizedPath = `${mount.prefix}${routePath}`
        .replace(/\/+/g, '/')
        .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
        .replace(/\/$/, '') || '/'
      operations.add(`${method} ${normalizedPath}`)
    }
  }

  return operations
}

function collectSpecOperations(): Set<string> {
  const operations = new Set<string>()

  for (const [routePath, pathItem] of Object.entries(openApiSpec.paths)) {
    for (const method of Object.keys(pathItem)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        operations.add(`${method} ${routePath}`)
      }
    }
  }

  return operations
}

const discovered = collectDiscoveredOperations()
const documented = collectSpecOperations()

const missing = [...discovered].filter((operation) => !documented.has(operation)).sort()
const extra = [...documented].filter((operation) => !discovered.has(operation)).sort()

if (missing.length || extra.length) {
  console.error('OpenAPI spec is out of sync with the route table.')

  if (missing.length) {
    console.error('\nMissing from spec:')
    for (const operation of missing) {
      console.error(`  - ${operation}`)
    }
  }

  if (extra.length) {
    console.error('\nExtra in spec:')
    for (const operation of extra) {
      console.error(`  - ${operation}`)
    }
  }

  process.exit(1)
}

console.log('OpenAPI spec is in sync with the route table.')
