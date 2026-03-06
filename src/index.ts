import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { config } from './config/env'
import { errorHandler } from './middleware/errorHandler'
import { requestLogger } from './middleware/logger'
import { rateLimiter } from './middleware/rateLimiter'
import { AuthMiddleware } from './middleware/authenticate'
import { logger } from './utils/logger'
import { connectDb } from './db'
import { scheduleSessionCleanup } from './jobs/sessionCleanup'
import healthRouter from './routes/health'
import authRouter from './routes/auth'

const app = express()

// Security and parsing middleware
app.use(helmet())
app.use(cors())
app.use(express.json())

// Logging and rate limiting
app.use(requestLogger)
app.use(rateLimiter)

// Public routes
app.use('/health', healthRouter)
app.use('/api/auth', authRouter)

// Protected routes (require valid JWT)
// All routes mounted below this line are automatically protected.
app.use('/api/portfolio', AuthMiddleware.validateJwt)
app.use('/api/transactions', AuthMiddleware.validateJwt)
app.use('/api/deposit', AuthMiddleware.validateJwt)
app.use('/api/withdraw', AuthMiddleware.validateJwt)

// TODO: mount actual portfolio / transaction / deposit / withdraw routers here
// e.g. app.use('/api/portfolio', portfolioRouter)

// WhatsApp webhook endpoints
import whatsappRouter from './routes/whatsapp';
app.use('/api/whatsapp', whatsappRouter)

// Global error handler — must always be last
app.use(errorHandler)

async function main() {
  // Database connectivity check
  await connectDb()

  // Background jobs
  scheduleSessionCleanup()

  // Start HTTP server
  app.listen(config.port, () => {
    logger.info(`NeuroWealth backend running on port ${config.port}`)
    logger.info(`Environment: ${config.nodeEnv}`)
    logger.info(`Network: ${config.stellar.network}`)
  })
}

main().catch((error) => {
  logger.error('[Startup] Unexpected error:', error)
  process.exit(1)
})

export default app