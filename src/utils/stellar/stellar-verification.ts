import { Network } from '@prisma/client';
import { config } from '../../config/env';
import { Keypair } from '@stellar/stellar-sdk';

interface StoredNonce {
    nonce: string;
    expiresAt: number;
    stellarPubKey: string;
}


export default class StellarVerification {
    /** Verify a Stellar signature.
     * Freighter signs the raw UTF-8 bytes of the message.
     * Stellar's Keypair.verify() expects a Buffer and a base64-encoded signature.
     */
    constructor(
        /** In-memory nonce store — keyed by stellarPubKey */
        private readonly nonceStore: Map<string, StoredNonce>,
    ) { }

    /** Remove expired nonces (called lazily on every challenge request) */
    purgeExpiredNonces(): void {
        const now = Date.now();
        for (const [key, entry] of this.nonceStore.entries()) {
            if (entry.expiresAt <= now) this.nonceStore.delete(key);
        }
    }

    /**
     * Verify a Stellar signature.
     *
     * Freighter signs the raw UTF-8 bytes of the message.
     * Stellar's Keypair.verify() expects a Buffer and a base64-encoded signature.
     */
    verifyStellarSignature(
        publicKey: string,
        message: string,
        signatureBase64: string,
    ): boolean {
        try {
            const keypair = Keypair.fromPublicKey(publicKey);
            const messageBytes = Buffer.from(message, 'utf8');
            const signatureBytes = Buffer.from(signatureBase64, 'base64');
            return keypair.verify(messageBytes, signatureBytes);
        } catch {
            return false;
        }
    }

    /** Map STELLAR_NETWORK env value to Prisma Network enum */
    resolveNetwork(): Network {
        return config.stellar.network.toLowerCase() === 'mainnet'
            ? Network.MAINNET
            : Network.TESTNET;
    }

}


// Module-level singleton

const nonceStore = new Map<string, StoredNonce>();

/** Shared singleton — imported by auth-controller and tests */
export const stellarVerification = new StellarVerification(nonceStore);

// Export the raw store for testing purposes only
export { nonceStore as _nonceStoreForTests };