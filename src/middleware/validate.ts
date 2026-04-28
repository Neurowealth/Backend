import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError, ZodTypeAny } from 'zod';
import { logger } from '../utils/logger';

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
  errorMessage?: string;
}

type SchemasOrSchema = ValidationSchemas | ZodSchema<any> | ZodTypeAny;

function isZodSchema(val: any): val is ZodSchema<any> | ZodTypeAny {
  return val && typeof val.safeParseAsync === 'function';
}

function formatZodErrors(err: ZodError) {
  return err.issues.map(e => ({
    path: e.path.join('.'),
    message: e.message.includes('received undefined') ? 'Required' : e.message,
  }));
}

/**
 * Middleware that accepts either:
 * - a Zod schema for the whole request shape (object with `body`, `query`, `params`), or
 * - an object with individual `body`, `query`, `params` Zod schemas.
 */
export const validate = (schemasOrSchema: SchemasOrSchema) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (isZodSchema(schemasOrSchema)) {
        const parsed = await schemasOrSchema.safeParseAsync({ body: req.body, query: req.query, params: req.params });
        if (!parsed.success) {
          return res.status(400).json({ error: 'Validation failed', details: formatZodErrors(parsed.error) });
        }

        // Merge parsed results back into req if present
        const data: any = parsed.data || {};
        if (data.body !== undefined) req.body = data.body;
        if (data.query !== undefined) Object.defineProperty(req, 'query', { value: data.query, writable: true, configurable: true });
        if (data.params !== undefined) Object.defineProperty(req, 'params', { value: data.params, writable: true, configurable: true });

        return next();
      }

      const schemas = schemasOrSchema as ValidationSchemas;
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) Object.defineProperty(req, 'query', { value: schemas.query.parse(req.query) as typeof req.query, writable: true, configurable: true });
      if (schemas.params) Object.defineProperty(req, 'params', { value: schemas.params.parse(req.params) as typeof req.params, writable: true, configurable: true });

      return next();
    } catch (error) {
      if (error instanceof ZodError) {
        const details = formatZodErrors(error);
        logger.warn(`[Validation] Request validation failed: ${JSON.stringify(details)}`);
        const msg = (schemasOrSchema as ValidationSchemas).errorMessage ?? 'Validation failed';
        return res.status(400).json({ error: msg, details });
      }

      logger.error('[Validation] Unexpected error:', error);
      return res.status(500).json({ error: 'Internal server error during validation' });
    }
  };
};
