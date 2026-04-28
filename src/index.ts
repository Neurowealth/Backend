import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { config } from './config/env'
import { errorHandler } from './middleware/errorHandler'
import { requestLogger } from './middleware/logger'
import { rateLimiter, authRateLimiter } from './middleware/rateLimiter'
import { logger } from './utils/logger'
import { startAgentLoop } from './agent/loop'
import { connectDb } from './db'
import { scheduleSessionCleanup } from './jobs/sessionCleanup'
import { startEventListener } from './stellar/events'
import healthRouter from './routes/health'
import agentRouter from './routes/agent'
import authRouter from './routes/auth'
import whatsappRouter from './routes/whatsapp'
import portfolioRouter from './routes/portfolio'
import transactionsRouter from './routes/transactions'
import protocolsRouter from './routes/protocols'
import depositRouter from './routes/deposit'
import withdrawRouter from './routes/withdraw'
import vaultRouter from './routes/vault'
import analyticsRouter from './routes/analytics'

const app = express()

// Trust proxy for rate limiting (essential if behind Nginx/Heroku/Cloudflare)
app.set('trust proxy', 1)

// Security and parsing middleware
app.use(helmet())
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

// Logging and rate limiting
app.use(requestLogger)
app.use(rateLimiter)

// Public routes
app.use('/health', healthRouter)
app.use('/api/agent', agentRouter)
app.use('/api/auth', authRateLimiter, authRouter)
app.use('/api/whatsapp', whatsappRouter)
app.use('/api/portfolio', portfolioRouter)
app.use('/api/transactions', transactionsRouter)
app.use('/api/protocols', protocolsRouter)
app.use('/api/deposit', depositRouter)
app.use('/api/withdraw', withdrawRouter)
app.use('/api/vault', vaultRouter)
app.use('/api/analytics', analyticsRouter)

// Global error handler — must always be last
app.use(errorHandler)

async function main() {
  await connectDb()
  scheduleSessionCleanup()

  app.listen(config.port, async () => {
    logger.info(`NeuroWealth backend running on port ${config.port}`)
    logger.info(`Environment: ${config.nodeEnv}`)
    logger.info(`Network: ${config.stellar.network}`)

    try {
      await startEventListener()
      logger.info('Vault event listener started')
      await startAgentLoop()
    } catch (error) {
      logger.error('Failed to start agent loop', {
        error: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  })
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('[Startup] Unexpected error:', error)
    process.exit(1)
  })
}

export default app
