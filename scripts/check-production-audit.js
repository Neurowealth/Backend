#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const exceptionsPath = path.join(root, 'config', 'dependency-audit-exceptions.json')
const severityRank = { low: 1, moderate: 2, high: 3, critical: 4 }

function loadExceptions(now = new Date()) {
  const parsed = JSON.parse(fs.readFileSync(exceptionsPath, 'utf8'))
  if (!Array.isArray(parsed.exceptions)) throw new Error('exceptions must be an array')
  return parsed.exceptions.map((entry) => {
    for (const field of ['advisory', 'owner', 'reason', 'expiresOn']) {
      if (!entry[field] || typeof entry[field] !== 'string') {
        throw new Error(`dependency audit exception is missing ${field}`)
      }
    }
    const expiry = new Date(`${entry.expiresOn}T23:59:59.999Z`)
    if (Number.isNaN(expiry.getTime())) throw new Error(`invalid expiresOn for ${entry.advisory}`)
    return { ...entry, expired: expiry < now }
  })
}

function advisoryIds(name, vulnerability) {
  const ids = new Set([name])
  for (const via of vulnerability.via || []) {
    if (typeof via !== 'object' || !via) continue
    if (via.source) ids.add(String(via.source))
    if (via.url) ids.add(String(via.url))
    const ghsa = String(via.url || '').match(/GHSA-[\w-]+/i)?.[0]
    if (ghsa) ids.add(ghsa.toUpperCase())
  }
  return ids
}

function findBlockingVulnerabilities(report, exceptions, minimum = 'moderate') {
  const floor = severityRank[minimum]
  return Object.entries(report.vulnerabilities || {}).flatMap(([name, vulnerability]) => {
    if ((severityRank[vulnerability.severity] || 0) < floor) return []
    const ids = advisoryIds(name, vulnerability)
    const exception = exceptions.find(
      (item) => !item.expired && [...ids].some((id) => id.includes(item.advisory))
    )
    return exception ? [] : [{ name, severity: vulnerability.severity, ids: [...ids] }]
  })
}

function main() {
  const exceptions = loadExceptions()
  const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 10 * 1024 * 1024,
  })
  if (!audit.stdout) throw new Error(audit.stderr || 'npm audit produced no JSON')
  const report = JSON.parse(audit.stdout)
  const blocking = findBlockingVulnerabilities(report, exceptions)
  const expired = exceptions.filter((entry) => entry.expired)
  if (expired.length) {
    console.error(`Expired dependency audit exceptions: ${expired.map((e) => e.advisory).join(', ')}`)
    process.exitCode = 1
  }
  if (blocking.length) {
    for (const item of blocking) console.error(`${item.severity}: ${item.name} (${item.ids.join(', ')})`)
    console.error('Production dependency audit failed: unexcepted moderate+ advisories found.')
    process.exitCode = 1
  } else if (!expired.length) {
    console.log('Production dependency audit passed: no unexcepted moderate+ advisories.')
  }
}

if (require.main === module) main()

module.exports = { advisoryIds, findBlockingVulnerabilities, loadExceptions }
