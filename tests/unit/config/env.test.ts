/**
 * Unit tests — Environment configuration validation
 * 
 * Tests run in isolated child processes to prevent env pollution between tests.
 */

import { spawn } from 'child_process'
import path from 'path'

// Valid test values
const VALID_WALLET_KEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' // 64 hex chars
const VALID_SECRET_KEY = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' // 56 chars starting with S

/** Base valid environment for all tests */
const BASE_ENV = {
  STELLAR_NETWORK: 'testnet',
  STELLAR_RPC_URL: 'https://rpc.example.com',
  STELLAR_AGENT_SECRET_KEY: VALID_SECRET_KEY,
  VAULT_CONTRACT_ID: 'CVAULT',
  USDC_TOKEN_ADDRESS: 'CUSDC',
  ANTHROPIC_API_KEY: 'key',
  DATABASE_URL: 'postgresql://localhost/db',
  JWT_SEED: 'seed',
  WALLET_ENCRYPTION_KEY: VALID_WALLET_KEY,
  TWILIO_AUTH_TOKEN: 'test-twilio-auth-token',
  NODE_ENV: 'test',
}

/**
 * Run env.ts in a child process with custom environment.
 * Returns { success: boolean, stderr: string }
 */
function testEnvInProcess(env: Record<string, string>): Promise<{ success: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'node',
      ['-e', `require('${path.resolve(__dirname, '../../../src/config/env')}')`],
      {
        env: { ...env, PATH: process.env.PATH },
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    )

    let stderr = ''
    child.stderr?.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      resolve({ success: code === 0, stderr })
    })
  })
}

describe('Environment Configuration', () => {
  describe('Required environment variables validation', () => {
    it('throws error when STELLAR_NETWORK is missing', async () => {
      const env = { ...BASE_ENV }
      delete env.STELLAR_NETWORK

      const result = await testEnvInProcess(env)
      expect(result.success).toBe(false)
      expect(result.stderr).toContain('Missing required environment variable: STELLAR_NETWORK')
    })

    it('throws error when STELLAR_AGENT_SECRET_KEY is missing', async () => {
      const env = { ...BASE_ENV }
      delete env.STELLAR_AGENT_SECRET_KEY

      const result = await testEnvInProcess(env)
      expect(result.success).toBe(false)
      expect(result.stderr).toContain('Missing required environment variable: STELLAR_AGENT_SECRET_KEY')
    })

    it('throws error when VAULT_CONTRACT_ID is missing', async () => {
      const env = { ...BASE_ENV }
      delete env.VAULT_CONTRACT_ID

      const result = await testEnvInProcess(env)
      expect(result.success).toBe(false)
      expect(result.stderr).toContain('Missing required environment variable: VAULT_CONTRACT_ID')
    })

    it('throws error when DATABASE_URL is missing', async () => {
      const env = { ...BASE_ENV }
      delete env.DATABASE_URL

      const result = await testEnvInProcess(env)
      expect(result.success).toBe(false)
      expect(result.stderr).toContain('Missing required environment variable: DATABASE_URL')
    })

    it('throws error when WALLET_ENCRYPTION_KEY is missing', async () => {
      const env = { ...BASE_ENV }
      delete env.WALLET_ENCRYPTION_KEY

      const result = await testEnvInProcess(env)
      expect(result.success).toBe(false)
      expect(result.stderr).toContain('Missing required environment variable: WALLET_ENCRYPTION_KEY')
    })

    it('throws error when WALLET_ENCRYPTION_KEY is not 64 hex chars', async () => {
      const env = { ...BASE_ENV, WALLET_ENCRYPTION_KEY: 'tooshort' }

      const result = await testEnvInProcess(env)
      expect(result.success).toBe(false)
      expect(result.stderr).toContain('WALLET_ENCRYPTION_KEY is invalid')
    })

    it('throws error when TWILIO_AUTH_TOKEN is missing', async () => {
      const env = { ...BASE_ENV }
      delete env.TWILIO_AUTH_TOKEN

      const result = await testEnvInProcess(env)
      expect(result.success).toBe(false)
      expect(result.stderr).toContain('Missing required environment variable: TWILIO_AUTH_TOKEN')
    })
  })

  describe('Stellar network validation', () => {
    it('accepts valid network: testnet', async () => {
      const result = await testEnvInProcess(BASE_ENV)
      expect(result.success).toBe(true)
    })

    it('accepts valid network: mainnet', async () => {
      const env = { ...BASE_ENV, STELLAR_NETWORK: 'mainnet', NODE_ENV: 'production' }

      const result = await testEnvInProcess(env)
      expect(result.success).toBe(true)
    })

    it('accepts valid network: futurenet', async () => {
      const env = { ...BASE_ENV, STELLAR_NETWORK: 'futurenet' }

      const result = await testEnvInProcess(env)
      expect(result.success).toBe(true)
    })

    it('rejects invalid network', async () => {
      const env = { ...BASE_ENV, STELLAR_NETWORK: 'invalidnet' }

      const result = await testEnvInProcess(env)
      expect(result.success).toBe(false)
      expect(result.stderr).toContain('Invalid STELLAR_NETWORK')
    })

    it('is case-insensitive', async () => {
      const env = { ...BASE_ENV, STELLAR_NETWORK: 'TESTNET' }

      const result = await testEnvInProcess(env)
      expect(result.success).toBe(true)
    })
  })

  describe('Stellar secret key validation', () => {
    it('rejects key not starting with S', async () => {
      const env = { ...BASE_ENV, STELLAR_AGENT_SECRET_KEY: 'AXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' }

      const result = await testEnvInProcess(env)
      expect(result.success).toBe(false)
      expect(result.stderr).toContain('must start with S')
    })

    it('rejects key with incorrect length', async () => {
      const env = { ...BASE_ENV, STELLAR_AGENT_SECRET_KEY: 'SSHORT' }

      const result = await testEnvInProcess(env)
      expect(result.success).toBe(false)
      expect(result.stderr).toContain('invalid length')
    })

    it('accepts valid 56-character key starting with S', async () => {
      const result = await testEnvInProcess(BASE_ENV)
      expect(result.success).toBe(true)
    })
  })

  describe('Mainnet warning', () => {
    it('warns when mainnet is used in development', async () => {
      const env = { ...BASE_ENV, STELLAR_NETWORK: 'mainnet', NODE_ENV: 'development' }

      const result = await testEnvInProcess(env)
      expect(result.success).toBe(true)
      expect(result.stderr).toContain('CRITICAL WARNING')
      expect(result.stderr).toContain('MAINNET')
    })

    it('does not warn when mainnet is used in production', async () => {
      const env = { ...BASE_ENV, STELLAR_NETWORK: 'mainnet', NODE_ENV: 'production' }

      const result = await testEnvInProcess(env)
      expect(result.success).toBe(true)
      expect(result.stderr).not.toContain('CRITICAL WARNING')
    })
  })
})