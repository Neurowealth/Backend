export {};

declare module 'express-serve-static-core' {
  interface Request {
    /** Authenticated user ID (UUID) */
    userId?: string;
    /** Authenticated user's Stellar public key */
    stellarPubKey?: string;
  }
}
