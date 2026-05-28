import dotenv from 'dotenv'
dotenv.config()

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required environment variable: ${key}`)
  return value
}

const nodeEnv = process.env.NODE_ENV || 'development'
const isProduction = nodeEnv === 'production'

/**
 * Logging in this file deliberately uses console.warn / console.error rather
 * than the winston logger: `env.ts` is imported before the logger transports
 * are guaranteed to be ready, and we want startup failures to land on stderr
 * unambiguously. Anything that ships beyond this module routes through the
 * shared `logger` instead.
 */

/**
 * Validate all required environment variables at startup.
 * Fails fast with clear error messages.
 *
 * Production has a stricter set than non-production — secrets that are merely
 * useful in dev (e.g. WALLET_ENCRYPTION_KEY) are mandatory in production.
 */
function validateAllRequiredEnvVars(): void {
  const requiredVars = [
    'STELLAR_NETWORK',
    'STELLAR_RPC_URL',
    'STELLAR_AGENT_SECRET_KEY',
    'VAULT_CONTRACT_ID',
    'USDC_TOKEN_ADDRESS',
    'ANTHROPIC_API_KEY',
    'DATABASE_URL',
    'JWT_SEED',
  ]

  // Production-only secrets and feature flags. These can be left unset in
  // development without crashing the boot, but production refuses to start
  // without them.
  const productionOnlyVars = ['WALLET_ENCRYPTION_KEY']

  const allRequired = isProduction
    ? [...requiredVars, ...productionOnlyVars]
    : requiredVars

  const missing: string[] = []
  for (const key of allRequired) {
    if (!process.env[key]) {
      missing.push(key)
    }
  }

  if (missing.length > 0) {
    const missingList = missing.map(k => `  - ${k}`).join('\n')
    throw new Error(
      `Critical environment variables are missing:\n${missingList}\n\nPlease set these variables before starting the application.`
    )
  }
}

/**
 * CRITICAL: Validate Stellar network to prevent testnet/mainnet mix-ups.
 * Protects against accidental mainnet transactions with testnet keys.
 */
function validateStellarNetwork(network: string): 'testnet' | 'mainnet' | 'futurenet' {
  const validNetworks = ['testnet', 'mainnet', 'futurenet'] as const
  const lowerNetwork = network.toLowerCase()

  if (!validNetworks.includes(lowerNetwork as any)) {
    throw new Error(
      `Invalid STELLAR_NETWORK: "${network}". Must be one of: ${validNetworks.join(', ')}`
    )
  }

  return lowerNetwork as 'testnet' | 'mainnet' | 'futurenet'
}

/**
 * CRITICAL: Validate Stellar secret key format and warn on mainnet in dev.
 */
function validateStellarKey(secretKey: string, network: 'testnet' | 'mainnet' | 'futurenet'): void {
  if (!secretKey.startsWith('S')) {
    throw new Error('STELLAR_AGENT_SECRET_KEY must start with S (invalid Stellar secret key format)')
  }

  if (secretKey.length !== 56) {
    throw new Error(
      `STELLAR_AGENT_SECRET_KEY invalid length: ${secretKey.length}. Stellar keys must be 56 characters.`
    )
  }

  // Use console.error in non-test so this surfaces even before winston is wired
  if (network === 'mainnet' && !isProduction) {
    console.error('')
    console.error('⚠️  CRITICAL WARNING: Using MAINNET in non-production environment!')
    console.error('⚠️  This could result in real financial loss!')
    console.error('⚠️  Verify STELLAR_NETWORK and NODE_ENV settings immediately!')
    console.error('')
  }
}

/**
 * Parse `CORS_ORIGINS` into an explicit allowlist. Defaults to `*` when unset
 * outside production. Production refuses to start without an explicit list —
 * preventing the previous default of a wildcard `cors()` from leaking into
 * production by accident.
 */
function parseCorsOrigins(): string[] | '*' {
  const raw = process.env.CORS_ORIGINS?.trim()
  if (!raw || raw === '*') {
    if (isProduction) {
      throw new Error(
        'CORS_ORIGINS must be set to an explicit comma-separated list in production (wildcard "*" is not allowed).'
      )
    }
    return '*'
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseByteLimit(value: string | undefined, fallback: string): string {
  return value && /^\d+(kb|mb|b)?$/i.test(value) ? value : fallback
}

const stellarNetwork = validateStellarNetwork(requireEnv('STELLAR_NETWORK'))
const agentSecretKey = requireEnv('STELLAR_AGENT_SECRET_KEY')
validateStellarKey(agentSecretKey, stellarNetwork)

validateAllRequiredEnvVars()

const corsOrigins = parseCorsOrigins()

export const config = {
  port: parseInt(process.env.PORT || '3001'),
  nodeEnv,
  isProduction,
  stellar: {
    network: stellarNetwork,
    rpcUrl: requireEnv('STELLAR_RPC_URL'),
    agentSecretKey,
    vaultContractId: requireEnv('VAULT_CONTRACT_ID'),
    usdcTokenAddress: requireEnv('USDC_TOKEN_ADDRESS'),
  },
  ai: {
    anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
    brianApiKey: process.env.BRIAN_API_KEY || '',
  },
  database: {
    url: requireEnv('DATABASE_URL'),
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  jwt: {
    seed: requireEnv('JWT_SEED'),
    session_ttl_hours: parseInt(requireEnv('JWT_SESSION_TTL_HOURS') || '24'),
    nonce_ttl_ms: parseInt(requireEnv('JWT_NONCE_TTL_MS') || '300000'),
    interval_ms: parseInt(requireEnv('JWT_CLEANUP_INTERVAL_MS') || '86400000'),
  },
  whatsapp: {
    twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.WHATSAPP_FROM || '',
  },
  security: {
    walletEncryptionKey: process.env.WALLET_ENCRYPTION_KEY || '',
    cors: {
      origins: corsOrigins,
    },
    bodyLimits: {
      json: parseByteLimit(process.env.BODY_LIMIT_JSON, '1mb'),
      urlencoded: parseByteLimit(process.env.BODY_LIMIT_URLENCODED, '1mb'),
    },
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
      max: parseInt(process.env.RATE_LIMIT_MAX || '100'),
    },
    authRateLimit: {
      windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '900000'),
      max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '20'),
    },
  },
}
