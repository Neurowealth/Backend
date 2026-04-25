import { Response } from 'express'

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public details?: any
  ) {
    super(message)
    Object.setPrototypeOf(this, AppError.prototype)
  }
}

export const sendError = (res: Response, statusCode: number, message: string, details?: any) => {
  return res.status(statusCode).json({
    error: message,
    details,
  })
}

export const sendNotFound = (res: Response, resource: string = 'Resource') => {
  return sendError(res, 404, `${resource} not found`)
}

export const sendUnauthorized = (res: Response) => {
  return sendError(res, 401, 'Unauthorized')
}

export const sendConflict = (res: Response, message: string) => {
  return sendError(res, 409, message)
}
