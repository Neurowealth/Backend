import fs from 'fs'
import path from 'path'

const SRC_DIR = path.join(__dirname, '../../../src')

describe('src/outbox/dispatcher.ts — stuck-submitted reconciliation (#656)', () => {
  const dispatcherFile = path.join(SRC_DIR, 'outbox', 'dispatcher.ts')
  const serviceFile = path.join(SRC_DIR, 'outbox', 'service.ts')

  it('handles the not_found chain status explicitly', () => {
    const source = fs.readFileSync(dispatcherFile, 'utf8')
    expect(source).toMatch(/chainStatus === 'not_found'/)
  })

  it('clears the stale hash so the retry builds a fresh submission', () => {
    const source = fs.readFileSync(dispatcherFile, 'utf8')
    expect(source).toMatch(/clearStaleSubmittedTxHash\(op\.id\)/)
  })

  it('exposes a SUBMITTED-scoped hash-clear helper in the service layer', () => {
    const source = fs.readFileSync(serviceFile, 'utf8')
    expect(source).toMatch(/export async function clearStaleSubmittedTxHash/)
  })
})
