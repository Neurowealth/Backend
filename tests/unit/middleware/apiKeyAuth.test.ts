import { validateUserScopes, USER_SCOPES, type UserScope } from '../../../src/auth/scopes'
import {
  parseUserApiKeyToken,
  isUserApiKeyToken,
  requireScope,
} from '../../../src/middleware/apiKeyAuth'
import { Request, Response, NextFunction } from 'express'

describe('User API Key auth (#374)', () => {
  describe('parseUserApiKeyToken', () => {
    it('parses valid nwk tokens', () => {
      const result = parseUserApiKeyToken('nwk_abc-123_deadbeef')
      expect(result).toEqual({ keyId: 'abc-123', secret: 'deadbeef' })
    })

    it('returns null for non-nwk tokens', () => {
      expect(parseUserApiKeyToken('Bearer jwt')).toBeNull()
      expect(isUserApiKeyToken('jwt')).toBe(false)
    })
  })

  describe('validateUserScopes', () => {
    it('accepts valid scope arrays', () => {
      expect(validateUserScopes(['portfolio:read'])).toBe(true)
    })

    it('rejects unknown scopes', () => {
      expect(validateUserScopes(['admin:super'])).toBe(false)
      expect(validateUserScopes([])).toBe(false)
    })

    it('exports a non-empty scope catalog', () => {
      expect(USER_SCOPES.length).toBeGreaterThan(0)
    })
  })

  describe('requireScope', () => {
    let req: Partial<Request>
    let res: Partial<Response>
    let next: NextFunction

    beforeEach(() => {
      req = {}
      res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      }
      next = jest.fn()
    })

    it('allows session users with wildcard scopes', () => {
      req.authScopes = ['*']
      requireScope('deposit:write')(req as Request, res as Response, next)
      expect(next).toHaveBeenCalled()
    })

    it('allows API keys with matching scope', () => {
      req.authScopes = ['deposit:write', 'portfolio:read']
      requireScope('deposit:write')(req as Request, res as Response, next)
      expect(next).toHaveBeenCalled()
    })

    it('denies API keys without required scope', () => {
      req.authScopes = ['portfolio:read']
      req.apiKeyId = 'key-1'
      requireScope('deposit:write')(req as Request, res as Response, next)
      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'insufficient_scope' })
      )
    })

    describe('deposit:write', () => {
      it('allows API keys with deposit:write scope', () => {
        req.authScopes = ['deposit:write'] as UserScope[]
        requireScope('deposit:write')(req as Request, res as Response, next)
        expect(next).toHaveBeenCalled()
      })

      it('denies API keys without deposit:write scope', () => {
        req.authScopes = ['portfolio:read', 'transactions:read'] as UserScope[]
        requireScope('deposit:write')(req as Request, res as Response, next)
        expect(res.status).toHaveBeenCalledWith(403)
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ error: 'insufficient_scope' })
        )
      })
    })

    describe('goals:write', () => {
      it('allows API keys with goals:write scope', () => {
        req.authScopes = ['goals:write'] as UserScope[]
        requireScope('goals:write')(req as Request, res as Response, next)
        expect(next).toHaveBeenCalled()
      })

      it('denies API keys without goals:write scope', () => {
        req.authScopes = ['portfolio:read'] as UserScope[]
        requireScope('goals:write')(req as Request, res as Response, next)
        expect(res.status).toHaveBeenCalledWith(403)
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ error: 'insufficient_scope' })
        )
      })
    })

    describe('recurring_deposits:write', () => {
      it('allows API keys with recurring_deposits:write scope', () => {
        req.authScopes = ['recurring_deposits:write'] as UserScope[]
        requireScope('recurring_deposits:write')(req as Request, res as Response, next)
        expect(next).toHaveBeenCalled()
      })

      it('denies API keys without recurring_deposits:write scope', () => {
        req.authScopes = ['portfolio:read'] as UserScope[]
        requireScope('recurring_deposits:write')(req as Request, res as Response, next)
        expect(res.status).toHaveBeenCalledWith(403)
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ error: 'insufficient_scope' })
        )
      })
    })

    describe('strategies:write', () => {
      it('allows API keys with strategies:write scope', () => {
        req.authScopes = ['strategies:write'] as UserScope[]
        requireScope('strategies:write')(req as Request, res as Response, next)
        expect(next).toHaveBeenCalled()
      })

      it('denies API keys without strategies:write scope', () => {
        req.authScopes = ['portfolio:read'] as UserScope[]
        requireScope('strategies:write')(req as Request, res as Response, next)
        expect(res.status).toHaveBeenCalledWith(403)
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ error: 'insufficient_scope' })
        )
      })
    })

    describe('webhooks:manage', () => {
      it('allows API keys with webhooks:manage scope', () => {
        req.authScopes = ['webhooks:manage'] as UserScope[]
        requireScope('webhooks:manage')(req as Request, res as Response, next)
        expect(next).toHaveBeenCalled()
      })

      it('denies API keys without webhooks:manage scope', () => {
        req.authScopes = ['portfolio:read'] as UserScope[]
        requireScope('webhooks:manage')(req as Request, res as Response, next)
        expect(res.status).toHaveBeenCalledWith(403)
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ error: 'insufficient_scope' })
        )
      })
    })

    describe('vault:write', () => {
      it('allows API keys with vault:write scope', () => {
        req.authScopes = ['vault:write'] as UserScope[]
        requireScope('vault:write')(req as Request, res as Response, next)
        expect(next).toHaveBeenCalled()
      })

      it('denies API keys without vault:write scope', () => {
        req.authScopes = ['portfolio:read', 'vault:read'] as UserScope[]
        requireScope('vault:write')(req as Request, res as Response, next)
        expect(res.status).toHaveBeenCalledWith(403)
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ error: 'insufficient_scope' })
        )
      })
    })

    describe('alerts:manage', () => {
      it('allows API keys with alerts:manage scope', () => {
        req.authScopes = ['alerts:manage'] as UserScope[]
        requireScope('alerts:manage')(req as Request, res as Response, next)
        expect(next).toHaveBeenCalled()
      })

      it('denies API keys without alerts:manage scope', () => {
        req.authScopes = ['portfolio:read'] as UserScope[]
        requireScope('alerts:manage')(req as Request, res as Response, next)
        expect(res.status).toHaveBeenCalledWith(403)
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ error: 'insufficient_scope' })
        )
      })
    })

    describe('fiat:write', () => {
      it('allows API keys with fiat:write scope', () => {
        req.authScopes = ['fiat:write'] as UserScope[]
        requireScope('fiat:write')(req as Request, res as Response, next)
        expect(next).toHaveBeenCalled()
      })

      it('denies API keys without fiat:write scope', () => {
        req.authScopes = ['portfolio:read'] as UserScope[]
        requireScope('fiat:write')(req as Request, res as Response, next)
        expect(res.status).toHaveBeenCalledWith(403)
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ error: 'insufficient_scope' })
        )
      })
    })
  })
})
