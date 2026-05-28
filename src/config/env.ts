import dotenv from 'dotenv'
dotenv.config()

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required environment variable: ${key}`)
  return value
}

/**
 * Validate all required environment variables at startup.
 * Collects ALL missing/invalid vars before throwing so the operator
 * sees every problem in a single startup failure — not one at a time.
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
    // Added: must be present and valid (see format checks below)
    'WALLET_ENCRYPTION_KEY',
    'NODE_ENV',
  ]

  const errors: string[] = []

  // ── 1. Missing vars ──────────────────────────────────────────────────────
  for (const key of requiredVars) {
    if (!process.env[key]) {
      errors.push(`  - ${key} is missing`)
    }
  }

  // ── 2. WALLET_ENCRYPTION_KEY: must be exactly 64 lowercase hex chars ────
  //       (represents 32 bytes, suitable for AES-256)
  const walletKey = process.env.WALLET_ENCRYPTION_KEY
  if (walletKey && !/^[0-9a-f]{64}$/i.test(walletKey)) {
    errors.push(
      `  - WALLET_ENCRYPTION_KEY is invalid: must be exactly 64 hexadecimal characters (32 bytes). ` +
        `Got length ${walletKey.length}. Generate one with: openssl rand -hex 32`
    )
  }

  // ── 3. NODE_ENV: must be one of the known deployment environments ────────
  const nodeEnv = process.env.NODE_ENV
  const validNodeEnvs = ['development', 'staging', 'production'] as const
  if (nodeEnv && !validNodeEnvs.includes(nodeEnv as any)) {
    errors.push(
      `  - NODE_ENV is invalid: "${nodeEnv}". Must be one of: ${validNodeEnvs.join(' | ')}`
    )
  }

  if (errors.length > 0) {
    const list = errors.join('\n')
    // Use process.stderr so the message is visible even if logger isn't initialised yet
    process.stderr.write(
      `\n[FATAL] Application cannot start — environment configuration errors:\n${list}\n\n` +
        `Fix the variables above and restart the application.\n\n`
    )
    process.exit(1)
  }
}

/**
 * Validate Stellar network to prevent testnet/mainnet mix-ups.
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
 * Validate Stellar secret key format and warn on mainnet in dev.
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

  const env = process.env.NODE_ENV || 'development'
  console.log(`✓ Stellar Agent configured for ${network.toUpperCase()} (NODE_ENV=${env})`)

  if (network === 'mainnet' && env !== 'production') {
    process.stderr.write(
      '\n⚠️  CRITICAL WARNING: Using MAINNET in non-production environment!\n' +
        '⚠️  This could result in real financial loss!\n' +
        '⚠️  Verify STELLAR_NETWORK and NODE_ENV settings immediately!\n\n'
    )
  }
}

// ── Run all validations before anything else is exported ──────────────────
validateAllRequiredEnvVars()

const stellarNetwork = validateStellarNetwork(requireEnv('STELLAR_NETWORK'))
const agentSecretKey = requireEnv('STELLAR_AGENT_SECRET_KEY')
validateStellarKey(agentSecretKey, stellarNetwork)

// ── Typed NODE_ENV ─────────────────────────────────────────────────────────
type NodeEnv = 'development' | 'staging' | 'production'
const nodeEnv = process.env.NODE_ENV as NodeEnv

export const config = {
  port: parseInt(process.env.PORT || '3001'),
  nodeEnv,
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
    session_ttl_hours: parseInt(process.env.JWT_SESSION_TTL_HOURS || '24'),
    nonce_ttl_ms: parseInt(process.env.JWT_NONCE_TTL_MS || '300000'),
    interval_ms: parseInt(process.env.JWT_CLEANUP_INTERVAL_MS || '86400000'),
  },
  security: {
    walletEncryptionKey: requireEnv('WALLET_ENCRYPTION_KEY'),
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean),
    bodySizeLimit: process.env.BODY_SIZE_LIMIT || '100kb',
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
      max: parseInt(process.env.RATE_LIMIT_MAX || '100'),
    },
    authRateLimit: {
      windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '900000'),
      max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '20'),
    },
  },
  whatsapp: {
    twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.WHATSAPP_FROM || '',
  },
  dlq: {
    // Alert when DLQ exceeds this many unresolved events
    alertThreshold: parseInt(process.env.DLQ_ALERT_THRESHOLD || '50'),
  },
}