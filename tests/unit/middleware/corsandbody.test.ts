import { Request, Response, NextFunction } from 'express'

// Mock config module before importing anything that depends on it
jest.mock('../../../src/config/env', () => ({
  config: {
    nodeEnv: 'test',
    security: {
      bodySizeLimit: '64kb',
      allowedOrigins: [],
    },
  },
}))

// Mock metrics module
jest.mock('../../../src/utils/metrics', () => ({
  recordRejectedRequest: jest.fn(),
}))

// Mock logger
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}))

// Now import the middleware after mocking dependencies
import {
  contentTypeRestrictionMiddleware,
  payloadSizeErrorHandler,
  allowBodySizeOverride,
} from '../../../src/middleware/corsandbody'
import { recordRejectedRequest } from '../../../src/utils/metrics'

describe('corsandbody middleware', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: NextFunction

  beforeEach(() => {
    req = {
      headers: {},
    }
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }
    next = jest.fn()
    jest.clearAllMocks()
  })

  describe('contentTypeRestrictionMiddleware', () => {
    it('should call next for requests without content-type', () => {
      contentTypeRestrictionMiddleware(req as Request, res as Response, next)
      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('should call next for allowed content types', () => {
      req.headers = { 'content-type': 'application/json' }
      contentTypeRestrictionMiddleware(req as Request, res as Response, next)
      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('should reject multipart/form-data', () => {
      req.headers = { 'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary' }
      contentTypeRestrictionMiddleware(req as Request, res as Response, next)
      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(415)
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Unsupported Media Type',
        reason: 'Content type "multipart/form-data" is not allowed.',
      })
      expect(recordRejectedRequest).toHaveBeenCalledWith('content_type')
    })

    it('should reject application/x-www-form-urlencoded', () => {
      req.headers = { 'content-type': 'application/x-www-form-urlencoded' }
      contentTypeRestrictionMiddleware(req as Request, res as Response, next)
      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(415)
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Unsupported Media Type',
        reason: 'Content type "application/x-www-form-urlencoded" is not allowed.',
      })
      expect(recordRejectedRequest).toHaveBeenCalledWith('content_type')
    })

    it('should skip restriction when allowUrlEncoded is set', () => {
      req.headers = { 'content-type': 'application/x-www-form-urlencoded' }
      ;(req as any).allowUrlEncoded = true
      contentTypeRestrictionMiddleware(req as Request, res as Response, next)
      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('should handle case-insensitive content-type matching', () => {
      req.headers = { 'content-type': 'MULTIPART/FORM-DATA' }
      contentTypeRestrictionMiddleware(req as Request, res as Response, next)
      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(415)
    })
  })

  describe('payloadSizeErrorHandler', () => {
    it('should call next for non-size errors', () => {
      const error = new Error('Some other error')
      payloadSizeErrorHandler(error, req as Request, res as Response, next)
      expect(next).toHaveBeenCalledWith(error)
      expect(res.status).not.toHaveBeenCalled()
    })

    it('should handle entity.too.large errors', () => {
      const error = { type: 'entity.too.large' }
      payloadSizeErrorHandler(error, req as Request, res as Response, next)
      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(413)
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Payload Too Large',
        reason: expect.stringContaining('Request body exceeds'),
      })
      expect(recordRejectedRequest).toHaveBeenCalledWith('oversized')
    })
  })

  describe('allowBodySizeOverride', () => {
    it('should set bodySizeLimitOverride on request', () => {
      const middleware = allowBodySizeOverride('1mb')
      middleware(req as Request, res as Response, next)
      expect((req as any).bodySizeLimitOverride).toBe('1mb')
      expect(next).toHaveBeenCalled()
    })
  })
})