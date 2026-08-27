// #313 — Provider registry: per-provider health ledger (circuit breaker
// semantics matching utils/http-client.ts), selection policies, and manual
// admin failover. Each test loads a fresh module instance with controlled env
// vars so the circuit-breaker threshold/reset window are deterministic.
jest.mock('../../../src/utils/metrics', () => ({
  setFiatProviderCircuitState: jest.fn(),
}))

function loadRegistry(env: Record<string, string>) {
  jest.resetModules()
  const prevEnv = { ...process.env }
  Object.assign(process.env, env)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const registry = require('../../../src/fiat/registry')
  process.env = prevEnv
  return registry as typeof import('../../../src/fiat/registry')
}

describe('fiat provider registry — health tracking + circuit breaker', () => {
  it('registers moonpay and sandbox by default outside production', () => {
    const registry = loadRegistry({
      NODE_ENV: 'test',
      FIAT_ENABLE_SANDBOX_PROVIDER: 'true',
    })
    const names = registry.getAllProviders().map((p: any) => p.name)
    expect(names).toEqual(expect.arrayContaining(['moonpay', 'sandbox']))
  })

  it('opens the circuit after the configured consecutive-failure threshold', () => {
    const registry = loadRegistry({
      FIAT_ENABLE_SANDBOX_PROVIDER: 'true',
      FIAT_PROVIDER_CIRCUIT_BREAKER_THRESHOLD: '3',
      FIAT_PROVIDER_CIRCUIT_BREAKER_RESET_MS: '60000',
    })

    expect(registry.isProviderHealthy('moonpay')).toBe(true)
    registry.recordProviderFailure('moonpay')
    registry.recordProviderFailure('moonpay')
    expect(registry.isProviderHealthy('moonpay')).toBe(true)
    registry.recordProviderFailure('moonpay')
    expect(registry.isProviderHealthy('moonpay')).toBe(false)
    expect(registry.getProviderHealth('moonpay').state).toBe('open')
  })

  it('a success resets the consecutive-failure count and closes the circuit', () => {
    const registry = loadRegistry({
      FIAT_ENABLE_SANDBOX_PROVIDER: 'true',
      FIAT_PROVIDER_CIRCUIT_BREAKER_THRESHOLD: '3',
    })
    registry.recordProviderFailure('moonpay')
    registry.recordProviderFailure('moonpay')
    registry.recordProviderSuccess('moonpay')
    registry.recordProviderFailure('moonpay')
    registry.recordProviderFailure('moonpay')
    // Only 2 consecutive failures since the success reset the counter.
    expect(registry.isProviderHealthy('moonpay')).toBe(true)
  })

  it('transitions an open circuit to half-open (healthy) after the reset window elapses', async () => {
    const registry = loadRegistry({
      FIAT_ENABLE_SANDBOX_PROVIDER: 'true',
      FIAT_PROVIDER_CIRCUIT_BREAKER_THRESHOLD: '1',
      FIAT_PROVIDER_CIRCUIT_BREAKER_RESET_MS: '10',
    })
    registry.recordProviderFailure('moonpay')
    expect(registry.isProviderHealthy('moonpay')).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(registry.isProviderHealthy('moonpay')).toBe(true)
    expect(registry.getProviderHealth('moonpay').state).toBe('half-open')
  })

  it('excludes an open-circuit provider from getHealthyProviders', () => {
    const registry = loadRegistry({
      FIAT_ENABLE_SANDBOX_PROVIDER: 'true',
      FIAT_PROVIDER_CIRCUIT_BREAKER_THRESHOLD: '1',
      FIAT_PROVIDER_CIRCUIT_BREAKER_RESET_MS: '60000',
    })
    registry.recordProviderFailure('moonpay')
    const healthy = registry.getHealthyProviders().map((p: any) => p.name)
    expect(healthy).toEqual(['sandbox'])
  })
})

