import { Request, Response, NextFunction } from 'express'
import { ZodObject, ZodError } from 'zod'

export const validate = (schema: ZodObject<any>) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const parsed = await schema.safeParseAsync({
      body: req.body,
      query: req.query,
      params: req.params,
    })

    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation error',
        details: parsed.error.flatten(),
      })
    }

    // Replace req properties with parsed and typed data
    req.body = parsed.data.body
    req.query = parsed.data.query as any
    req.params = parsed.data.params as any

    return next()
  }
}
