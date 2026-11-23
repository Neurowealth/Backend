/**
 * Config coverage for the internal/admin tokens (#797).
 *
 * Both tokens are optional on purpose: existing deployments that rely on the
 * IP allowlist keep booting without them. This test pins the contract that
 * config snapshots them once and exposes empty strings when they are absent,
 * so a consumer can safely test `if (token)` before comparing.
 */
type AdminTokensEnvModule = typeof import('../../../src/config/env')

function loadSecurityConfig(overrides: Record<string, string | undefined>) {
  const previous: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  try {
    let loaded: AdminTokensEnvModule | undefined
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      loaded = require('../../../src/config/env') as AdminTokensEnvModule
    })
    if (!loaded) throw new Error('config module failed to load')
    return loaded.config.security
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('config.security token fields (#797)', () => {
  it('exposes both test tokens from the environment', () => {
    const security = loadSecurityConfig({})
    expect(security.adminApiToken).toBe(process.env.ADMIN_API_TOKEN)
    expect(security.internalServiceToken).toBe(
      process.env.INTERNAL_SERVICE_TOKEN
    )
  })

  it('uses empty strings when the tokens are absent', () => {
    const security = loadSecurityConfig({
      ADMIN_API_TOKEN: undefined,
      INTERNAL_SERVICE_TOKEN: undefined,
    })
    expect(security.adminApiToken).toBe('')
    expect(security.internalServiceToken).toBe('')
  })

  it('picks up overrides at module load', () => {
    const security = loadSecurityConfig({
      ADMIN_API_TOKEN: 'admin-override',
      INTERNAL_SERVICE_TOKEN: 'internal-override',
    })
    expect(security.adminApiToken).toBe('admin-override')
    expect(security.internalServiceToken).toBe('internal-override')
  })
})
