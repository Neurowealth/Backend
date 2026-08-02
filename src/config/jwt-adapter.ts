import jwt from 'jsonwebtoken'
import { randomBytes } from 'crypto'
import { config } from './env'

const JWT_SEED = config.jwt.seed

/**
 * Access-token lifetime in minutes (default 15). Kept short so a leaked access
 * token has a small blast radius; clients refresh with the long-lived opaque
 * refresh token (see #214 rotation flow in auth-controller).
 */
const ACCESS_TOKEN_TTL_MIN = parseInt(
  process.env.JWT_ACCESS_TTL_MIN || '15',
  10
)

/** Refresh-token lifetime in days (default 7). */
const REFRESH_TOKEN_TTL_DAYS = parseInt(
  process.env.JWT_REFRESH_TTL_DAYS || '7',
  10
)

export class JwtAdapter {
  static async generateToken(
    payload: Object,
    durationInHours: number = 2
  ): Promise<string | null> {
    return new Promise((resolve) => {
      jwt.sign(
        payload,
        JWT_SEED,
        {
          expiresIn: `${durationInHours}h`,
        },
        (error, token) => {
          if (error) return resolve(null)

          return resolve(token!)
        }
      )
    })
  }

  static validateToken<T>(token: string): Promise<T | null> {
    return new Promise((resolve) => {
      jwt.verify(token, JWT_SEED, (error, decoded) => {
        if (error) return resolve(null)

        resolve(decoded as T)
      })
    })
  }

  // ── #214 refresh-token rotation API ────────────────────────────────────────

  /**
   * Issue a short-lived signed JWT access token. Resolves to null on signing
   * error (callers treat null as a 500). TTL is ACCESS_TOKEN_TTL_MIN minutes.
   */
  static async generateAccessToken(payload: Object): Promise<string | null> {
    return new Promise((resolve) => {
      jwt.sign(
        payload,
        JWT_SEED,
        { expiresIn: `${ACCESS_TOKEN_TTL_MIN}m` },
        (error, token) => {
          if (error) return resolve(null)
          return resolve(token!)
        }
      )
    })
  }

  /**
   * Generate an opaque (non-JWT) refresh token. 48 random bytes, base64url.
   * Stored only as a bcrypt hash on the Session row — never persisted in plaintext.
   */
  static generateRefreshToken(): string {
    return randomBytes(48).toString('base64url')
  }

  /** Absolute expiry timestamp for a newly-issued access token. */
  static accessTokenExpiresAt(): Date {
    return new Date(Date.now() + ACCESS_TOKEN_TTL_MIN * 60 * 1000)
  }

  /** Absolute expiry timestamp for a newly-issued refresh token. */
  static refreshTokenExpiresAt(): Date {
    return new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
  }
}
