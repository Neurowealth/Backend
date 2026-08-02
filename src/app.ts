import express, { NextFunction, Request, Response } from 'express'
import { setupCors, validateCorsConfig } from './middleware/corsandbody'
import { logger } from './utils/logger'
import dotenv from 'dotenv'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3000

// Startup validation
try {
  validateCorsConfig()
} catch (error) {
  console.error('Fatal startup error:', error)
  process.exit(1)
}

// CORS setup
setupCors(app)

// Body parser middleware
app.use(express.json({ limit: process.env.MAX_REQUEST_SIZE || '10mb' }))
app.use(
  express.urlencoded({
    extended: true,
    limit: process.env.MAX_REQUEST_SIZE || '10mb',
  })
)

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.get('origin') || 'no-origin'
  const timestamp = new Date().toISOString()
  logger.info(`[${timestamp}] ${req.method} ${req.path} (origin: ${origin})`)
  next()
})

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    port: PORT,
  })
})

// API routes
app.get('/api/data', (req: Request, res: Response) => {
  res.json({
    message: 'This endpoint is protected by CORS',
    timestamp: new Date().toISOString(),
    origin: req.get('origin'),
  })
})

app.post('/api/data', (req: Request, res: Response) => {
  res.status(201).json({
    message: 'Data created successfully',
    data: req.body,
    timestamp: new Date().toISOString(),
  })
})

app.put('/api/data/:id', (req: Request, res: Response) => {
  res.json({
    message: 'Data updated successfully',
    id: req.params.id,
    data: req.body,
    timestamp: new Date().toISOString(),
  })
})

app.delete('/api/data/:id', (req: Request, res: Response) => {
  res.json({
    message: 'Data deleted successfully',
    id: req.params.id,
    timestamp: new Date().toISOString(),
  })
})

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    method: req.method,
  })
})

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err)

  // CORS errors
  if (err.message.includes('CORS')) {
    return res.status(403).json({
      error: 'CORS Policy Violation',
      message: err.message,
      origin: req.get('origin'),
    })
  }

  // Default error response
  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred',
  })
})

// Start server
const server = app.listen(PORT, () => {
  logger.info(`✓ Server running on http://localhost:${PORT}`)
  logger.info(
    `✓ CORS enabled for: ${process.env.CORS_ALLOWED_ORIGINS || 'development'}`
  )
  logger.info(`✓ Environment: ${process.env.NODE_ENV || 'development'}`)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, closing server...')
  server.close(() => {
    logger.info('Server closed')
    process.exit(0)
  })
})

export default app
