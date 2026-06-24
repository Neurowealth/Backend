import {
  generateDryRunReport,
  saveDryRunReport,
  initializeMetrics,
  finalizeMetrics,
  recordError,
  recordSuccess,
  RotationMetrics,
} from '../../../scripts/rotation-metrics'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

function makeMetrics(overrides: Partial<RotationMetrics> = {}): RotationMetrics {
  const base = initializeMetrics(true)
  return finalizeMetrics({ ...base, ...overrides })
}

describe('generateDryRunReport', () => {
  it('shows READY when there are no failures', () => {
    const metrics = makeMetrics({ totalWallets: 5, successfullyRotated: 5, failedRotations: 0, errors: [] })
    const report = generateDryRunReport(metrics)
    expect(report).toContain('Rotation Readiness:     READY')
    expect(report).toContain('All 5 wallets passed validation checks')
    expect(report).toContain('NEXT STEPS')
    expect(report).toContain('dry-run completed successfully')
  })

  it('shows NOT READY when failures exist', () => {
    const metrics = initializeMetrics(true)
    recordError(metrics, 'wallet-abc123', 'user-xyz789', 'Decryption failed: bad tag')
    const finalized = finalizeMetrics({ ...metrics, totalWallets: 3, successfullyRotated: 2 })
    const report = generateDryRunReport(finalized)
    expect(report).toContain('Rotation Readiness:     NOT READY')
    expect(report).toContain('WARNING: 1 wallet(s) failed validation')
    expect(report).toContain('[FAIL] Wallet wallet-a...')
    expect(report).toContain('Investigate the 1 wallet(s)')
  })

  it('truncates wallet IDs and user IDs to 8 characters', () => {
    const metrics = initializeMetrics(true)
    recordError(metrics, 'wallet-full-id-that-is-long', 'user-full-id-that-is-long', 'error')
    const finalized = finalizeMetrics({ ...metrics, totalWallets: 1 })
    const report = generateDryRunReport(finalized)
    expect(report).toContain('wallet-f...')
    expect(report).toContain('user-ful...')
    expect(report).not.toContain('wallet-full-id-that-is-long')
    expect(report).not.toContain('user-full-id-that-is-long')
  })

  it('caps displayed errors at 20 and shows overflow count', () => {
    const metrics = initializeMetrics(true)
    for (let i = 0; i < 25; i++) {
      recordError(metrics, `wallet-${i.toString().padStart(8, '0')}`, `user-${i.toString().padStart(8, '0')}`, 'err')
    }
    const finalized = finalizeMetrics({ ...metrics, totalWallets: 25 })
    const report = generateDryRunReport(finalized)
    expect(report).toContain('... and 5 more')
  })

  it('does not include any raw hex strings longer than 8 characters', () => {
    const metrics = makeMetrics({ totalWallets: 2, successfullyRotated: 2, failedRotations: 0, errors: [] })
    const report = generateDryRunReport(metrics)
    // Any 64-char hex string (key-like) must not appear
    const hexPattern = /[0-9a-fA-F]{64}/
    expect(hexPattern.test(report)).toBe(false)
  })

  it('includes all required sections', () => {
    const metrics = makeMetrics({ totalWallets: 1, successfullyRotated: 1, failedRotations: 0, errors: [] })
    const report = generateDryRunReport(metrics)
    const requiredSections = [
      'WALLET ROTATION DRY-RUN REPORT',
      'SUMMARY',
      'VALIDATION RESULTS',
      'WARNINGS',
      'NEXT STEPS',
      'PERFORMANCE ESTIMATE',
      'SAFETY NOTES',
    ]
    for (const section of requiredSections) {
      expect(report).toContain(section)
    }
  })

  it('does not expose database credentials in the report', () => {
    const metrics = makeMetrics({
      totalWallets: 1,
      successfullyRotated: 1,
      failedRotations: 0,
      errors: [],
      databaseUrl: 'postgresql://*:**@db.example.com/mydb',
    })
    const report = generateDryRunReport(metrics)
    // The redacted URL may appear but real passwords must not
    expect(report).not.toMatch(/postgresql:\/\/[^*].*:[^*].*@/)
  })

  it('shows "not available" when databaseUrl is absent', () => {
    const metrics = makeMetrics({
      totalWallets: 0,
      successfullyRotated: 0,
      failedRotations: 0,
      errors: [],
      databaseUrl: undefined,
    })
    const report = generateDryRunReport(metrics)
    expect(report).toContain('not available')
  })
})

describe('saveDryRunReport', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-run-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes a .txt file named after the rotationId', () => {
    const metrics = makeMetrics({ totalWallets: 1, successfullyRotated: 1, failedRotations: 0, errors: [] })
    const reportPath = saveDryRunReport(metrics, tmpDir)
    expect(reportPath).toMatch(/wallet-rotation-dry-run-.+\.txt$/)
    expect(fs.existsSync(reportPath)).toBe(true)
  })

  it('creates the output directory if it does not exist', () => {
    const nestedDir = path.join(tmpDir, 'nested', 'output')
    const metrics = makeMetrics({ totalWallets: 0, successfullyRotated: 0, failedRotations: 0, errors: [] })
    saveDryRunReport(metrics, nestedDir)
    expect(fs.existsSync(nestedDir)).toBe(true)
  })

  it('file content matches generateDryRunReport output', () => {
    const metrics = makeMetrics({ totalWallets: 3, successfullyRotated: 3, failedRotations: 0, errors: [] })
    const reportPath = saveDryRunReport(metrics, tmpDir)
    const content = fs.readFileSync(reportPath, 'utf8')
    expect(content).toBe(generateDryRunReport(metrics))
  })
})
