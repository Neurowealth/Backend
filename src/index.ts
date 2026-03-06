import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { config } from './config/env'
import { errorHandler } from './middleware/errorHandler'
import { requestLogger } from './middleware/logger'
import { rateLimiter } from './middleware/rateLimiter'
import { logger } from './utils/logger'
import healthRouter from './routes/health'

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

// WhatsApp webhook endpoints
import whatsappRouter from './routes/whatsapp';
app.use('/api/whatsapp', whatsappRouter)

// Global error handler — must always be last
app.use(errorHandler)

// Start server
app.listen(config.port, () => {
  logger.info(`NeuroWealth backend running on port ${config.port}`)
  logger.info(`Environment: ${config.nodeEnv}`)
  logger.info(`Network: ${config.stellar.network}`)
})

export default app