describe('fiat provider registry — selection policy', () => {
  it('DEFAULT fails over to the next healthy provider when the configured default is unhealthy', () => {
    const registry = loadRegistry({
      FIAT_ENABLE_SANDBOX_PROVIDER: 'true',
      FIAT_DEFAULT_PROVIDER: 'moonpay',
      FIAT_PROVIDER_CIRCUIT_BREAKER_THRESHOLD: '1',
      FIAT_PROVIDER_CIRCUIT_BREAKER_RESET_MS: '60000',
    })
    registry.recordProviderFailure('moonpay')
    const provider = registry.selectProviderForOrder({ policy: 'DEFAULT' })
    expect(provider.name).toBe('sandbox')
  })

  it('PREFER_PROVIDER uses the preferred provider when healthy', () => {
    const registry = loadRegistry({ FIAT_ENABLE_SANDBOX_PROVIDER: 'true' })
    const provider = registry.selectProviderForOrder({
      policy: 'PREFER_PROVIDER',
      preferredProvider: 'sandbox',
    })
    expect(provider.name).toBe('sandbox')
  })

  it('PREFER_PROVIDER falls back to DEFAULT semantics when the preferred provider is unhealthy', () => {
    const registry = loadRegistry({
      FIAT_ENABLE_SANDBOX_PROVIDER: 'true',
      FIAT_DEFAULT_PROVIDER: 'moonpay',
      FIAT_PROVIDER_CIRCUIT_BREAKER_THRESHOLD: '1',
      FIAT_PROVIDER_CIRCUIT_BREAKER_RESET_MS: '60000',
    })
    registry.recordProviderFailure('sandbox')
    const provider = registry.selectProviderForOrder({
      policy: 'PREFER_PROVIDER',
      preferredProvider: 'sandbox',
    })
    expect(provider.name).toBe('moonpay')
  })

  it('ROUND_ROBIN_HEALTHY rotates across the healthy set', () => {
    const registry = loadRegistry({ FIAT_ENABLE_SANDBOX_PROVIDER: 'true' })
    const first = registry.selectProviderForOrder({
      policy: 'ROUND_ROBIN_HEALTHY',
    })
    const second = registry.selectProviderForOrder({
      policy: 'ROUND_ROBIN_HEALTHY',
    })
    expect(first.name).not.toBe(second.name)
  })

  it('throws NoHealthyProvidersError with per-provider reasons when every provider is unhealthy', () => {
    const registry = loadRegistry({
      FIAT_ENABLE_SANDBOX_PROVIDER: 'true',
      FIAT_PROVIDER_CIRCUIT_BREAKER_THRESHOLD: '1',
      FIAT_PROVIDER_CIRCUIT_BREAKER_RESET_MS: '60000',
    })
    registry.recordProviderFailure('moonpay')
    registry.recordProviderFailure('sandbox')

    expect(() =>
      registry.selectProviderForOrder({ policy: 'DEFAULT' })
    ).toThrow('No healthy fiat providers are available')
    try {
      registry.selectProviderForOrder({ policy: 'DEFAULT' })
    } catch (err: any) {
      expect(err.code).toBe('no_healthy_providers')
      expect(err.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider: 'moonpay' }),
          expect.objectContaining({ provider: 'sandbox' }),
        ])
      )
    }
  })
})

describe('fiat provider registry — admin manual failover', () => {
  it('adminSetProviderCircuit forces a provider open/closed, bypassing the failure threshold', () => {
    const registry = loadRegistry({ FIAT_ENABLE_SANDBOX_PROVIDER: 'true' })

    expect(registry.isProviderHealthy('moonpay')).toBe(true)
    const opened = registry.adminSetProviderCircuit('moonpay', 'open')
    expect(opened.state).toBe('open')
    expect(registry.isProviderHealthy('moonpay')).toBe(false)

    const closed = registry.adminSetProviderCircuit('moonpay', 'closed')
    expect(closed.state).toBe('closed')
    expect(registry.isProviderHealthy('moonpay')).toBe(true)
  })

  it('throws for an unknown provider name', () => {
    const registry = loadRegistry({ FIAT_ENABLE_SANDBOX_PROVIDER: 'true' })
    expect(() => registry.adminSetProviderCircuit('nope', 'open')).toThrow(
      'Unknown fiat provider'
    )
  })

  it('getAllProviderHealth reports a snapshot for every registered provider', () => {
    const registry = loadRegistry({ FIAT_ENABLE_SANDBOX_PROVIDER: 'true' })
    const snapshots = registry.getAllProviderHealth()
    expect(snapshots.map((s: any) => s.provider).sort()).toEqual([
      'moonpay',
      'sandbox',
    ])
    expect(snapshots.every((s: any) => s.healthy)).toBe(true)
  })
})
