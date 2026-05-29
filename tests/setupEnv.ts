process.env.NODE_ENV = 'test'
process.env.STELLAR_NETWORK = 'TESTNET'
process.env.STELLAR_RPC_URL = 'https://rpc.example.com'
process.env.STELLAR_AGENT_SECRET_KEY = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
process.env.VAULT_CONTRACT_ID = 'CDUMMYVAULTCONTRACTID'
process.env.USDC_TOKEN_ADDRESS = 'CDUMMYUSDC'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
process.env.JWT_SEED = 'test-jwt-seed'
process.env.JWT_SESSION_TTL_HOURS = '24'
process.env.JWT_NONCE_TTL_MS = '300000'
process.env.JWT_CLEANUP_INTERVAL_MS = '86400000'
process.env.WALLET_ENCRYPTION_KEY =
  process.env.WALLET_ENCRYPTION_KEY ??
  'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'

// Generous limits so integration tests are not blocked by rate limiters (#101)
process.env.RATE_LIMIT_MAX = '100000'
process.env.AUTH_RATE_LIMIT_MAX = '100000'
process.env.ADMIN_RATE_LIMIT_MAX = '100000'
process.env.INTERNAL_RATE_LIMIT_MAX = '100000'
