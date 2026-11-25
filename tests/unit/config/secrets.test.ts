import {
  createSecretsProvider,
  bootstrapSecrets,
  getSecretsProvider,
} from '../../../src/config/secrets'
import { logger } from '../../../src/utils/logger'
import { decryptSecretWithFallback } from '../../../src/stellar/wallet'
import * as crypto from 'crypto'

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

// ── Mock @aws-sdk/client-ssm ──────────────────────────────────────────────────

const mockSend = jest.fn()

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  GetParameterCommand: jest.fn().mockImplementation((input) => ({ input })),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

function setEnv(vars: Record<string, string>) {
  Object.entries(vars).forEach(([k, v]) => (process.env[k] = v))
}

function deleteEnv(...keys: string[]) {
  keys.forEach((k) => delete process.env[k])
}

// ── EnvSecretsProvider ────────────────────────────────────────────────────────

describe('EnvSecretsProvider (SECRET_BACKEND=env)', () => {
  beforeEach(() => {
    deleteEnv('SECRET_BACKEND')
  })

  it('returns the env var value', async () => {
    setEnv({ JWT_SEED: 'my-super-secret-seed-at-least-32-chars!!' })
    const provider = createSecretsProvider()
    await expect(provider.get('JWT_SEED')).resolves.toBe(
      'my-super-secret-seed-at-least-32-chars!!'
    )
    deleteEnv('JWT_SEED')
  })

  it('throws when the env var is missing', async () => {
    deleteEnv('JWT_SEED')
    const provider = createSecretsProvider()
    await expect(provider.get('JWT_SEED')).rejects.toThrow(
      'Missing env var: JWT_SEED'
    )
  })

  it('refresh() resolves without error', async () => {
    const provider = createSecretsProvider()
    await expect(provider.refresh()).resolves.toBeUndefined()
  })
})

// ── AwsSsmSecretsProvider ─────────────────────────────────────────────────────

describe('AwsSsmSecretsProvider (SECRET_BACKEND=aws-ssm)', () => {
  beforeEach(() => {
    setEnv({ SECRET_BACKEND: 'aws-ssm', SSM_PREFIX: '/test' })
    mockSend.mockReset()
  })

  afterEach(() => {
    deleteEnv('SECRET_BACKEND', 'SSM_PREFIX')
  })

  it('fetches a secret from SSM and caches it', async () => {
    mockSend.mockResolvedValueOnce({
      Parameter: { Value: 'ssm-jwt-seed-value' },
    })
    const provider = createSecretsProvider()

    const val = await provider.get('JWT_SEED')
    expect(val).toBe('ssm-jwt-seed-value')
    expect(mockSend).toHaveBeenCalledTimes(1)

    // Second call should use the cache — mockSend not called again.
    const cached = await provider.get('JWT_SEED')
    expect(cached).toBe('ssm-jwt-seed-value')
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('throws when SSM returns no value', async () => {
    mockSend.mockResolvedValueOnce({ Parameter: {} })
    const provider = createSecretsProvider()
    await expect(provider.get('WALLET_ENCRYPTION_KEY')).rejects.toThrow(
      'SSM parameter not found'
    )
  })

  it('refresh() re-fetches all cached keys', async () => {
    mockSend
      .mockResolvedValueOnce({ Parameter: { Value: 'first-value' } })
      .mockResolvedValueOnce({ Parameter: { Value: 'refreshed-value' } })
    const provider = createSecretsProvider()

    await provider.get('JWT_SEED') // populates cache
    await provider.refresh() // re-fetches

    // After refresh the cache should hold the refreshed value.
    const afterRefresh = await provider.get('JWT_SEED')
    expect(afterRefresh).toBe('refreshed-value')
    expect(mockSend).toHaveBeenCalledTimes(2)
  })

  it('refresh() logs a warning and continues if one key fails', async () => {
    mockSend
      .mockResolvedValueOnce({ Parameter: { Value: 'ok-value' } }) // initial get
      .mockRejectedValueOnce(new Error('SSM throttled')) // refresh fails
    const provider = createSecretsProvider()

    await provider.get('JWT_SEED')
    await provider.refresh()

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to refresh SSM key')
    )
  })
})

// ── bootstrapSecrets ──────────────────────────────────────────────────────────

describe('bootstrapSecrets()', () => {
  afterEach(() => {
    deleteEnv('SECRET_BACKEND')
  })

  it('is a no-op when SECRET_BACKEND=env', async () => {
    deleteEnv('SECRET_BACKEND')
    // bootstrapSecrets with env backend should resolve without calling SSM
    await expect(bootstrapSecrets()).resolves.toBeUndefined()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('populates process.env from SSM when SECRET_BACKEND=aws-ssm', async () => {
    setEnv({ SECRET_BACKEND: 'aws-ssm', SSM_PREFIX: '/neurowealth' })
    const oldKey = 'b'.repeat(64)
    const values: Record<string, string> = {
      JWT_SEED: 'j'.repeat(32),
      WALLET_ENCRYPTION_KEY: 'a'.repeat(64),
      WALLET_ENCRYPTION_KEY_OLD: oldKey,
      STELLAR_AGENT_SECRET_KEY: `S${'A'.repeat(55)}`,
      ANTHROPIC_API_KEY: 'sk-ant-test',
      TWILIO_AUTH_TOKEN: 't'.repeat(32),
      DATABASE_URL: 'postgresql://user:pass@localhost/db',
    }
    mockSend.mockImplementation(async (command: any) => ({
      Parameter: { Value: values[command.input.Name.split('/').pop()] },
    }))

    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      Buffer.from(oldKey, 'hex'),
      iv
    )
    let encrypted = cipher.update('legacy-wallet-secret', 'utf8', 'hex')
    encrypted += cipher.final('hex')
    const authTag = cipher.getAuthTag()

    await bootstrapSecrets()

    expect(process.env['WALLET_ENCRYPTION_KEY_OLD']).toBe(oldKey)
    expect(
      decryptSecretWithFallback(
        encrypted,
        iv.toString('hex'),
        authTag.toString('hex')
      )
    ).toEqual({ secret: 'legacy-wallet-secret', keyUsed: 'fallback' })
  })
})

// ── getSecretsProvider singleton ──────────────────────────────────────────────

describe('getSecretsProvider()', () => {
  it('returns the same instance on repeated calls', () => {
    const a = getSecretsProvider()
    const b = getSecretsProvider()
    expect(a).toBe(b)
  })
})
