import dotenv from 'dotenv'
import { logger } from '../utils/logger'
dotenv.config()

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required environment variable: ${key}`)
  return value
}

/**
 * Default RPC URLs for each Stellar network.
 * Used when STELLAR_RPC_URL is not explicitly set.
 */
const STELLAR_RPC_URLS: Record<string, string> = {
  testnet: 'https://soroban-testnet.stellar.org',
  mainnet: 'https://soroban-mainnet.stellar.org',
  futurenet: 'https://soroban-futurenet.stellar.org',
}

/**
 * Explorer URLs for each Stellar network.
 */
export const STELLAR_EXPLORER_URLS: Record<string, string> = {
  testnet: 'https://stellar.expert/explorer/testnet',
  mainnet: 'https://stellar.expert/explorer/public',
  futurenet: 'https://stellar.expert/explorer/futurenet',
}

/**
 * Derive the Stellar RPC URL from the network configuration.
 * Priority: STELLAR_RPC_URL env var > network default.
 */
function deriveRpcUrl(network: string): string {
  const envUrl = process.env.STELLAR_RPC_URL
  if (envUrl) return envUrl

  const defaultUrl = STELLAR_RPC_URLS[network]
  if (!defaultUrl) {
    throw new Error(
      `No default RPC URL for network "${network}". Set STELLAR_RPC_URL.`
    )
  }

  return defaultUrl
}

/**
 * Validate all required environment variables at startup.
 * Collects ALL missing/invalid vars before throwing so the operator
 * sees every problem in a single startup failure — not one at a time.
 */
function validateAllRequiredEnvVars(): void {
  const requiredVars = [
    'STELLAR_NETWORK',
    'STELLAR_AGENT_SECRET_KEY',
    'VAULT_CONTRACT_ID',
    'USDC_TOKEN_ADDRESS',
    'ANTHROPIC_API_KEY',
    'DATABASE_URL',
    'JWT_SEED',
    'WALLET_ENCRYPTION_KEY',
    'TWILIO_AUTH_TOKEN',
    'NODE_ENV',
  ]

  const errors: string[] = []

  // ── 1. Missing vars ──────────────────────────────────────────────────────
  for (const key of requiredVars) {
    if (!process.env[key]) {
      errors.push(`Missing required environment variable: ${key}`)
    }
  }

  // ── 2. WALLET_ENCRYPTION_KEY: must be exactly 64 lowercase hex chars ────
  //       (represents 32 bytes, suitable for AES-256)
  const walletKey = process.env.WALLET_ENCRYPTION_KEY
  if (walletKey && !/^[0-9a-f]{64}$/i.test(walletKey)) {
    errors.push(
      `WALLET_ENCRYPTION_KEY is invalid: must be exactly 64 hexadecimal characters (32 bytes). ` +
        `Got length ${walletKey.length}. Generate one with: openssl rand -hex 32`
    )
  }

  // ── 3. JWT_SEED: must be at least 32 characters for cryptographic strength ─
  const jwtSeed = process.env.JWT_SEED
  if (jwtSeed && jwtSeed.length < 32) {
    errors.push(
      `JWT_SEED is too weak: must be at least 32 characters. ` +
        `Got length ${jwtSeed.length}. Use a strong random string or generate with: openssl rand -base64 48`
    )
  }

  // ── 4. ANTHROPIC_API_KEY: must start with sk-ant- prefix ─────────────────
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (anthropicKey && !anthropicKey.startsWith('sk-ant-')) {
    errors.push(
      `ANTHROPIC_API_KEY is invalid: must start with "sk-ant-". ` +
        `Got prefix "${anthropicKey.substring(0, 7)}". Get your key from: https://console.anthropic.com/`
    )
  }

  // ── 5. TWILIO_AUTH_TOKEN: must be at least 32 characters ───────────────────
  const twilioToken = process.env.TWILIO_AUTH_TOKEN
  if (twilioToken && twilioToken.length < 32) {
    errors.push(
      `TWILIO_AUTH_TOKEN is too short: must be at least 32 characters. ` +
        `Got length ${twilioToken.length}. Get your token from: https://console.twilio.com/`
    )
  }

  // ── 6. DATABASE_URL: must be valid postgres:// connection string ────────
  const databaseUrl = process.env.DATABASE_URL
  if (
    databaseUrl &&
    !databaseUrl.startsWith('postgresql://') &&
    !databaseUrl.startsWith('postgres://')
  ) {
    errors.push(
      `DATABASE_URL is invalid: must start with "postgresql://" or "postgres://". ` +
        `Got: "${databaseUrl.substring(0, 20)}...". Example: postgresql://user:pass@localhost:5432/dbname`
    )
  }

  // ── 7. STELLAR_RPC_URL: must be valid HTTPS URL ───────────────────────────
  const stellarRpcUrl = process.env.STELLAR_RPC_URL
  if (stellarRpcUrl && !stellarRpcUrl.startsWith('https://')) {
    errors.push(
      `STELLAR_RPC_URL is invalid: must be a valid HTTPS URL. ` +
        `Got: "${stellarRpcUrl}". Example: https://soroban-testnet.stellar.org`
    )
  }

  // ── 8. VAULT_CONTRACT_ID: must start with C (Stellar contract ID format) ──
  const vaultContractId = process.env.VAULT_CONTRACT_ID
  if (vaultContractId && !vaultContractId.startsWith('C')) {
    errors.push(
      `VAULT_CONTRACT_ID is invalid: must start with "C" (Stellar contract ID format). ` +
        `Got: "${vaultContractId}". Example: CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`
    )
  }

  // ── 9. USDC_TOKEN_ADDRESS: must start with C (Stellar asset contract) ─────
  const usdcTokenAddress = process.env.USDC_TOKEN_ADDRESS
  if (usdcTokenAddress && !usdcTokenAddress.startsWith('C')) {
    errors.push(
      `USDC_TOKEN_ADDRESS is invalid: must start with "C" (Stellar contract ID format). ` +
        `Got: "${usdcTokenAddress}". Example: CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`
    )
  }

  // ── 10. NODE_ENV: must be one of the known deployment environments ────────
  const nodeEnv = process.env.NODE_ENV
  const validNodeEnvs = [
    'development',
    'staging',
    'production',
    'test',
  ] as const
  if (nodeEnv && !validNodeEnvs.includes(nodeEnv as any)) {
    errors.push(
      `NODE_ENV is invalid: "${nodeEnv}". Must be one of: ${validNodeEnvs.join(' | ')}`
    )
  }

  if (errors.length > 0) {
    const list = errors.map((e) => `  - ${e}`).join('\n')
    throw new Error(
      `Application cannot start — environment configuration errors:\n${list}\n\n` +
        `Fix the variables above and restart the application.\n\n` +
        `Reference: See .env.example for required variables and their formats.`
    )
  }
}

