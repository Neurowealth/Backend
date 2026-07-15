import { logger } from '../utils/logger'

/**
 * Abstraction over secret sources.  All backends expose the same interface so
 * the rest of the application never reads from process.env directly.
 *
 * Supported backends (set via SECRET_BACKEND env var):
 *   env      — plain environment variables (default, current behaviour)
 *   aws-ssm  — AWS SSM Parameter Store; requires @aws-sdk/client-ssm
 */
export interface SecretsProvider {
  /** Retrieve a single secret by its canonical name (e.g. 'JWT_SEED'). */
  get(key: string): Promise<string>
  /** Re-fetch all previously-retrieved secrets.  Called automatically every 5 min. */
  refresh(): Promise<void>
}

// ── Canonical secret names expected by the application ───────────────────────

export const SECRET_KEYS = [
  'JWT_SEED',
  'WALLET_ENCRYPTION_KEY',
  'STELLAR_AGENT_SECRET_KEY',
  'ANTHROPIC_API_KEY',
  'TWILIO_AUTH_TOKEN',
  'DATABASE_URL',
] as const

export type SecretKey = (typeof SECRET_KEYS)[number]

// ── Environment backend (default) ─────────────────────────────────────────────

class EnvSecretsProvider implements SecretsProvider {
  async get(key: string): Promise<string> {
    const val = process.env[key]
    if (!val) throw new Error(`[SecretsProvider] Missing env var: ${key}`)
    return val
  }

  async refresh(): Promise<void> {
    // No-op: env vars are set at process start and do not change.
  }
}

// ── AWS SSM Parameter Store backend ──────────────────────────────────────────

class AwsSsmSecretsProvider implements SecretsProvider {
  private readonly cache = new Map<string, string>()
  private readonly ssmPrefix: string
  private readonly refreshIntervalMs = 5 * 60 * 1000
  private refreshTimer: ReturnType<typeof setInterval> | null = null

  constructor(ssmPrefix = process.env.SSM_PREFIX ?? '/neurowealth') {
    this.ssmPrefix = ssmPrefix
  }

  async get(key: string): Promise<string> {
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    return this.fetchOne(key)
  }

  async refresh(): Promise<void> {
    const keys = [...this.cache.keys()]
    await Promise.all(keys.map((k) => this.fetchOne(k).catch((err) => {
      logger.warn(`[SecretsProvider] Failed to refresh SSM key "${k}": ${err.message}`)
    })))
  }

  /** Fetch a single parameter from SSM, update the cache, and return the value. */
  private async fetchOne(key: string): Promise<string> {
    // Dynamic import so the SDK is only loaded when the aws-ssm backend is active.
    const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm' as string) as typeof import('@aws-sdk/client-ssm')
    const client = new SSMClient({})
    const paramName = `${this.ssmPrefix}/${key}`
    const result = await client.send(
      new GetParameterCommand({ Name: paramName, WithDecryption: true }),
    )
    const value = result.Parameter?.Value
    if (!value) throw new Error(`[SecretsProvider] SSM parameter not found: ${paramName}`)
    this.cache.set(key, value)
    return value
  }

  /** Begin a background timer that refreshes all cached secrets every 5 minutes. */
  startAutoRefresh(): void {
    if (this.refreshTimer) return
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) =>
        logger.error(`[SecretsProvider] Auto-refresh error: ${err.message}`),
      )
    }, this.refreshIntervalMs)
    // Do not block process exit on this timer.
    this.refreshTimer.unref()
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

let _provider: SecretsProvider | null = null

export function createSecretsProvider(): SecretsProvider {
  const backend = process.env.SECRET_BACKEND ?? 'env'
  switch (backend) {
    case 'aws-ssm': {
      const p = new AwsSsmSecretsProvider()
      p.startAutoRefresh()
      logger.info('[SecretsProvider] Using AWS SSM Parameter Store backend')
      return p
    }
    default:
      if (backend !== 'env') {
        logger.warn(`[SecretsProvider] Unknown SECRET_BACKEND "${backend}", falling back to env`)
      }
      return new EnvSecretsProvider()
  }
}

/**
 * Bootstrap: load all required secrets into process.env so existing code that
 * reads process.env directly (e.g. env.ts) continues to work unchanged.
 *
 * Call this once at process startup, before importing any config module.
 */
export async function bootstrapSecrets(): Promise<void> {
  // Lazily create the singleton provider.
  if (!_provider) _provider = createSecretsProvider()

  // Only the SSM backend needs to pre-populate process.env.
  // The env backend already reads from process.env, so this is a no-op there.
  if (process.env.SECRET_BACKEND !== 'aws-ssm') return

  const errors: string[] = []
  await Promise.all(
    SECRET_KEYS.map(async (key) => {
      try {
        const value = await _provider!.get(key)
        process.env[key] = value
      } catch (err) {
        errors.push((err as Error).message)
      }
    }),
  )

  if (errors.length > 0) {
    throw new Error(
      `[SecretsProvider] Failed to load secrets at startup:\n${errors.join('\n')}`,
    )
  }

  logger.info('[SecretsProvider] All secrets loaded from AWS SSM Parameter Store')
}

/** Return the shared SecretsProvider singleton (creates it if not yet initialised). */
export function getSecretsProvider(): SecretsProvider {
  if (!_provider) _provider = createSecretsProvider()
  return _provider
}
