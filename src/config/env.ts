import dotenv from 'dotenv'
import { logger } from '../utils/logger'
import { parseNumericEnv } from './numeric-env'
dotenv.config()

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value && process.env.SECRET_BACKEND === 'aws-ssm') {
    return `__SSM_PENDING_${key}__`
  }
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
  const ssmManagedSecrets = new Set([
    'STELLAR_AGENT_SECRET_KEY',
    'ANTHROPIC_API_KEY',
    'DATABASE_URL',
    'JWT_SEED',
    'WALLET_ENCRYPTION_KEY',
    'TWILIO_AUTH_TOKEN',
  ])

  for (const key of [
    'JWT_SEED',
    'WALLET_ENCRYPTION_KEY',
    'STELLAR_AGENT_SECRET_KEY',
    'ANTHROPIC_API_KEY',
    'TWILIO_AUTH_TOKEN',
    'DATABASE_URL',
  ]) {
    const expiresAt = process.env[`SECRET_EXPIRY_${key}`]
    if (expiresAt) {
      const expiry = Date.parse(expiresAt)
      if (!Number.isFinite(expiry) || expiry <= Date.now()) {
        errors.push(`${key} is expired or has an invalid SECRET_EXPIRY_${key}`)
      }
    }
  }

  // ── 1. Missing vars ──────────────────────────────────────────────────────
  for (const key of requiredVars) {
    if (
      !process.env[key] &&
      !(process.env.SECRET_BACKEND === 'aws-ssm' && ssmManagedSecrets.has(key))
    ) {
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
export function parseTrustProxy(
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

const bodySizeLimit = parseByteLimit(
  process.env.BODY_SIZE_LIMIT ?? process.env.BODY_LIMIT_JSON,
  '64kb'
)

// ── Typed NODE_ENV ─────────────────────────────────────────────────────────
type NodeEnv = 'development' | 'staging' | 'production' | 'test'
const nodeEnv = process.env.NODE_ENV as NodeEnv

const marketVolatilityCircuitBreaker = {
  enabled: process.env.MARKET_VOLATILITY_BREAKER_ENABLED !== 'false',
  thresholdPct: Number(
    process.env.MARKET_VOLATILITY_BREAKER_THRESHOLD_PCT ?? '75'
  ),
}

if (
  !Number.isFinite(marketVolatilityCircuitBreaker.thresholdPct) ||
  marketVolatilityCircuitBreaker.thresholdPct <= 0
) {
  throw new Error(
    'MARKET_VOLATILITY_BREAKER_THRESHOLD_PCT must be a finite number greater than 0'
  )
}

export const config = {
  port: parseNumericEnv('PORT', '3001', { integer: true }),
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
    connectionLimit: parseNumericEnv('DATABASE_CONNECTION_LIMIT', '10', {
      integer: true,
    }),
    /** How often (ms) to poll prisma.$metrics.json() for pool gauges. */
    poolMetricsIntervalMs: parseNumericEnv(
      'DB_POOL_METRICS_INTERVAL_MS',
      '15000',
      { integer: true }
    ),
  },
  requestTimeoutMs: parseNumericEnv('REQUEST_TIMEOUT_MS', '30000', {
    integer: true,
  }),
  jwt: {
    /**
     * JWT_SEED: 64-hex secret used to sign/verify JWTs.
     * Rotate every 90 days. Inject via AWS Secrets Manager, HashiCorp Vault,
     * or GitHub Actions secrets — never commit the raw value.
     */
    seed: requireEnv('JWT_SEED'),
    previousSeeds: (process.env.JWT_PREVIOUS_SEEDS || '')
      .split(',')
      .map((seed) => seed.trim())
      .filter(Boolean),
    session_ttl_hours: parseNumericEnv('JWT_SESSION_TTL_HOURS', '24', {
      integer: true,
      min: 1,
    }),
    nonce_ttl_ms: parseNumericEnv('JWT_NONCE_TTL_MS', '300000', {
      integer: true,
      min: 1,
    }),
    interval_ms: parseNumericEnv('JWT_CLEANUP_INTERVAL_MS', '86400000', {
      integer: true,
      min: 1,
    }),
    /** Access-token lifetime in minutes (default 15). */
    accessTokenTtlMin: parseNumericEnv('JWT_ACCESS_TTL_MIN', '15', {
      integer: true,
      min: 1,
    }),
    /** Refresh-token lifetime in days (default 7). */
    refreshTokenTtlDays: parseNumericEnv('JWT_REFRESH_TTL_DAYS', '7', {
      integer: true,
      min: 1,
    }),
  },
  security: {
    /**
     * WALLET_ENCRYPTION_KEY: 32-byte hex key for encrypting stored wallet secrets.
     * Rotate with a coordinated key migration. Inject via AWS Secrets Manager or
     * HashiCorp Vault — never commit the raw value.
     */
    walletEncryptionKey: process.env.WALLET_ENCRYPTION_KEY || '',
    /**
     * CORS origin allowlist is deliberately NOT parsed here. It is owned by
     * `src/config/cors.ts` (#471), which normalises origins, handles subdomain
     * wildcards, and decides environment strictness. Two parsers for one setting
     * is how the previous implementation ended up enforcing a variable the env
     * files never set.
     */
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
      windowMs: parseNumericEnv('RATE_LIMIT_WINDOW_MS', '900000', {
        integer: true,
        min: 1,
      }),
      max: parseNumericEnv('RATE_LIMIT_MAX', '100', { integer: true, min: 1 }),
    },
    /** Auth endpoints — stricter to resist credential stuffing */
    authRateLimit: {
      windowMs: parseNumericEnv('AUTH_RATE_LIMIT_WINDOW_MS', '900000', {
        integer: true,
        min: 1,
      }),
      max: parseNumericEnv('AUTH_RATE_LIMIT_MAX', '20', {
        integer: true,
        min: 1,
      }),
    },
    /** Admin endpoints — tightest limits (management/sensitive ops) */
    adminRateLimit: {
      windowMs: parseNumericEnv('ADMIN_RATE_LIMIT_WINDOW_MS', '900000', {
        integer: true,
        min: 1,
      }),
      max: parseNumericEnv('ADMIN_RATE_LIMIT_MAX', '10', {
        integer: true,
        min: 1,
      }),
    },
    /** Internal/agent endpoints — higher throughput for service-to-service calls */
    internalRateLimit: {
      windowMs: parseNumericEnv('INTERNAL_RATE_LIMIT_WINDOW_MS', '60000', {
        integer: true,
        min: 1,
      }),
      max: parseNumericEnv('INTERNAL_RATE_LIMIT_MAX', '500', {
        integer: true,
        min: 1,
      }),
    },
    /**
     * Anonymous traffic (#473) — unauthenticated callers to the public API.
     * Deliberately far stricter than the authenticated tier: an anonymous
     * request has no proven identity, so the budget exists to slow enumeration
     * and scraping rather than to accommodate legitimate use. The split only
     * works if it is enforced on *both* sides — if the authenticated tier were
     * as tight, every user behind one corporate NAT would exhaust the shared
     * per-IP budget, and the limiter would push load onto the login endpoint.
     */
    anonymousRateLimit: {
      windowMs: parseNumericEnv('ANONYMOUS_RATE_LIMIT_WINDOW_MS', '900000', {
        integer: true,
        min: 1,
      }),
      max: parseNumericEnv('ANONYMOUS_RATE_LIMIT_MAX', '60', {
        integer: true,
        min: 1,
      }),
    },
    /**
     * Authenticated traffic (#473) — keyed per principal (see principalKey in
     * src/middleware/rateLimiter.ts), so this is a per-user or per-API-key
     * allowance rather than a per-IP one.
     */
    authenticatedRateLimit: {
      windowMs: parseNumericEnv(
        'AUTHENTICATED_RATE_LIMIT_WINDOW_MS',
        '900000',
        { integer: true, min: 1 }
      ),
      max: parseNumericEnv('AUTHENTICATED_RATE_LIMIT_MAX', '600', {
        integer: true,
        min: 1,
      }),
    },
    /**
     * Sensitive operations (#473) — money movement, credential changes and
     * anything else where one request has irreversible consequences. Applied
     * per-endpoint on top of the caller's normal budget, not instead of it:
     * a tight limit here should throttle the risky action, not the reads the
     * user does around it.
     */
    sensitiveRateLimit: {
      windowMs: parseNumericEnv('SENSITIVE_RATE_LIMIT_WINDOW_MS', '900000', {
        integer: true,
        min: 1,
      }),
      max: parseNumericEnv('SENSITIVE_RATE_LIMIT_MAX', '10', {
        integer: true,
        min: 1,
      }),
    },
    /**
     * Portfolio optimizer (#322) — the only genuinely CPU-bound endpoint in the
     * API. Tighter than the global limiter and applied per-endpoint rather than
     * via the apiRoutes table, which would throttle read-only portfolio traffic
     * too. Pairs with the in-flight semaphore in src/utils/concurrency.ts: this
     * bounds requests per window, that bounds how many run at once.
     */
    optimizerRateLimit: {
      windowMs: parseNumericEnv('OPTIMIZER_RATE_LIMIT_WINDOW_MS', '60000', {
        integer: true,
        min: 1,
      }),
      max: parseNumericEnv('OPTIMIZER_RATE_LIMIT_MAX', '5', {
        integer: true,
        min: 1,
      }),
    },
    /**
     * Strategy simulate (#344) — a CPU-bound historical replay, like the
     * optimizer. Tighter than the global limiter so the replay cannot be used
     * as a CPU-exhaustion vector; pairs with the short-TTL result cache so
     * identical preview requests are served without recomputing.
     */
    simulateRateLimit: {
      windowMs: parseNumericEnv('SIMULATE_RATE_LIMIT_WINDOW_MS', '60000', {
        integer: true,
        min: 1,
      }),
      max: parseNumericEnv('SIMULATE_RATE_LIMIT_MAX', '6', {
        integer: true,
        min: 1,
      }),
    },
    /** Public webhook endpoints — resist spoofed / replay floods (e.g. Twilio) */
    webhookRateLimit: {
      windowMs: parseNumericEnv('WEBHOOK_RATE_LIMIT_WINDOW_MS', '60000', {
        integer: true,
        min: 1,
      }),
      max: parseNumericEnv('WEBHOOK_RATE_LIMIT_MAX', '30', {
        integer: true,
        min: 1,
      }),
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
    /**
     * ADMIN_API_TOKEN: admin bearer token accepted on internal endpoints such
     * as /metrics (#797). Optional so existing deployments that rely on IP
     * allowlisting keep booting; when unset, admin-token auth is simply not
     * offered. Reads are centralised here so the value is loaded once and
     * every consumer sees the same configuration.
     */
    adminApiToken: process.env.ADMIN_API_TOKEN || '',
  },
  whatsapp: {
    twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.WHATSAPP_FROM || '',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    apiUrl: process.env.TELEGRAM_API_URL || 'https://api.telegram.org',
  },
  messaging: {
    maxRetries: parseNumericEnv('MESSAGING_MAX_RETRIES', '3', {
      integer: true,
    }),
    baseDelayMs: parseNumericEnv(
      'MESSAGING_BASE_DELAY_MS',
      process.env.MESSAGING_RETRY_BASE_DELAY_MS || '1000',
      { integer: true }
    ),
    maxDelayMs: parseNumericEnv(
      'MESSAGING_MAX_DELAY_MS',
      process.env.MESSAGING_RETRY_MAX_DELAY_MS || '30000',
      { integer: true }
    ),
    retryIntervalMs: parseNumericEnv(
      'MESSAGING_RETRY_INTERVAL_MS',
      process.env.MESSAGING_SWEEP_INTERVAL_MS || '60000',
      { integer: true }
    ),
    sendingLeaseMs: parseNumericEnv('MESSAGING_SENDING_LEASE_MS', '600000', {
      integer: true,
    }),
    fallbackEnabled: process.env.MESSAGING_FALLBACK_ENABLED !== 'false',
    dlqAlertThreshold: parseNumericEnv('MESSAGING_DLQ_ALERT_THRESHOLD', '5', {
      integer: true,
    }),
  },
  transcription: {
    provider: process.env.TRANSCRIPTION_PROVIDER || 'openai',
    /**
     * Secondary provider used when the primary is unavailable (#400). The
     * registry wraps both into a single provider that retries the fallback
     * only on a TranscriptionUnavailableError — not on UnsupportedAudioError,
     * where a second vendor would fail identically.
     */
    fallbackProvider: process.env.TRANSCRIPTION_FALLBACK_PROVIDER || 'deepgram',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
    model: process.env.TRANSCRIPTION_MODEL || 'whisper-1',
    deepgramModel: process.env.DEEPGRAM_MODEL || 'nova-2',
    apiUrl:
      process.env.TRANSCRIPTION_API_URL ||
      'https://api.openai.com/v1/audio/transcriptions',
    deepgramApiUrl:
      process.env.DEEPGRAM_API_URL || 'https://api.deepgram.com/v1/listen',
    confidenceThreshold: parseNumericEnv(
      'TRANSCRIPTION_CONFIDENCE_THRESHOLD',
      '0.6'
    ),
  },
  dlq: {
    alertThreshold: parseNumericEnv('DLQ_ALERT_THRESHOLD', '50', {
      integer: true,
    }),
    alertCooldownMs: parseNumericEnv('DLQ_ALERT_COOLDOWN_MS', '900000', {
      integer: true,
    }),
  },
  httpClient: {
    timeoutMs: parseNumericEnv('HTTP_CLIENT_TIMEOUT_MS', '10000', {
      integer: true,
    }),
    maxRetries: parseNumericEnv('HTTP_CLIENT_MAX_RETRIES', '3', {
      integer: true,
    }),
    baseDelayMs: parseNumericEnv('HTTP_CLIENT_BASE_DELAY_MS', '200', {
      integer: true,
    }),
    maxDelayMs: parseNumericEnv('HTTP_CLIENT_MAX_DELAY_MS', '10000', {
      integer: true,
    }),
    circuitBreakerThreshold: parseNumericEnv(
      'HTTP_CLIENT_CIRCUIT_BREAKER_THRESHOLD',
      '5',
      { integer: true }
    ),
    circuitBreakerResetMs: parseNumericEnv(
      'HTTP_CLIENT_CIRCUIT_BREAKER_RESET_MS',
      '30000',
      { integer: true }
    ),
  },
  shutdown: {
    drainTimeoutMs: parseNumericEnv('SHUTDOWN_DRAIN_TIMEOUT_MS', '30000', {
      integer: true,
    }),
  },
  /**
   * Authenticated real-time WebSocket stream (#316) — see
   * docs/WEBSOCKET_STREAMING.md for the client contract these bounds imply.
   */
  websocket: {
    /** Mount path of the upgrade endpoint. */
    path: process.env.WS_PATH || '/api/v1/ws',
    /** Ping cadence. A peer that misses two consecutive pongs is closed. */
    heartbeatIntervalMs: parseNumericEnv('WS_HEARTBEAT_INTERVAL_MS', '30000', {
      integer: true,
    }),
    /** How long a socket may stay silent (no pong, no frame) before closing. */
    idleTimeoutMs: parseNumericEnv('WS_IDLE_TIMEOUT_MS', '90000', {
      integer: true,
    }),
    /**
     * Per-connection outbound buffer bound. Past this the connection is marked
     * gapped and events are dropped with a resumable marker rather than queued
     * — a slow consumer must cost its own liveness, never the pod's memory.
     */
    maxBufferedEvents: parseNumericEnv('WS_MAX_BUFFERED_EVENTS', '256', {
      integer: true,
    }),
    /** Socket-level backpressure bound (bytes still unflushed by the kernel). */
    maxBufferedBytes: parseNumericEnv(
      'WS_MAX_BUFFERED_BYTES',
      String(1024 * 1024),
      { integer: true }
    ),
    /** Simultaneous connections one authenticated user may hold on one pod. */
    maxConnectionsPerUser: parseNumericEnv('WS_MAX_CONNECTIONS_PER_USER', '5', {
      integer: true,
    }),
    /** Handshake flood guard, per source IP. A connection flood is a DoS. */
    handshakeRateLimit: {
      windowMs: parseNumericEnv('WS_HANDSHAKE_WINDOW_MS', '60000', {
        integer: true,
        min: 1,
      }),
      max: parseNumericEnv('WS_HANDSHAKE_MAX', '30', { integer: true, min: 1 }),
    },
    /** Client→server message rate. Exceeding it closes the socket. */
    messageRateLimit: {
      windowMs: parseNumericEnv('WS_MESSAGE_WINDOW_MS', '10000', {
        integer: true,
        min: 1,
      }),
      max: parseNumericEnv('WS_MESSAGE_MAX', '50', { integer: true, min: 1 }),
    },
    /** Largest client frame accepted. Client messages are tiny control frames. */
    maxMessageBytes: parseNumericEnv('WS_MAX_MESSAGE_BYTES', '4096', {
      integer: true,
    }),
    /** Events one `resume` may replay before the client must resume again. */
    replayMaxEvents: parseNumericEnv('WS_REPLAY_MAX_EVENTS', '1000', {
      integer: true,
    }),
    /**
     * How often a live connection re-verifies its session against the database,
     * so a logout or a deactivated account kills the socket rather than waiting
     * for it to disconnect on its own.
     */
    sessionRecheckMs: parseNumericEnv('WS_SESSION_RECHECK_MS', '60000', {
      integer: true,
    }),
    /** Coalescing window for clients that opt in at subscribe time. */
    coalesceWindowMs: parseNumericEnv('WS_COALESCE_WINDOW_MS', '250', {
      integer: true,
    }),
    /** How long a draining client should wait before reconnecting. */
    drainRetryAfterMs: parseNumericEnv('WS_DRAIN_RETRY_AFTER_MS', '2000', {
      integer: true,
    }),
  },
  retention: {
    processedEventsDays: parseNumericEnv(
      'RETENTION_PROCESSED_EVENTS_DAYS',
      '90',
      { integer: true }
    ),
    deadLetterEventsDays: parseNumericEnv(
      'RETENTION_DEAD_LETTER_EVENTS_DAYS',
      '30',
      { integer: true }
    ),
    agentLogsDays: parseNumericEnv('RETENTION_AGENT_LOGS_DAYS', '60', {
      integer: true,
    }),
    /**
     * Real-time stream retention (#316). Short by design: this table exists to
     * close a reconnect gap, not to be a second event log — ProcessedEvent and
     * Transaction remain the durable record. A client offline longer than this
     * gets a `gap` frame and re-fetches a REST snapshot.
     */
    userEventsDays: parseNumericEnv('RETENTION_USER_EVENTS_DAYS', '7', {
      integer: true,
    }),
    /**
     * Per-user row cap, enforced alongside the age sweep. Age alone lets one
     * pathological account grow without bound inside the window.
     */
    userEventsMaxPerUser: parseNumericEnv(
      'USER_EVENT_STREAM_MAX_PER_USER',
      '5000',
      { integer: true }
    ),
    /**
     * Admin audit log retention (#682). Preserved during user-level data erasure,
     * but bound to a maximum lifecycle under data-minimization policies.
     * Default: 365 days.
     */
    adminAuditLogsDays: parseNumericEnv(
      'RETENTION_ADMIN_AUDIT_LOGS_DAYS',
      '365',
      { integer: true }
    ),
    /**
     * Legal hold override (#682). When true, all admin audit log retention purges
     * are completely frozen to preserve evidence during regulatory reviews or litigation.
     */
    adminAuditLegalHold: process.env.ADMIN_AUDIT_LEGAL_HOLD === 'true',
    intervalMs: parseNumericEnv('RETENTION_INTERVAL_MS', '86400000', {
      integer: true,
    }),
  },
  protocolRisk: {
    intervalMs: parseNumericEnv('PROTOCOL_RISK_INTERVAL_MS', '21600000', {
      integer: true,
    }),
    // #529 — when true, a ProtocolRiskMetadataEntry past nextReviewDueAt is
    // auto-downgraded to dataConfidence: UNVERIFIED. Default off (flag-only):
    // stale entries are surfaced but not silently altered.
    staleAutoDowngrade:
      process.env.PROTOCOL_RISK_STALE_AUTO_DOWNGRADE === 'true',
    // #621 — points subtracted from a protocol's score while its metadata is
    // past nextReviewDueAt, and how often the staleness check pages.
    stalePenalty: parseNumericEnv('PROTOCOL_RISK_STALE_SCORE_PENALTY', '20', {
      integer: true,
    }),
    stalenessIntervalMs: parseNumericEnv(
      'PROTOCOL_RISK_STALENESS_INTERVAL_MS',
      '3600000',
      { integer: true }
    ),
  },
  portfolioRisk: {
    intervalMs: parseNumericEnv('PORTFOLIO_RISK_INTERVAL_MS', '21600000', {
      integer: true,
    }),
  },
  marketVolatilityCircuitBreaker,
  alertRules: {
    intervalMs: parseNumericEnv('ALERT_RULES_INTERVAL_MS', '60000', {
      integer: true,
    }),
  },
  digests: {
    intervalMs: parseNumericEnv('DIGESTS_INTERVAL_MS', '60000', {
      integer: true,
    }),
  },
  strategyMarketplace: {
    metricsIntervalMs: parseNumericEnv(
      'STRATEGY_METRICS_INTERVAL_MS',
      '21600000',
      { integer: true }
    ),
    riskFreeRate: parseNumericEnv('STRATEGY_RISK_FREE_RATE', '0'),
  },
  attribution: {
    intervalMs: parseNumericEnv('ATTRIBUTION_INTERVAL_MS', '21600000', {
      integer: true,
    }),
    benchmarkProtocols: (process.env.ATTRIBUTION_BENCHMARK_PROTOCOLS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  allocationSuggestions: {
    intervalMs: parseNumericEnv(
      'ALLOCATION_SUGGESTION_INTERVAL_MS',
      '21600000',
      { integer: true }
    ),
    maxConcurrent: parseNumericEnv(
      'ALLOCATION_SUGGESTION_MAX_CONCURRENT',
      '2',
      { integer: true }
    ),
    batchSize: parseNumericEnv('ALLOCATION_SUGGESTION_BATCH_SIZE', '25', {
      integer: true,
    }),
  },
  referral: {
    minActivationDeposit: parseNumericEnv(
      'REFERRAL_MIN_ACTIVATION_DEPOSIT',
      '10',
      { min: 0 }
    ),
    ownerReward: parseNumericEnv('REFERRAL_OWNER_REWARD', '5', { min: 0 }),
    referredReward: parseNumericEnv('REFERRAL_REFERRED_REWARD', '5', {
      min: 0,
    }),
    tier2Enabled:
      (process.env.REFERRAL_TIER2_ENABLED || 'false').toLowerCase() === 'true',
    tier2Reward: parseNumericEnv('REFERRAL_TIER2_REWARD', '1', { min: 0 }),
    rewardAsset: process.env.REFERRAL_REWARD_ASSET || 'USDC',
    rewardContractMethod:
      process.env.REFERRAL_REWARD_CONTRACT_METHOD || 'transfer_reward',
    payoutIntervalMs: parseNumericEnv('REFERRAL_PAYOUT_INTERVAL_MS', '120000', {
      integer: true,
    }),
    // #364 — referral reward vesting & early-withdrawal clawback
    vestingTranches: parseNumericEnv('REFERRAL_VESTING_TRANCHES', '3', {
      integer: true,
    }),
    vestingScheduleDays: (
      process.env.REFERRAL_VESTING_SCHEDULE_DAYS || '0,30,90'
    )
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0),
    vestingGraceHours: parseNumericEnv('REFERRAL_VESTING_GRACE_HOURS', '6', {
      integer: true,
    }),
    vestingConsecutiveSnapshots: parseNumericEnv(
      'REFERRAL_VESTING_CONSECUTIVE_SNAPSHOTS',
      '3',
      { integer: true }
    ),
    clawbackMaxPerReferrer: parseNumericEnv(
      'CLAWBACK_MAX_PER_REFERRER',
      '200',
      { min: 0 }
    ),
    clawbackWriteoffDays: parseNumericEnv('CLAWBACK_WRITEOFF_DAYS', '90', {
      integer: true,
    }),
    // #619 — fraud scoring is config-driven so thresholds can be tuned from
    // the calibration report without a deploy.
    fraud: {
      blockScore: parseNumericEnv('REFERRAL_FRAUD_BLOCK_SCORE', '100', {
        integer: true,
      }),
      reviewScore: parseNumericEnv('REFERRAL_FRAUD_REVIEW_SCORE', '80', {
        integer: true,
      }),
      weights: {
        duplicateWallet: parseNumericEnv(
          'REFERRAL_FRAUD_WEIGHT_DUPLICATE_WALLET',
          '100',
          { integer: true }
        ),
        duplicateEmail: parseNumericEnv(
          'REFERRAL_FRAUD_WEIGHT_DUPLICATE_EMAIL',
          '50',
          { integer: true }
        ),
        duplicatePhone: parseNumericEnv(
          'REFERRAL_FRAUD_WEIGHT_DUPLICATE_PHONE',
          '50',
          { integer: true }
        ),
        sameIp: parseNumericEnv('REFERRAL_FRAUD_WEIGHT_SAME_IP', '40', {
          integer: true,
        }),
        velocity: parseNumericEnv('REFERRAL_FRAUD_WEIGHT_VELOCITY', '30', {
          integer: true,
        }),
        rapidActivation: parseNumericEnv(
          'REFERRAL_FRAUD_WEIGHT_RAPID_ACTIVATION',
          '40',
          { integer: true }
        ),
      },
      velocityCount: parseNumericEnv('REFERRAL_FRAUD_VELOCITY_COUNT', '5', {
        integer: true,
      }),
      rapidActivationCount: parseNumericEnv(
        'REFERRAL_FRAUD_RAPID_ACTIVATION_COUNT',
        '3',
        { integer: true }
      ),
      // Calibration report: minimum share of flagged reviews that ended in a
      // rejection before the suggested review threshold is considered tuned.
      targetPrecision: parseNumericEnv(
        'REFERRAL_FRAUD_TARGET_PRECISION',
        '0.7'
      ),
    },
  },
  recurringDeposits: {
    intervalMs: parseNumericEnv('RECURRING_DEPOSITS_INTERVAL_MS', '300000', {
      integer: true,
    }),
  },
  /**
   * Tool-calling assistant (#318) — replaces the rule-based parser
   * (src/nlp/parser.ts) as the recognition layer for open-ended requests, with
   * the parser retained as fallback. See src/agent/assistant/.
   */
  assistant: {
    /**
     * Off by default. WhatsApp/Telegram only route the 'unknown' bucket
     * (open-ended requests the rule-based parser can't classify) into the
     * assistant when this is true — every recognized command keeps going
     * through the existing parser path unconditionally. REST
     * /api/v1/assistant/chat always uses the assistant regardless of this
     * flag (it has no rule-based fallback to gate).
     */
    enabled:
      (process.env.ASSISTANT_ENABLED || 'false').toLowerCase() === 'true',
    model: process.env.ASSISTANT_MODEL || 'claude-sonnet-4-5',
    maxTokens: parseNumericEnv('ASSISTANT_MAX_TOKENS', '1024', {
      integer: true,
    }),
    maxToolCallsPerTurn: parseNumericEnv(
      'ASSISTANT_MAX_TOOL_CALLS_PER_TURN',
      '5',
      { integer: true }
    ),
    /** Per-user token budget and the window it resets over. */
    perUserTokenBudget: parseNumericEnv(
      'ASSISTANT_PER_USER_TOKEN_BUDGET',
      '20000',
      { integer: true }
    ),
    perUserBudgetWindowMs: parseNumericEnv(
      'ASSISTANT_PER_USER_BUDGET_WINDOW_MS',
      String(60 * 60 * 1000),
      { integer: true }
    ),
    /** Global token budget across all users and the window it resets over. */
    globalTokenBudget: parseNumericEnv(
      'ASSISTANT_GLOBAL_TOKEN_BUDGET',
      '2000000',
      { integer: true }
    ),
    globalBudgetWindowMs: parseNumericEnv(
      'ASSISTANT_GLOBAL_BUDGET_WINDOW_MS',
      String(60 * 60 * 1000),
      { integer: true }
    ),
    /**
     * Fraction of portfolio value above which a withdrawal is treated as
     * sensitive regardless of model confidence (still always confirmed either
     * way — this only affects the wording of the confirmation prompt).
     */
    largeWithdrawalPortfolioFraction: parseNumericEnv(
      'ASSISTANT_LARGE_WITHDRAWAL_FRACTION',
      '0.5'
    ),
  },
  approvals: {
    expirySweepIntervalMs: parseNumericEnv(
      'APPROVAL_EXPIRY_SWEEP_INTERVAL_MS',
      '60000',
      { integer: true }
    ),
  },
  /**
   * Borrow-against-collateral credit line (#532) — the platform's lending book.
   *
   * The controlling relationship is:
   *
   *     maxLtv  <  liquidationLtvThreshold  <  underlyingProtocolLtv
   *
   * `maxLtv` is the hard ceiling at origination. `liquidationLtvThreshold` is
   * the line at which the protective sale fires, and it must sit BELOW the
   * underlying protocol's own liquidation threshold so a forced sale happens
   * while the platform still holds unimpaired collateral. The gap between the
   * two is the platform's own risk buffer — if the underlying market seizes
   * collateral first, the loan is already underwater and the shortfall becomes
   * platform bad debt. That buffer is why `maxLtv` is deliberately well under
   * the threshold rather than just under it.
   *
   * Defaults are the *conservative* end of every range. Raising any of them is
   * a risk decision that has to be re-derived against the underlying protocol's
   * live parameters, not a config tweak; see docs/LENDING.md.
   */
  lending: {
    /** Fraction of collateral value a user may borrow at origination, in (0,1). */
    maxLtv: parseNumericEnv('LENDING_MAX_LTV', '0.5'),
    /** Live LTV at/above which the protective sale fires, in (0,1]. */
    liquidationLtvThreshold: parseNumericEnv('LENDING_LIQUIDATION_LTV', '0.75'),
    /**
     * LTV the partial liquidation restores. Below the threshold with room for
     * the next accrual cycle, so a healthy-but-close loan is corrected once
     * rather than every tick.
     */
    liquidationTargetLtv: parseNumericEnv(
      'LENDING_LIQUIDATION_TARGET_LTV',
      '0.6'
    ),
    /**
     * Hard ceiling on the liquidation threshold, expressed as a fraction of
     * the underlying protocol's own liquidation threshold. Enforced at load:
     * no configuration can talk the platform past the point where the
     * underlying market liquidates before we do.
     */
    maxUnderlyingThresholdFraction: parseNumericEnv(
      'LENDING_MAX_UNDERLYING_THRESHOLD_FRACTION',
      '0.8'
    ),
    /**
     * Fallback when the underlying protocol publishes no borrowApy. Fail-safe
     * in the conservative direction: a higher fallback rate means the borrower
     * is charged more, never that the platform lends more.
     */
    fallbackBorrowApy: parseNumericEnv('LENDING_FALLBACK_BORROW_APY', '8'),
    /** Platform margin added on top of the underlying borrowApy, in percent. */
    platformSpreadApy: parseNumericEnv('LENDING_PLATFORM_SPREAD_APY', '3'),
    /** Smallest collateral value worth lending against, in stablecoin units. */
    minCollateralValue: parseNumericEnv('LENDING_MIN_COLLATERAL_VALUE', '100'),
    /** Smallest principal that may be originated, in stablecoin units. */
    minPrincipal: parseNumericEnv('LENDING_MIN_PRINCIPAL', '10'),
    /** Ceiling on a single loan, in stablecoin units. */
    maxPrincipal: parseNumericEnv('LENDING_MAX_PRINCIPAL', '50000'),
    /**
     * Origination above this principal is routed through the approval-workflow
     * co-signer gate (a BORROW-policy approval request) before any collateral
     * is locked or any stablecoin moves. Independent of the per-user
     * ApprovalPolicy threshold, which is a user-configured control.
     */
    approvalThreshold: parseNumericEnv('LENDING_APPROVAL_THRESHOLD', '10000'),
    /** How often interest is accrued onto outstanding loans. */
    accrualIntervalMs: parseNumericEnv(
      'LENDING_ACCRUAL_INTERVAL_MS',
      '3600000',
      { integer: true }
    ),
    /** How often the scheduled liquidation monitor runs. */
    liquidationCheckIntervalMs: parseNumericEnv(
      'LENDING_LIQUIDATION_CHECK_INTERVAL_MS',
      '3600000',
      { integer: true }
    ),
    /**
     * Ceiling on the share of a position's collateral a single liquidation
     * may sell. Below 1 the sale is necessarily partial; at 1 a sale that
     * cannot restore a safe LTV is free to exhaust the position and record the
     * remainder as bad debt rather than nibbling at it forever.
     */
    maxCollateralFractionSold: parseNumericEnv(
      'LENDING_MAX_COLLATERAL_FRACTION_SOLD',
      '1'
    ),
  },
  protectionFund: {
    /** Fraction of platform revenue skimmed into the fund, in [0,1]. Off by default. */
    revenueSkimFraction: parseNumericEnv(
      'PROTECTION_FUND_REVENUE_SKIM_FRACTION',
      '0'
    ),
    /** Per-user coverage cap in stablecoin units. */
    perUserCoverageCap: parseNumericEnv(
      'PROTECTION_FUND_PER_USER_CAP',
      '10000'
    ),
    /** Minimum hold duration (ms) before a position is eligible for coverage. */
    minHoldDurationMs: parseNumericEnv(
      'PROTECTION_FUND_MIN_HOLD_DURATION_MS',
      String(7 * 24 * 60 * 60 * 1000),
      { integer: true }
    ),
    /** Default asset symbol for the fund. */
    defaultAssetSymbol: process.env.PROTECTION_FUND_DEFAULT_ASSET || 'USDC',
  },
  outbox: {
    dispatchIntervalMs: parseNumericEnv(
      'OUTBOX_DISPATCH_INTERVAL_MS',
      '15000',
      { integer: true }
    ),
    maxAttempts: parseNumericEnv('OUTBOX_MAX_ATTEMPTS', '5', { integer: true }),
    backoffBaseMs: parseNumericEnv('OUTBOX_BACKOFF_BASE_MS', '2000', {
      integer: true,
    }),
    backoffMaxMs: parseNumericEnv('OUTBOX_BACKOFF_MAX_MS', '120000', {
      integer: true,
    }),
    submittedTimeoutMs: parseNumericEnv(
      'OUTBOX_SUBMITTED_TIMEOUT_MS',
      '90000',
      { integer: true }
    ),
    feeBumpMultiplier: parseNumericEnv('OUTBOX_FEE_BUMP_MULTIPLIER', '2'),
    feeBumpMaxAttempts: parseNumericEnv('OUTBOX_FEE_BUMP_MAX_ATTEMPTS', '3', {
      integer: true,
    }),
    globalMaxInFlight: parseNumericEnv('OUTBOX_GLOBAL_MAX_IN_FLIGHT', '10', {
      integer: true,
    }),
    perAccountMaxInFlight: parseNumericEnv(
      'OUTBOX_PER_ACCOUNT_MAX_IN_FLIGHT',
      '1',
      { integer: true }
    ),
    batchSize: parseNumericEnv('OUTBOX_BATCH_SIZE', '20', { integer: true }),
    maxAbsFee: parseNumericEnv('OUTBOX_MAX_ABS_FEE', '100000', {
      integer: true,
    }),
    lowDeferMs: parseNumericEnv('OUTBOX_LOW_DEFER_MS', '15000', {
      integer: true,
    }),
    lowMaxDeferMs: parseNumericEnv('OUTBOX_LOW_MAX_DEFER_MS', '300000', {
      integer: true,
    }),
  },
  /**
   * Agent circuit breaker (#345) — pre-trade guards that halt agent-initiated
   * rebalancing at GLOBAL / PROTOCOL / USER scope on abnormal loss, de-peg,
   * oscillation or stale data. Each rule is independently toggleable and is
   * evaluated by pure functions in src/agent/breakerRules.ts. The de-peg rule
   * is disabled by default: it needs a live stablecoin price feed, and the
   * platform currently has none wired (the fee oracle exposes fees, not
   * prices), so enabling it without a real feed would never trip — leave off
   * until an oracle path exists.
   */
  breaker: {
    /** Master switch for the whole circuit breaker. */
    enabled: (process.env.BREAKER_ENABLED ?? 'true').toLowerCase() === 'true',
    abnormalLoss: {
      enabled:
        (process.env.BREAKER_ABNORMAL_LOSS_ENABLED ?? 'true').toLowerCase() ===
        'true',
      /** Portfolio down more than this percentage over the window trips. */
      lossPct: parseNumericEnv('BREAKER_LOSS_PCT', '5'),
      /** Trailing window (hours) over which drawdown is measured. */
      windowHours: parseNumericEnv('BREAKER_LOSS_WINDOW_HOURS', '24', {
        integer: true,
      }),
    },
    depeg: {
      enabled:
        (process.env.BREAKER_DEPEG_ENABLED ?? 'false').toLowerCase() === 'true',
      /** Stablecoin price deviation from $1 (basis points) that trips. */
      depegBps: parseNumericEnv('BREAKER_DEPEG_BPS', '150', { integer: true }),
      /**
       * Consecutive clean evaluations required before an OPEN de-peg breaker
       * may transition to HALF_OPEN — a single recovered tick is not enough.
       */
      sustainedClearChecks: parseNumericEnv(
        'BREAKER_DEPEG_SUSTAINED_CHECKS',
        '3',
        { integer: true }
      ),
      /** Where the integration layer looks for the stablecoin spot price. */
      priceSource: process.env.BREAKER_DEPEG_PRICE_SOURCE || 'fee-oracle',
    },
    oscillation: {
      enabled:
        (process.env.BREAKER_OSCILLATION_ENABLED ?? 'true').toLowerCase() ===
        'true',
      /** Rebalances of the same batch within the window that trip. */
      maxFlips: parseNumericEnv('BREAKER_MAX_FLIPS', '3', { integer: true }),
      /** Sliding window (hours) for the flip count. */
      windowHours: parseNumericEnv('BREAKER_FLIP_WINDOW_HOURS', '24', {
        integer: true,
      }),
    },
    staleData: {
      enabled:
        (process.env.BREAKER_STALE_DATA_ENABLED ?? 'true').toLowerCase() ===
        'true',
      /** APY table older than this (minutes) must not be traded on. */
      staleMinutes: parseNumericEnv('BREAKER_STALE_MINUTES', '120', {
        integer: true,
      }),
      /** Consecutive scan failures before stale-data trips. */
      consecutiveFailures: parseNumericEnv(
        'BREAKER_STALE_CONSECUTIVE_FAILURES',
        '3',
        { integer: true }
      ),
    },
    /** Base cooldown before an OPEN breaker may auto-transition to HALF_OPEN. */
    cooldownMs: parseNumericEnv('BREAKER_COOLDOWN_MS', '3600000', {
      integer: true,
    }),
    /** Hard cap on cooldown after repeated re-tripping (backoff doubling). */
    maxCooldownMs: parseNumericEnv('BREAKER_MAX_COOLDOWN_MS', '86400000', {
      integer: true,
    }),
  },
  feeOracle: {
    pollMs: parseNumericEnv('FEE_ORACLE_POLL_MS', '10000', { integer: true }),
    ttlMs: parseNumericEnv('FEE_ORACLE_TTL_MS', '30000', { integer: true }),
    min: parseNumericEnv('FEE_ORACLE_MIN', '100', { integer: true }),
    max: parseNumericEnv('FEE_ORACLE_MAX', '50000', { integer: true }),
    defaultBaseFee: parseNumericEnv('FEE_ORACLE_DEFAULT_BASE_FEE', '100', {
      integer: true,
    }),
  },
  sponsor: {
    minXlmFloor: parseNumericEnv('SPONSOR_MIN_XLM_FLOOR', '10'),
  },
  reserveReconciliation: {
    intervalMs: parseNumericEnv(
      'RESERVE_RECONCILIATION_INTERVAL_MS',
      '3600000',
      { integer: true }
    ),
  },
  apiKeys: {
    maxActivePerUser: parseNumericEnv('USER_API_KEY_MAX_ACTIVE', '10', {
      integer: true,
    }),
    withdrawalsEnabled:
      (process.env.USER_API_KEY_WITHDRAWALS_ENABLED ?? 'true') === 'true',
  },
  sessions: {
    revokedRetainDays: parseNumericEnv('REVOKED_SESSION_RETAIN_DAYS', '7', {
      integer: true,
    }),
  },
  nlp: {
    /**
     * Minimum confidence (0-1) a parsed Intent must carry to be acted on
     * directly (#401). Below this, the rule-based parser returns a
     * 'clarification' intent instead of guessing at the nearest pattern or
     * falling straight through to 'unknown'.
     */
    confidenceThreshold: parseNumericEnv('NLP_CONFIDENCE_THRESHOLD', '0.6'),
  },
  /**
   * Fiat on/off-ramp tuning (#290, #313). Centralised here so a typo fails at
   * startup instead of producing NaN inside provider selection (#789).
   */
  fiat: {
    /** How long a PENDING/PROCESSING order may sit before the age-out job fails it. */
    staleOrderMaxAgeMs: parseNumericEnv(
      'FIAT_STALE_ORDER_MAX_AGE_MS',
      String(24 * 60 * 60 * 1000),
      { integer: true, min: 1 }
    ),
    /** How long a quote returned by getBestExecutionQuote stays honorable (#313). */
    quoteLockTtlMs: parseNumericEnv('FIAT_QUOTE_LOCK_TTL_MS', '60000', {
      integer: true,
      min: 1,
    }),
    /** Per-provider timeout for a single quote request in the parallel fan-out. */
    quoteProviderTimeoutMs: parseNumericEnv(
      'FIAT_QUOTE_PROVIDER_TIMEOUT_MS',
      '8000',
      { integer: true, min: 1 }
    ),
    /** Beyond this |settled - quoted| / quoted, emit a rate-drift alert + webhook. */
    rateDriftTolerancePct: parseNumericEnv(
      'FIAT_RATE_DRIFT_TOLERANCE_PCT',
      '0.02',
      { min: 0 }
    ),
    /** Beyond this drift, escalate to critical. */
    rateDriftCriticalPct: parseNumericEnv(
      'FIAT_RATE_DRIFT_CRITICAL_PCT',
      '0.1',
      { min: 0 }
    ),
    /** Consecutive provider failures before its circuit opens. */
    circuitBreakerThreshold: parseNumericEnv(
      'FIAT_PROVIDER_CIRCUIT_BREAKER_THRESHOLD',
      '5',
      { integer: true, min: 1 }
    ),
    /** Reset window before a tripped provider is retried. */
    circuitBreakerResetMs: parseNumericEnv(
      'FIAT_PROVIDER_CIRCUIT_BREAKER_RESET_MS',
      '30000',
      { integer: true, min: 1 }
    ),
  },
  telemetry: {
    /** Sentry performance-tracing sample rate, in [0,1]. */
    sentryTracesSampleRate: parseNumericEnv(
      'SENTRY_TRACES_SAMPLE_RATE',
      '0.1',
      { min: 0, max: 1 }
    ),
  },
}
