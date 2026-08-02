/**
 * Unit tests for Stellar network configuration
 * Tests network derivation, RPC URL resolution, and keypair validation
 */

import { resolveNetworkPassphrase } from '../../../src/stellar/client'
import { STELLAR_EXPLORER_URLS } from '../../../src/config/env'

describe('Stellar Network Configuration', () => {
  describe('resolveNetworkPassphrase', () => {
    it('should resolve testnet passphrase', () => {
      const passphrase = resolveNetworkPassphrase('testnet')
      expect(passphrase).toBe('Test SDF Network ; September 2015')
    })

    it('should resolve mainnet passphrase', () => {
      const passphrase = resolveNetworkPassphrase('mainnet')
      expect(passphrase).toBe('Public Global Stellar Network ; September 2015')
    })

    it('should resolve futurenet passphrase', () => {
      const passphrase = resolveNetworkPassphrase('futurenet')
      expect(passphrase).toBe('Test SDF Future Network ; October 2022')
    })

    it('should handle case-insensitive network names', () => {
      expect(resolveNetworkPassphrase('TESTNET')).toBe(
        'Test SDF Network ; September 2015'
      )
      expect(resolveNetworkPassphrase('Mainnet')).toBe(
        'Public Global Stellar Network ; September 2015'
      )
    })

    it('should throw for unknown network', () => {
      expect(() => resolveNetworkPassphrase('unknown')).toThrow(
        'Unknown STELLAR_NETWORK'
      )
      expect(() => resolveNetworkPassphrase('devnet')).toThrow(
        'Unknown STELLAR_NETWORK'
      )
      expect(() => resolveNetworkPassphrase(undefined)).toThrow(
        'Unknown STELLAR_NETWORK'
      )
    })
  })

  describe('STELLAR_EXPLORER_URLS', () => {
    it('should have explorer URLs for all supported networks', () => {
      expect(STELLAR_EXPLORER_URLS.testnet).toBeDefined()
      expect(STELLAR_EXPLORER_URLS.mainnet).toBeDefined()
      expect(STELLAR_EXPLORER_URLS.futurenet).toBeDefined()
    })

    it('should have valid HTTPS URLs', () => {
      Object.values(STELLAR_EXPLORER_URLS).forEach((url) => {
        expect(url).toMatch(/^https:\/\/stellar\.expert/)
      })
    })
  })

  describe('Network configuration derivation', () => {
    const originalEnv = process.env

    beforeEach(() => {
      jest.resetModules()
      process.env = { ...originalEnv }
    })

    afterAll(() => {
      process.env = originalEnv
    })

    it('should derive testnet RPC URL when not explicitly set', () => {
      process.env.STELLAR_NETWORK = 'testnet'
      // CI's job env sets STELLAR_RPC_URL — clear it so derivation is exercised
      delete process.env.STELLAR_RPC_URL
      process.env.STELLAR_AGENT_SECRET_KEY = 'S' + 'A'.repeat(55)
      process.env.VAULT_CONTRACT_ID = 'C' + 'B'.repeat(55)
      process.env.USDC_TOKEN_ADDRESS = 'C' + 'C'.repeat(55)
      process.env.ANTHROPIC_API_KEY = 'sk-ant-12345678901234567890'
      process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
      process.env.JWT_SEED = 'a'.repeat(32)
      process.env.WALLET_ENCRYPTION_KEY = 'a'.repeat(64)
      process.env.TWILIO_AUTH_TOKEN = 'b'.repeat(32)
      process.env.NODE_ENV = 'development'

      const { config } = require('../../../src/config/env')
      expect(config.stellar.rpcUrl).toBe('https://soroban-testnet.stellar.org')
    })

    it('should use explicit RPC URL when set', () => {
      process.env.STELLAR_NETWORK = 'testnet'
      process.env.STELLAR_RPC_URL = 'https://custom-rpc.example.com'
      process.env.STELLAR_AGENT_SECRET_KEY = 'S' + 'A'.repeat(55)
      process.env.VAULT_CONTRACT_ID = 'C' + 'B'.repeat(55)
      process.env.USDC_TOKEN_ADDRESS = 'C' + 'C'.repeat(55)
      process.env.ANTHROPIC_API_KEY = 'sk-ant-12345678901234567890'
      process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
      process.env.JWT_SEED = 'a'.repeat(32)
      process.env.WALLET_ENCRYPTION_KEY = 'a'.repeat(64)
      process.env.TWILIO_AUTH_TOKEN = 'b'.repeat(32)
      process.env.NODE_ENV = 'development'

      const { config } = require('../../../src/config/env')
      expect(config.stellar.rpcUrl).toBe('https://custom-rpc.example.com')
    })

    it('should throw for invalid network', () => {
      process.env.STELLAR_NETWORK = 'invalid'
      process.env.STELLAR_AGENT_SECRET_KEY = 'S' + 'A'.repeat(55)

      expect(() => require('../../../src/config/env')).toThrow(
        'Invalid STELLAR_NETWORK'
      )
    })
  })
})
