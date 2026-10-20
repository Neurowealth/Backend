const assert = require('node:assert/strict')
const test = require('node:test')
const { findBlockingVulnerabilities } = require('../check-production-audit')

const report = {
  vulnerabilities: {
    runtimePackage: {
      severity: 'moderate',
      via: [{ source: 1234, url: 'https://github.com/advisories/GHSA-test-1234' }],
    },
  },
}

test('blocks an unexcepted moderate production advisory', () => {
  assert.equal(findBlockingVulnerabilities(report, []).length, 1)
})

test('accepts a current matching machine-readable exception', () => {
  const exceptions = [{ advisory: 'GHSA-test-1234', expired: false }]
  assert.deepEqual(findBlockingVulnerabilities(report, exceptions), [])
})

test('does not accept an expired exception', () => {
  const exceptions = [{ advisory: 'GHSA-test-1234', expired: true }]
  assert.equal(findBlockingVulnerabilities(report, exceptions).length, 1)
})
