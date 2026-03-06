import dotenv from 'dotenv'

// Load test environment variables
dotenv.config({ path: '.env.test' })

// Set default values for required env vars if not set
process.env.STELLAR_NETWORK = process.env.STELLAR_NETWORK || 'testnet'
process.env.STELLAR_RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org'
process.env.AGENT_SECRET_KEY = process.env.AGENT_SECRET_KEY || 'SCUW2M4J5ZUOZQTXSHK4CKTGCPBDWEYEQSRSJZGSW7VHU6GLPKOC3OJY'
process.env.VAULT_CONTRACT_ID = process.env.VAULT_CONTRACT_ID || 'test_contract_id'
process.env.USDC_TOKEN_ADDRESS = process.env.USDC_TOKEN_ADDRESS || 'test_usdc_address'
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test_anthropic_key'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test_db'
process.env.JWT_SEED = process.env.JWT_SEED || 'test_jwt_seed'
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test_encryption_key'