/**
 * Validate Stellar network to prevent testnet/mainnet mix-ups.
 * Protects against accidental mainnet transactions with testnet keys.
 */
function validateStellarNetwork(
  network: string
): 'testnet' | 'mainnet' | 'futurenet' {
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
 * Derive the Stellar network from the secret key prefix.
 * Stellar keys encode the network in the prefix:
 *   - S... = testnet
 *   - S... = mainnet (same prefix, but the actual network is determined by passphrase)
 *
 * Since key prefixes don't distinguish testnet/mainnet, we use the account
 * to derive a hint and validate against the configured network.
 */
function deriveNetworkFromKeypair(secretKey: string, network: string): string {
  // All Stellar secret keys start with 'S', so we can't derive the network
  // from the prefix alone. Instead, we validate key format and rely on
  // the configured network. The validation here is format-based.
  return network
}

/**
 * Validate that the secret key matches the expected network.
 * While Stellar keys don't encode network in the prefix, we can:
 * 1. Validate key format (must start with 'S', 56 chars)
 * 2. Warn on mainnet usage in non-production environments
 * 3. Log the active network prominently
 */
function validateKeypairNetworkMatch(
  secretKey: string,
  network: 'testnet' | 'mainnet' | 'futurenet'
): void {
  if (!secretKey.startsWith('S')) {
    throw new Error(
      'STELLAR_AGENT_SECRET_KEY must start with S (invalid Stellar secret key format)'
    )
  }

  if (secretKey.length !== 56) {
    throw new Error(
      `STELLAR_AGENT_SECRET_KEY invalid length: ${secretKey.length}. Stellar keys must be 56 characters.`
    )
  }

  const env = process.env.NODE_ENV || 'development'
  logger.info(
    `✓ Stellar Agent configured for ${network.toUpperCase()} (NODE_ENV=${env})`
  )

  if (network === 'mainnet' && env !== 'production') {
    console.warn(
      '\n⚠️  CRITICAL WARNING: Using MAINNET in non-production environment!\n' +
        '⚠️  This could result in real financial loss!\n' +
        '⚠️  Verify STELLAR_NETWORK and NODE_ENV settings immediately!\n'
    )
  }
}

/** Parse `CORS_ORIGINS` / `ALLOWED_ORIGINS` (comma-separated or `*`). */
function parseCorsOrigins(): string[] | '*' {
  const raw = (process.env.CORS_ORIGINS ?? process.env.ALLOWED_ORIGINS)?.trim()
  if (!raw || raw === '*') return '*'
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseByteLimit(value: string | undefined, fallback: string): string {
  return value && /^\d+(kb|mb|b)?$/i.test(value) ? value : fallback
}

/**
 * Parse `TRUST_PROXY` for Express `app.set('trust proxy', …)`.
 *
 * Supported values:
 *   (unset)              → 1  (single reverse-proxy hop — Nginx, ALB, Heroku, etc.)
 *   false | 0            → do not trust X-Forwarded-* headers
 *   true                 → trust all hops (not recommended in production)
 *   <number>             → trust that many proxy hops
 *   loopback             → trust loopback addresses
 *   loopback,linklocal   → comma-separated Express trust-proxy keywords or IPs
 */
function parseTrustProxy(
  value: string | undefined
): boolean | number | string | string[] {
  if (!value?.trim()) return 1

  const trimmed = value.trim().toLowerCase()
  if (trimmed === 'false' || trimmed === '0') return false
  if (trimmed === 'true') return true
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10)
  if (value.includes(',')) {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  return value.trim()
}

// ── Run all validations before anything else is exported ──────────────────
validateAllRequiredEnvVars()

const stellarNetwork = validateStellarNetwork(requireEnv('STELLAR_NETWORK'))
const agentSecretKey = requireEnv('STELLAR_AGENT_SECRET_KEY')
validateKeypairNetworkMatch(agentSecretKey, stellarNetwork)
const stellarRpcUrl = deriveRpcUrl(stellarNetwork)

// Log the active network prominently at startup
logger.info(`🌐 Active Stellar network: ${stellarNetwork.toUpperCase()}`)
logger.info(`   RPC URL: ${stellarRpcUrl}`)
logger.info(`   Explorer: ${STELLAR_EXPLORER_URLS[stellarNetwork]}`)

const corsOrigins = parseCorsOrigins()
const bodySizeLimit = parseByteLimit(
  process.env.BODY_SIZE_LIMIT ?? process.env.BODY_LIMIT_JSON,
  '64kb'
)

// ── Typed NODE_ENV ─────────────────────────────────────────────────────────
type NodeEnv = 'development' | 'staging' | 'production' | 'test'
const nodeEnv = process.env.NODE_ENV as NodeEnv

export const config = {
  port: parseInt(process.env.PORT || '3001'),
  nodeEnv,
  stellar: {
    network: stellarNetwork,
    rpcUrl: stellarRpcUrl,
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
    /**
     * Max connections Prisma may open per instance. Applied to the connection
     * string as `connection_limit` (see src/db/index.ts). Keep this in line with
     * the Postgres `max_connections` budget divided across all replicas.
     */
    connectionLimit: parseInt(process.env.DATABASE_CONNECTION_LIMIT || '10'),
    /** How often (ms) to poll prisma.$metrics.json() for pool gauges. */
    poolMetricsIntervalMs: parseInt(
      process.env.DB_POOL_METRICS_INTERVAL_MS || '15000'
    ),
  },
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '30000'),
  jwt: {
    /**
     * JWT_SEED: 64-hex secret used to sign/verify JWTs.
     * Rotate every 90 days. Inject via AWS Secrets Manager, HashiCorp Vault,
     * or GitHub Actions secrets — never commit the raw value.
     */
    seed: requireEnv('JWT_SEED'),
    session_ttl_hours: parseInt(process.env.JWT_SESSION_TTL_HOURS || '24'),
    nonce_ttl_ms: parseInt(process.env.JWT_NONCE_TTL_MS || '300000'),
    interval_ms: parseInt(process.env.JWT_CLEANUP_INTERVAL_MS || '86400000'),
  },
  security: {
    /**
     * WALLET_ENCRYPTION_KEY: 32-byte hex key for encrypting stored wallet secrets.
     * Rotate with a coordinated key migration. Inject via AWS Secrets Manager or
     * HashiCorp Vault — never commit the raw value.
     */
    walletEncryptionKey: process.env.WALLET_ENCRYPTION_KEY || '',
    cors: {
      origins: corsOrigins,
    },
    /** Used by `corsandbody` — empty when wildcard (non-production allows all origins). */
    allowedOrigins: corsOrigins === '*' ? [] : corsOrigins,
    bodySizeLimit,
    bodyLimits: {
      json: parseByteLimit(process.env.BODY_LIMIT_JSON, bodySizeLimit),
      urlencoded: parseByteLimit(
        process.env.BODY_LIMIT_URLENCODED,
        bodySizeLimit
      ),
    },
    /** Global rate limiter — applied to every route */
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
      max: parseInt(process.env.RATE_LIMIT_MAX || '100'),
    },
    /** Auth endpoints — stricter to resist credential stuffing */
    authRateLimit: {
      windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '900000'),
      max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '20'),
    },
    /** Admin endpoints — tightest limits (management/sensitive ops) */
    adminRateLimit: {
      windowMs: parseInt(process.env.ADMIN_RATE_LIMIT_WINDOW_MS || '900000'),
      max: parseInt(process.env.ADMIN_RATE_LIMIT_MAX || '10'),
    },
    /** Internal/agent endpoints — higher throughput for service-to-service calls */
    internalRateLimit: {
      windowMs: parseInt(process.env.INTERNAL_RATE_LIMIT_WINDOW_MS || '60000'),
      max: parseInt(process.env.INTERNAL_RATE_LIMIT_MAX || '500'),
    },
    /** Public webhook endpoints — resist spoofed / replay floods (e.g. Twilio) */
    webhookRateLimit: {
      windowMs: parseInt(process.env.WEBHOOK_RATE_LIMIT_WINDOW_MS || '60000'),
      max: parseInt(process.env.WEBHOOK_RATE_LIMIT_MAX || '30'),
    },
    /**
     * Express `trust proxy` setting — required for correct `req.ip` behind
     * Nginx, Cloudflare, AWS ALB, Heroku, Kubernetes ingress, etc.
     * See `parseTrustProxy` for accepted `TRUST_PROXY` values.
     */
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    /**
     * TRUSTED_IPS: comma-separated list of IPv4/IPv6 addresses that bypass rate
     * limiting entirely (e.g. your CI runner, internal health-check probe).
     * INTERNAL_SERVICE_TOKEN: bearer token accepted in X-Internal-Token header
     * for service-to-service calls that should skip per-route limits.
     */
    trustedIps: (process.env.TRUSTED_IPS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN || '',
  },
  whatsapp: {
    twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.WHATSAPP_FROM || '',
  },
  dlq: {
    alertThreshold: parseInt(process.env.DLQ_ALERT_THRESHOLD || '50'),
    alertCooldownMs: parseInt(process.env.DLQ_ALERT_COOLDOWN_MS || '900000'), // 15 minutes default
  },
  httpClient: {
    timeoutMs: parseInt(process.env.HTTP_CLIENT_TIMEOUT_MS || '10000'),
    maxRetries: parseInt(process.env.HTTP_CLIENT_MAX_RETRIES || '3'),
    baseDelayMs: parseInt(process.env.HTTP_CLIENT_BASE_DELAY_MS || '200'),
    maxDelayMs: parseInt(process.env.HTTP_CLIENT_MAX_DELAY_MS || '10000'),
    circuitBreakerThreshold: parseInt(
      process.env.HTTP_CLIENT_CIRCUIT_BREAKER_THRESHOLD || '5'
    ),
    circuitBreakerResetMs: parseInt(
      process.env.HTTP_CLIENT_CIRCUIT_BREAKER_RESET_MS || '30000'
    ),
  },
  shutdown: {
    /** Grace period (ms) for in-force requests to complete before force-exit */
    drainTimeoutMs: parseInt(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS || '30000'),
  },
  retention: {
    /** How many days to keep processed_events rows (default: 90 days) */
    processedEventsDays: parseInt(
      process.env.RETENTION_PROCESSED_EVENTS_DAYS || '90'
    ),
    /** How many days to keep RESOLVED dead_letter_events (default: 30 days) */
    deadLetterEventsDays: parseInt(
      process.env.RETENTION_DEAD_LETTER_EVENTS_DAYS || '30'
    ),
    /** How many days to keep agent_logs rows (default: 60 days) */
    agentLogsDays: parseInt(process.env.RETENTION_AGENT_LOGS_DAYS || '60'),
    /** Interval between retention job runs in ms (default: 24 hours) */
    intervalMs: parseInt(process.env.RETENTION_INTERVAL_MS || '86400000'),
  },
  protocolRisk: {
    /** Interval between protocol risk-score recomputations in ms (default: 6 hours) */
    intervalMs: parseInt(process.env.PROTOCOL_RISK_INTERVAL_MS || '21600000'),
  },
  alertRules: {
    /** Interval between user alert-rule evaluation sweeps in ms (default: 1 minute). */
    intervalMs: parseInt(process.env.ALERT_RULES_INTERVAL_MS || '60000'),
  },
  referral: {
    /**
     * Minimum confirmed deposit (in asset units) that a referred user must make
     * for their referral to activate. Activation is single-deposit: one
     * confirmed deposit Transaction must cross this threshold on its own. Guards
     * against dust self-referral farming.
     */
    minActivationDeposit: parseFloat(
      process.env.REFERRAL_MIN_ACTIVATION_DEPOSIT || '10'
    ),
    /** Reward paid to the referrer on activation (asset units). */
    ownerReward: parseFloat(process.env.REFERRAL_OWNER_REWARD || '5'),
    /** Reward paid to the referred user on activation (asset units). 0 disables. */
    referredReward: parseFloat(process.env.REFERRAL_REFERRED_REWARD || '5'),
    /** Asset symbol rewards are denominated in — must be a supported asset. */
    rewardAsset: process.env.REFERRAL_REWARD_ASSET || 'USDC',
    /**
     * Vault/treasury contract method invoked to transfer a reward into a user's
     * wallet, reusing executeWriteContractCall signed by the agent keypair. The
     * on-chain method itself lives in the contract repo; kept configurable so
     * this backend does not hard-code a method that may be renamed there.
     */
    rewardContractMethod:
      process.env.REFERRAL_REWARD_CONTRACT_METHOD || 'transfer_reward',
    /** Interval between referral payout sweeps in ms (default: 2 minutes). */
    payoutIntervalMs: parseInt(
      process.env.REFERRAL_PAYOUT_INTERVAL_MS || '120000'
    ),
  },
}
