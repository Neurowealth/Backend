import { validateUserScopes, USER_SCOPES } from '../../../src/auth/scopes'
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
  })
})
