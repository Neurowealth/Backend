/**
 * Startup-validation tests for src/config/env.ts (#789).
 *
 * These load a fresh copy of the config module with a bad override and assert
 * that module import throws, naming the offending variable. Before #789 a typo
 * like `REFERRAL_MIN_ACTIVATION_DEPOSIT=ten` produced `NaN`, which compares
 * false against every bound and silently disabled the money guard.
 *
 * `jest.isolateModules` is required because env.ts builds `config` once at
 * module scope; resetting the registry is the only way to observe a second
 * startup pass in one Jest process.
 */

type EnvModule = typeof import('../../../src/config/env')

function loadConfigWith(
  overrides: Record<string, string>
): EnvModule['config'] {
  const previous: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key]
    process.env[key] = value
  }

  try {
    let loaded: EnvModule | undefined
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      loaded = require('../../../src/config/env') as EnvModule
    })
    if (!loaded) throw new Error('config module failed to load')
    return loaded.config
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('config startup validation (#789)', () => {
  it('loads with the .env.test defaults', () => {
    const config = loadConfigWith({})
    expect(config.port).toBeGreaterThan(0)
    expect(config.referral.minActivationDeposit).toBeGreaterThanOrEqual(0)
  })

  it('applies valid overrides', () => {
    const config = loadConfigWith({
      PORT: '4321',
      RATE_LIMIT_MAX: '250',
      REFERRAL_MIN_ACTIVATION_DEPOSIT: '25.5',
      SENTRY_TRACES_SAMPLE_RATE: '0.5',
    })
    expect(config.port).toBe(4321)
    expect(config.security.rateLimit.max).toBe(250)
    expect(config.referral.minActivationDeposit).toBe(25.5)
    expect(config.telemetry.sentryTracesSampleRate).toBe(0.5)
  })

  it('rejects a non-numeric money setting instead of producing NaN', () => {
    expect(() =>
      loadConfigWith({ REFERRAL_MIN_ACTIVATION_DEPOSIT: 'abc' })
    ).toThrow(/REFERRAL_MIN_ACTIVATION_DEPOSIT/)
  })

  it('rejects a negative rate-limit maximum', () => {
    expect(() => loadConfigWith({ RATE_LIMIT_MAX: '-1' })).toThrow(
      /RATE_LIMIT_MAX/
    )
  })

  it('rejects a fractional value for an integer setting', () => {
    expect(() => loadConfigWith({ PORT: '3001.5' })).toThrow(/PORT/)
  })

  it('rejects a non-numeric port', () => {
    expect(() => loadConfigWith({ PORT: 'http' })).toThrow(/PORT/)
  })

  it('rejects a zero JWT TTL', () => {
    expect(() => loadConfigWith({ JWT_ACCESS_TTL_MIN: '0' })).toThrow(
      /JWT_ACCESS_TTL_MIN/
    )
  })

  it('rejects a Sentry sample rate above 1', () => {
    expect(() => loadConfigWith({ SENTRY_TRACES_SAMPLE_RATE: '2' })).toThrow(
      /SENTRY_TRACES_SAMPLE_RATE/
    )
  })

  it('rejects a negative Sentry sample rate', () => {
    expect(() => loadConfigWith({ SENTRY_TRACES_SAMPLE_RATE: '-0.1' })).toThrow(
      /SENTRY_TRACES_SAMPLE_RATE/
    )
  })

  it('rejects a negative fiat rate-drift tolerance', () => {
    expect(() =>
      loadConfigWith({ FIAT_RATE_DRIFT_TOLERANCE_PCT: '-1' })
    ).toThrow(/FIAT_RATE_DRIFT_TOLERANCE_PCT/)
  })

  it('rejects a zero fiat quote-lock TTL', () => {
    expect(() => loadConfigWith({ FIAT_QUOTE_LOCK_TTL_MS: '0' })).toThrow(
      /FIAT_QUOTE_LOCK_TTL_MS/
    )
  })
})
