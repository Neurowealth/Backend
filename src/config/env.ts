import dotenv from 'dotenv'
dotenv.config()

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required environment variable: ${key}`)
  return value
}

/**
 * CRITICAL: Validate Stellar network to prevent testnet/mainnet mix-ups
 * Protects against accidental mainnet transactions with testnet keys
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
 * CRITICAL: Validate Stellar secret key format and warn on mainnet in dev
 */
function validateStellarKey(secretKey: string, network: 'testnet' | 'mainnet' | 'futurenet'): void {
  // Stellar secret keys always start with 'S'
  if (!secretKey.startsWith('S')) {
    throw new Error('STELLAR_AGENT_SECRET_KEY must start with S (invalid Stellar secret key format)')
  }

  // Stellar keys are exactly 56 characters
  if (secretKey.length !== 56) {
    throw new Error(
      `STELLAR_AGENT_SECRET_KEY invalid length: ${secretKey.length}. Stellar keys must be 56 characters.`
    )
  }

  // Log network configuration
  const env = process.env.NODE_ENV || 'development'
  const networkDisplay = network.toUpperCase()
  console.log(`✓ Stellar Agent configured for ${networkDisplay} (NODE_ENV=${env})`)

  // CRITICAL: Warn if mainnet in development
  if (network === 'mainnet' && env !== 'production') {
    console.warn('')
    console.warn('⚠️  CRITICAL WARNING: Using MAINNET in non-production environment!')
    console.warn('⚠️  This could result in real financial loss!')
    console.warn('⚠️  Verify STELLAR_NETWORK and NODE_ENV settings immediately!')
    console.warn('')
  }
}

const stellarNetwork = validateStellarNetwork(requireEnv('STELLAR_NETWORK'))
const agentSecretKey = requireEnv('STELLAR_AGENT_SECRET_KEY')
validateStellarKey(agentSecretKey, stellarNetwork)

export const config = {
  port: parseInt(process.env.PORT || '3001'),
  nodeEnv: process.env.NODE_ENV || 'development',
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
    nonce_ttl_ms: parseInt(requireEnv('JWT_NONCE_TTL_MS') || '300000'), // default to 5 minutes if not set
    interval_ms: parseInt(requireEnv('JWT_CLEANUP_INTERVAL_MS') || '86400000') // default to 24 hours if not set
  },
  whatsapp: {
    twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.WHATSAPP_FROM || '',
  },
  security: {
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // Default 15 minutes
      max: parseInt(process.env.RATE_LIMIT_MAX || '100'), // Default 100 requests per window
    },
    authRateLimit: {
      windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '900000'), // Default 15 minutes
      max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '20'), // Stricter limit for auth: 20 requests per window
    },
  },
}