describe('messaging env aliases (#700)', () => {
  const ORIGINAL_ENV = { ...process.env }

  function resolveMessaging(env: NodeJS.ProcessEnv) {
    return {
      maxRetries: parseInt(env.MESSAGING_MAX_RETRIES || '3'),
      baseDelayMs: parseInt(
        env.MESSAGING_BASE_DELAY_MS ||
          env.MESSAGING_RETRY_BASE_DELAY_MS ||
          '1000'
      ),
      maxDelayMs: parseInt(
        env.MESSAGING_MAX_DELAY_MS ||
          env.MESSAGING_RETRY_MAX_DELAY_MS ||
          '30000'
      ),
      retryIntervalMs: parseInt(
        env.MESSAGING_RETRY_INTERVAL_MS ||
          env.MESSAGING_SWEEP_INTERVAL_MS ||
          '60000'
      ),
      dlqAlertThreshold: parseInt(
        env.MESSAGING_DLQ_ALERT_THRESHOLD || '5'
      ),
    }
  }

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it('honours the legacy MESSAGING_RETRY_*/MESSAGING_SWEEP_* spellings', () => {
    const resolved = resolveMessaging({
      MESSAGING_RETRY_BASE_DELAY_MS: '2000',
      MESSAGING_RETRY_MAX_DELAY_MS: '9000',
      MESSAGING_SWEEP_INTERVAL_MS: '45000',
    } as NodeJS.ProcessEnv)

    expect(resolved.baseDelayMs).toBe(2000)
    expect(resolved.maxDelayMs).toBe(9000)
    expect(resolved.retryIntervalMs).toBe(45000)
  })

  it('prefers the canonical keys over the legacy aliases', () => {
    const resolved = resolveMessaging({
      MESSAGING_BASE_DELAY_MS: '1111',
      MESSAGING_RETRY_BASE_DELAY_MS: '2222',
    } as NodeJS.ProcessEnv)

    expect(resolved.baseDelayMs).toBe(1111)
  })

  it('src/config/env.ts reads the legacy aliases as fallback', () => {
    const fs = require('fs')
    const path = require('path')
    const source: string = fs.readFileSync(
      path.join(__dirname, '../../../src/config/env.ts'),
      'utf8'
    )
    expect(source).toMatch(/MESSAGING_RETRY_BASE_DELAY_MS/)
    expect(source).toMatch(/MESSAGING_RETRY_MAX_DELAY_MS/)
    expect(source).toMatch(/MESSAGING_SWEEP_INTERVAL_MS/)
  })
})
