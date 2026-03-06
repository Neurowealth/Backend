import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { config } from './config/env'
import { errorHandler } from './middleware/errorHandler'
import { requestLogger } from './middleware/logger'
import { rateLimiter } from './middleware/rateLimiter'
import { authenticate } from './middleware/auth'
import { logger } from './utils/logger'
import healthRouter from './routes/health'
import portfolioRouter from './routes/portfolio'
import transactionsRouter from './routes/transactions'
import protocolsRouter from './routes/protocols'
import depositRouter from './routes/deposit'
import withdrawRouter from './routes/withdraw'
import whatsappRouter from './routes/whatsapp'

const app = express()

// Security and parsing middleware
app.use(helmet())
app.use(cors())
app.use(express.json())

// Logging and rate limiting
app.use(requestLogger)
app.use(rateLimiter)

// Routes
app.use('/health', healthRouter)
app.use('/api/whatsapp', whatsappRouter)

// Public API Routes
app.use('/api/protocols', protocolsRouter)

// Protected API Routes (require authentication)
app.use('/api/portfolio', authenticate, portfolioRouter)
app.use('/api/transactions', authenticate, transactionsRouter)
app.use('/api/deposit', authenticate, depositRouter)
app.use('/api/withdraw', authenticate, withdrawRouter)

// Global error handler — must always be lasts
app.use(errorHandler)

// Start server
app.listen(config.port, () => {
  logger.info(`NeuroWealth backend running on port ${config.port}`)
  logger.info(`Environment: ${config.nodeEnv}`)
  logger.info(`Network: ${config.stellar.network}`)
})

export default app