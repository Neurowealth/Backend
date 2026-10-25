#!/usr/bin/env node
/**
 * OpenAPI drift check (#601).
 *
 * Builds a route inventory from the Express routers mounted under /api/v1 in
 * src/index.ts and diffs it against the paths in docs/openapi.yaml.
 *
 *   - "unbacked"  : mounted route with no spec entry
 *   - "stale"     : spec entry with no mounted route
 *
 * Known drift is recorded in docs/openapi-drift-baseline.json. The check fails
 * on any drift NOT in the baseline, and on baseline entries that no longer
 * drift (so the baseline only ever shrinks).
 *
 * Usage:
 *   node scripts/check-openapi-drift.js            # check (CI)
 *   node scripts/check-openapi-drift.js --update   # rewrite the baseline
 *   node scripts/check-openapi-drift.js --report   # print full drift lists
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src')
const SPEC = path.join(ROOT, 'docs', 'openapi.yaml')
const BASELINE = path.join(ROOT, 'docs', 'openapi-drift-baseline.json')
const METHODS = ['get', 'post', 'put', 'patch', 'delete']

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function resolveModule(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const candidate of [base + '.ts', path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function importMap(file, source) {
  const map = {}
  const re = /import\s+(\w+)\s+from\s+['"](\.[^'"]+)['"]/g
  let m
  while ((m = re.exec(source))) {
    const resolved = resolveModule(file, m[2])
    if (resolved) map[m[1]] = resolved
  }
  return map
}

function join(prefix, p) {
  const joined = `${prefix}/${p}`.replace(/\/+/g, '/')
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined
}

function normalize(p) {
  return p.replace(/:(\w+)/g, '{$1}')
}

function routesOf(file, prefix, seen = new Set()) {
  if (seen.has(file)) return []
  seen.add(file)
  const source = read(file)
  const imports = importMap(file, source)
  const out = []

  const verb = new RegExp(
    `\\b\\w+\\.(${METHODS.join('|')})\\(\\s*['"\`]([^'"\`]+)['"\`]`,
    'g'
  )
  let m
  while ((m = verb.exec(source))) {
    out.push({ method: m[1], route: join(prefix, m[2]) })
  }

  const nested = /\b\w+\.use\(\s*['"`]([^'"`]+)['"`][^)]*?(\w+)\s*\)/g
  while ((m = nested.exec(source))) {
    if (imports[m[2]]) {
      out.push(...routesOf(imports[m[2]], join(prefix, m[1]), seen))
    }
  }
  return out
}

function mountedRoutes() {
  const registryFile = path.join(SRC, 'routes', 'registry.ts')
  const targetFile = fs.existsSync(registryFile)
    ? registryFile
    : path.join(SRC, 'index.ts')
  const source = read(targetFile)
  const imports = importMap(targetFile, source)
  const all = new Set()
  const block =
    source.match(/export const API_ROUTES[\s\S]*?\n\]/)?.[0] || source
  const re = /path:\s*'([^']+)',\s*handlers:\s*\[([^\]]*)\]/g
  let m
  while ((m = re.exec(block))) {
    const ids = m[2].match(/\w+/g) || []
    const router = ids[ids.length - 1]
    if (!imports[router]) continue
    for (const r of routesOf(imports[router], `/api/v1/${m[1]}`)) {
      all.add(`${r.method.toUpperCase()} ${normalize(r.route)}`)
    }
  }
  return all
}

function specRoutes() {
  const all = new Set()
  let inPaths = false
  let current = null
  for (const line of read(SPEC).split(/\r?\n/)) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true
      continue
    }
    if (inPaths && /^\S/.test(line)) break
    if (!inPaths) continue
    const p = line.match(/^ {2}(\/\S*?):\s*$/)
    if (p) {
      current = p[1]
      continue
    }
    const v = line.match(/^ {4}(get|post|put|patch|delete):\s*$/)
    if (v && current) {
      all.add(`${v[1].toUpperCase()} ${join('/api/v1', current)}`)
    }
  }
  return all
}

function diff(a, b) {
  return [...a].filter((x) => !b.has(x)).sort()
}

function list(title, items) {
  if (!items.length) return
  console.error(`\n${title} (${items.length}):`)
  for (const i of items) console.error(`  ${i}`)
}

const mounted = mountedRoutes()
const spec = specRoutes()
const unbacked = diff(mounted, spec)
const stale = diff(spec, mounted)

if (process.argv.includes('--update')) {
  fs.writeFileSync(
    BASELINE,
    JSON.stringify({ unbacked, stale }, null, 2) + '\n'
  )
  console.log(
    `Baseline written: ${unbacked.length} unbacked, ${stale.length} stale`
  )
  process.exit(0)
}

if (process.argv.includes('--report')) {
  list('Mounted routes with no OpenAPI entry', unbacked)
  list('OpenAPI entries with no mounted route', stale)
  process.exit(0)
}

const baseline = fs.existsSync(BASELINE)
  ? JSON.parse(read(BASELINE))
  : { unbacked: [], stale: [] }

const newUnbacked = diff(new Set(unbacked), new Set(baseline.unbacked))
const newStale = diff(new Set(stale), new Set(baseline.stale))
const fixedUnbacked = diff(new Set(baseline.unbacked), new Set(unbacked))
const fixedStale = diff(new Set(baseline.stale), new Set(stale))

list('Mounted routes missing from docs/openapi.yaml', newUnbacked)
list('docs/openapi.yaml entries with no mounted route', newStale)
list(
  'Baseline entries now resolved - run `node scripts/check-openapi-drift.js --update`',
  [...fixedUnbacked, ...fixedStale]
)

const failed =
  newUnbacked.length +
  newStale.length +
  fixedUnbacked.length +
  fixedStale.length
if (failed) {
  console.error(
    '\nOpenAPI drift detected. Document the route in docs/openapi.yaml (preferred).'
  )
  process.exit(1)
}

console.log(
  `OpenAPI drift check passed (${mounted.size} routes, ${spec.size} spec operations, ` +
    `${baseline.unbacked.length + baseline.stale.length} baselined)`
)
