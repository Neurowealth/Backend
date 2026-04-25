import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { logger } from '../utils/logger';

export interface ValidationSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

/**
 * Validates the request body, query, and params against provided Zod schemas.
 * If validation fails, returns a 400 response with detailed error messages.
 * Sanitization can be handled via Zod's .transform() or by stripping unknown keys.
 */
export const validate = (schemas: ValidationSchemas) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.query) {
        req.query = schemas.query.parse(req.query);
      }
      if (schemas.params) {
        req.params = schemas.params.parse(req.params);
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = error.errors.map(err => ({
          path: err.path.join('.'),
          message: err.message,
        }));
        logger.warn(`[Validation] Request validation failed: ${JSON.stringify(errors)}`);
        res.status(400).json({ error: 'Validation failed', details: errors });
      } else {
        logger.error(`[Validation] Unexpected error:`, error);
        res.status(500).json({ error: 'Internal server error during validation' });
      }
    }
  };
};
