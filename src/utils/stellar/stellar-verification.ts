import { config } from '../../config/env'
import { Keypair } from '@stellar/stellar-sdk'

export interface NonceEntry {
  nonce: string
  expiresAt: number // ms since epoch
  stellarPubKey: string
}

/**
 * In-memory nonce store. Exported as _nonceStoreForTests so integration tests
 * can inspect and pre-populate nonces without hitting the database.
 */
export const _nonceStoreForTests = new Map<string, NonceEntry>()

export default class StellarVerification {
  /**
   * Verify a Stellar signature.
   * Freighter signs the raw UTF-8 bytes of the message.
   * Stellar's Keypair.verify() expects a Buffer and a base64-encoded signature.
   */
  verifyStellarSignature(
    publicKey: string,
    message: string,
    signatureBase64: string
  ): boolean {
    try {
      const keypair = Keypair.fromPublicKey(publicKey)
      const messageBytes = Buffer.from(message, 'utf8')
      const signatureBytes = Buffer.from(signatureBase64, 'base64')
      return keypair.verify(messageBytes, signatureBytes)
    } catch {
      return false
    }
  }

  /** Remove all expired nonces (lazy cleanup called from challenge). */
  purgeExpiredNonces(): void {
    const now = Date.now()
    for (const [key, entry] of _nonceStoreForTests.entries()) {
      if (entry.expiresAt <= now) {
        _nonceStoreForTests.delete(key)
      }
    }
  }

  /** Map STELLAR_NETWORK env value to Prisma Network enum */
  resolveNetwork(): 'MAINNET' | 'TESTNET' | 'FUTURENET' {
    switch (config.stellar.network.toLowerCase()) {
      case 'mainnet':
        return 'MAINNET'
      case 'futurenet':
        return 'FUTURENET'
      case 'testnet':
      default:
        return 'TESTNET'
    }
  }
}

/** Shared singleton — imported by auth-controller */
export const stellarVerification = new StellarVerification()
