import dotenv from 'dotenv'
dotenv.config()

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required environment variable: ${key}`)
  return value
}

export const config = {
  port: parseInt(process.env.PORT || '3001'),
  nodeEnv: process.env.NODE_ENV || 'development',
  stellar: {
    network: requireEnv('STELLAR_NETWORK'),
    rpcUrl: requireEnv('STELLAR_RPC_URL'),
    agentSecretKey: requireEnv('AGENT_SECRET_KEY'),
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
}