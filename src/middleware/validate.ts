import { Request, Response, NextFunction } from 'express'
import { ZodSchema, ZodError, ZodTypeAny } from 'zod'
import { logger } from '../utils/logger'
import {
  ErrorResponses,
  FieldError,
  INTERNAL_ERROR_MESSAGE,
} from '../utils/errorResponse'

export interface ValidationSchemas {
  body?: ZodTypeAny
  query?: ZodTypeAny
  params?: ZodTypeAny
  errorMessage?: string
}

type SchemasOrSchema = ValidationSchemas | ZodSchema<any> | ZodTypeAny

function isZodSchema(val: any): val is ZodSchema<any> | ZodTypeAny {
  return val && typeof val.safeParseAsync === 'function'
}

/**
 * Field-level validation details. `path` is kept as an alias of `field` for
 * clients written against the previous response shape.
 */
export function formatZodErrors(
  err: ZodError
): Array<FieldError & { path: string }> {
  return err.issues.map((e) => {
    const field = e.path.join('.')
    return {
      field,
      path: field,
      message: e.message.includes('received undefined')
        ? 'Required'
        : e.message,
    }
  })
}

function requestIdOf(req: Request): string {
  return req.correlationId ?? 'unknown'
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
        const parsed = await schemasOrSchema.safeParseAsync({
          body: req.body,
          query: req.query,
          params: req.params,
        })
        if (!parsed.success) {
          return res
            .status(400)
            .json(
              ErrorResponses.validationError(
                'Validation failed',
                requestIdOf(req),
                formatZodErrors(parsed.error)
              )
            )
        }

        // Merge parsed results back into req if present
        const data: any = parsed.data || {}
        if (data.body !== undefined) req.body = data.body
        if (data.query !== undefined)
          Object.defineProperty(req, 'query', {
            value: data.query,
            writable: true,
            configurable: true,
          })
        if (data.params !== undefined)
          Object.defineProperty(req, 'params', {
            value: data.params,
            writable: true,
            configurable: true,
          })

        return next()
      }

      const schemas = schemasOrSchema as ValidationSchemas
      if (schemas.body) req.body = schemas.body.parse(req.body)
      if (schemas.query)
        Object.defineProperty(req, 'query', {
          value: schemas.query.parse(req.query) as typeof req.query,
          writable: true,
          configurable: true,
        })
      if (schemas.params)
        Object.defineProperty(req, 'params', {
          value: schemas.params.parse(req.params) as typeof req.params,
          writable: true,
          configurable: true,
        })

      return next()
    } catch (error) {
      if (error instanceof ZodError) {
        const details = formatZodErrors(error)
        logger.warn(
          `[Validation] Request validation failed: ${JSON.stringify(details)}`
        )
        const msg =
          (schemasOrSchema as ValidationSchemas).errorMessage ??
          'Validation failed'
        return res
          .status(400)
          .json(ErrorResponses.validationError(msg, requestIdOf(req), details))
      }

      logger.error('[Validation] Unexpected error:', error)
      return res
        .status(500)
        .json(
          ErrorResponses.internalError(INTERNAL_ERROR_MESSAGE, requestIdOf(req))
        )
    }
  }
}
