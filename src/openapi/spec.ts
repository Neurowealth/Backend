const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })

const jsonResponse = (schema: Record<string, unknown>, description = 'Successful response') => ({
  description,
  content: {
    'application/json': {
      schema,
    },
  },
})

const textResponse = (
  contentType: 'text/plain' | 'text/xml',
  schema: Record<string, unknown> | { type: 'string'; example: string },
  description = 'Successful response',
) => ({
  description,
  content: {
    [contentType]: {
      schema,
    },
  },
})

const bearerSecurity = [{ bearerAuth: [] }]
const adminSecurity = [{ adminToken: [] }]

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Neurowealth Backend API',
    version: '1.0.0',
    description:
      'OpenAPI 3 reference for the Neurowealth backend /api/* routes and related integrator endpoints.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Auth' },
    { name: 'Agent' },
    { name: 'Analytics' },
    { name: 'Admin' },
    { name: 'Deposit' },
    { name: 'Protocols' },
    { name: 'Portfolio' },
    { name: 'Stellar' },
    { name: 'Transactions' },
    { name: 'Vault' },
    { name: 'Withdraw' },
    { name: 'WhatsApp' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
      adminToken: {
        type: 'apiKey',
        in: 'header',
        name: 'x-admin-token',
      },
    },
    schemas: {
      ErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string', nullable: true },
          details: { type: 'object', nullable: true },
        },
        required: ['error'],
      },
      ValidationErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          details: { type: 'object' },
        },
        required: ['error', 'details'],
      },
      AuthChallengeRequest: {
        type: 'object',
        properties: {
          stellarPubKey: { type: 'string' },
        },
        required: ['stellarPubKey'],
      },
      AuthChallengeResponse: {
        type: 'object',
        properties: {
          nonce: { type: 'string' },
          expiresAt: { type: 'string', format: 'date-time' },
        },
        required: ['nonce', 'expiresAt'],
      },
      AuthVerifyRequest: {
        type: 'object',
        properties: {
          stellarPubKey: { type: 'string' },
          signature: { type: 'string' },
        },
        required: ['stellarPubKey', 'signature'],
      },
      AuthVerifyResponse: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          userId: { type: 'string', format: 'uuid' },
          expiresAt: { type: 'string', format: 'date-time' },
        },
        required: ['token', 'userId', 'expiresAt'],
      },
      LogoutResponse: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
        required: ['message'],
      },
      AgentStatusResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            type: 'object',
            properties: {
              isRunning: { type: 'boolean' },
              lastRebalanceAt: { type: 'string', format: 'date-time', nullable: true },
              currentProtocol: { type: 'string', nullable: true },
              currentApy: { type: 'string', nullable: true },
              nextScheduledCheck: { type: 'string', format: 'date-time', nullable: true },
              lastError: { type: 'string', nullable: true },
              healthStatus: { type: 'string' },
              timestamp: { type: 'string', format: 'date-time' },
            },
            required: [
              'isRunning',
              'lastRebalanceAt',
              'currentProtocol',
              'currentApy',
              'nextScheduledCheck',
              'lastError',
              'healthStatus',
              'timestamp',
            ],
          },
          whatsappReply: { type: 'string' },
        },
        required: ['success', 'data', 'whatsappReply'],
      },
      PortfolioPosition: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          protocolName: { type: 'string' },
          assetSymbol: { type: 'string' },
          currentValue: { type: 'number' },
          yieldEarned: { type: 'number' },
          status: { type: 'string' },
        },
        required: ['id', 'protocolName', 'assetSymbol', 'currentValue', 'yieldEarned', 'status'],
      },
      PortfolioResponse: {
        type: 'object',
        properties: {
          userId: { type: 'string', format: 'uuid' },
          totalBalance: { type: 'number' },
          totalEarnings: { type: 'number' },
          activePositions: { type: 'number' },
          positions: {
            type: 'array',
            items: ref('PortfolioPosition'),
          },
          whatsappReply: { type: 'string' },
        },
        required: ['userId', 'totalBalance', 'totalEarnings', 'activePositions', 'positions', 'whatsappReply'],
      },
      PortfolioHistoryPoint: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          yieldAmount: { type: 'number' },
        },
        required: ['date', 'yieldAmount'],
      },
      PortfolioHistoryResponse: {
        type: 'object',
        properties: {
          userId: { type: 'string', format: 'uuid' },
          period: { type: 'string', enum: ['7d', '30d', '90d'] },
          points: {
            type: 'array',
            items: ref('PortfolioHistoryPoint'),
          },
          whatsappReply: { type: 'string' },
        },
        required: ['userId', 'period', 'points', 'whatsappReply'],
      },
      PortfolioEarningsResponse: {
        type: 'object',
        properties: {
          userId: { type: 'string', format: 'uuid' },
          totalEarnings: { type: 'number' },
          periodEarnings: { type: 'number' },
          averageApy: { type: 'number' },
          whatsappReply: { type: 'string' },
        },
        required: ['userId', 'totalEarnings', 'periodEarnings', 'averageApy', 'whatsappReply'],
      },
      TransactionItem: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          txHash: { type: 'string' },
          type: { type: 'string' },
          status: { type: 'string' },
          amount: { type: 'number' },
          assetSymbol: { type: 'string' },
          protocolName: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'txHash', 'type', 'status', 'amount', 'assetSymbol', 'createdAt'],
      },
      TransactionDetailResponse: {
        type: 'object',
        properties: {
          transaction: ref('TransactionItem'),
          whatsappReply: { type: 'string' },
        },
        required: ['transaction', 'whatsappReply'],
      },
      TransactionListResponse: {
        type: 'object',
        properties: {
          page: { type: 'number' },
          limit: { type: 'number' },
          total: { type: 'number' },
          transactions: {
            type: 'array',
            items: ref('TransactionItem'),
          },
          whatsappReply: { type: 'string' },
        },
        required: ['page', 'limit', 'total', 'transactions', 'whatsappReply'],
      },
      ProtocolRate: {
        type: 'object',
        properties: {
          protocolName: { type: 'string' },
          assetSymbol: { type: 'string' },
          supplyApy: { type: 'number' },
          borrowApy: { type: 'number', nullable: true },
          tvl: { type: 'number', nullable: true },
          network: { type: 'string' },
          fetchedAt: { type: 'string', format: 'date-time' },
        },
        required: ['protocolName', 'assetSymbol', 'supplyApy', 'borrowApy', 'tvl', 'network', 'fetchedAt'],
      },
      ProtocolRatesResponse: {
        type: 'object',
        properties: {
          rates: {
            type: 'array',
            items: ref('ProtocolRate'),
          },
          whatsappReply: { type: 'string' },
        },
        required: ['rates', 'whatsappReply'],
      },
      ProtocolAgentStatusResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            type: 'object',
            properties: {
              isRunning: { type: 'boolean' },
              healthStatus: { type: 'string' },
              lastRebalanceAt: { type: 'string', format: 'date-time', nullable: true },
              currentProtocol: { type: 'string', nullable: true },
              currentApy: { type: 'number', nullable: true },
              nextScheduledCheck: { type: 'string', format: 'date-time' },
              lastError: { type: 'string', nullable: true },
              latestLog: {
                type: 'object',
                nullable: true,
                properties: {
                  status: { type: 'string' },
                  action: { type: 'string' },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
              timestamp: { type: 'string', format: 'date-time' },
            },
            required: [
              'isRunning',
              'healthStatus',
              'lastRebalanceAt',
              'currentProtocol',
              'currentApy',
              'nextScheduledCheck',
              'lastError',
              'latestLog',
              'timestamp',
            ],
          },
          whatsappReply: { type: 'string' },
        },
        required: ['success', 'data', 'whatsappReply'],
      },
      TransactionMutationRequest: {
        type: 'object',
        properties: {
          userId: { type: 'string', format: 'uuid' },
          amount: { type: 'number', exclusiveMinimum: 0 },
          assetSymbol: { type: 'string' },
          protocolName: { type: 'string' },
          memo: { type: 'string', maxLength: 280 },
        },
        required: ['userId', 'amount', 'assetSymbol'],
      },
      TransactionMutationResponse: {
        type: 'object',
        properties: {
          txHash: { type: 'string' },
          status: { type: 'string' },
          transaction: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              txHash: { type: 'string' },
              status: { type: 'string' },
              amount: { type: 'number' },
              assetSymbol: { type: 'string' },
              protocolName: { type: 'string', nullable: true },
            },
            required: ['id', 'txHash', 'status', 'amount', 'assetSymbol'],
          },
          whatsappReply: { type: 'string' },
        },
        required: ['txHash', 'status', 'transaction', 'whatsappReply'],
      },
      VaultStateResponse: {
        type: 'object',
        properties: {
          apy: { type: 'number' },
          activeProtocol: { type: 'string' },
        },
        required: ['apy', 'activeProtocol'],
      },
      VaultBalanceResponse: {
        type: 'object',
        properties: {
          balance: { type: 'number' },
          shares: { type: 'number' },
        },
        required: ['balance', 'shares'],
      },
      VaultBuildTransactionResponse: {
        type: 'object',
        properties: {
          xdr: { type: 'string' },
          type: { type: 'string', enum: ['deposit', 'withdraw'] },
          amount: { type: 'number' },
          walletAddress: { type: 'string' },
        },
        required: ['xdr', 'type', 'amount', 'walletAddress'],
      },
      AnalyticsApyHistoryResponse: {
        type: 'object',
        properties: {
          userId: { type: 'string', format: 'uuid' },
          period: { type: 'string', enum: ['7d', '30d', '90d'] },
          points: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date: { type: 'string' },
                apy: { type: 'number' },
                positionId: { type: 'string' },
              },
              required: ['date', 'apy', 'positionId'],
            },
          },
        },
        required: ['userId', 'period', 'points'],
      },
      AnalyticsUserYieldResponse: {
        type: 'object',
        properties: {
          userId: { type: 'string', format: 'uuid' },
          period: { type: 'string', enum: ['7d', '30d', '90d'] },
          totalYield: { type: 'number' },
          periodYield: { type: 'number' },
          averageApy: { type: 'number' },
          points: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date: { type: 'string' },
                yieldAmount: { type: 'number' },
                apy: { type: 'number' },
              },
              required: ['date', 'yieldAmount', 'apy'],
            },
          },
        },
        required: ['userId', 'period', 'totalYield', 'periodYield', 'averageApy', 'points'],
      },
      AnalyticsProtocolPerformanceResponse: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['7d', '30d', '90d'] },
          protocols: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                protocol: { type: 'string' },
                asset: { type: 'string' },
                network: { type: 'string' },
                points: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      date: { type: 'string' },
                      apy: { type: 'number' },
                      tvl: { type: 'number', nullable: true },
                    },
                    required: ['date', 'apy', 'tvl'],
                  },
                },
              },
              required: ['protocol', 'asset', 'network', 'points'],
            },
          },
        },
        required: ['period', 'protocols'],
      },
      StellarMetricsResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: { type: 'object' },
        },
        required: ['success', 'data'],
      },
      AdminEnvelope: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: { type: 'object' },
          message: { type: 'string' },
          error: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
        },
        required: ['success', 'data', 'timestamp'],
      },
    },
  },
  paths: {
    '/api/agent/status': {
      get: {
        tags: ['Agent'],
        summary: 'Agent status',
        responses: {
          200: jsonResponse(ref('AgentStatusResponse')),
          500: jsonResponse(ref('ErrorResponse'), 'Internal server error'),
        },
      },
    },
    '/api/auth/challenge': {
      post: {
        tags: ['Auth'],
        summary: 'Create challenge nonce',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: ref('AuthChallengeRequest'),
            },
          },
        },
        responses: {
          200: jsonResponse(ref('AuthChallengeResponse')),
          400: jsonResponse(ref('ErrorResponse'), 'Bad request'),
        },
      },
    },
    '/api/auth/verify': {
      post: {
        tags: ['Auth'],
        summary: 'Verify Stellar signature',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: ref('AuthVerifyRequest'),
            },
          },
        },
        responses: {
          200: jsonResponse(ref('AuthVerifyResponse')),
          400: jsonResponse(ref('ErrorResponse'), 'Bad request'),
          401: jsonResponse(ref('ErrorResponse'), 'Unauthorized'),
          500: jsonResponse(ref('ErrorResponse'), 'Internal server error'),
        },
      },
    },
    '/api/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Revoke current session',
        security: bearerSecurity,
        responses: {
          200: jsonResponse(ref('LogoutResponse')),
          401: jsonResponse(ref('ErrorResponse'), 'Unauthorized'),
          500: jsonResponse(ref('ErrorResponse'), 'Internal server error'),
        },
      },
    },
    '/api/whatsapp/webhook': {
      get: {
        tags: ['WhatsApp'],
        summary: 'Twilio webhook liveness',
        responses: {
          200: textResponse('text/plain', { type: 'string', example: 'WhatsApp webhook is alive' }),
        },
      },
      post: {
        tags: ['WhatsApp'],
        summary: 'Receive WhatsApp webhook',
        requestBody: {
          required: false,
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                properties: {
                  From: { type: 'string' },
                  Body: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: textResponse('text/xml', { type: 'string', example: '<Response><Message>ok</Message></Response>' }),
          403: jsonResponse(ref('ErrorResponse'), 'Forbidden'),
        },
      },
    },
    '/api/portfolio/{userId}': {
      get: {
        tags: ['Portfolio'],
        security: bearerSecurity,
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          200: jsonResponse(ref('PortfolioResponse')),
          401: jsonResponse(ref('ErrorResponse'), 'Unauthorized'),
          404: jsonResponse(ref('ErrorResponse'), 'Not found'),
        },
      },
    },
    '/api/portfolio/{userId}/history': {
      get: {
        tags: ['Portfolio'],
        security: bearerSecurity,
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
          {
            name: 'period',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['7d', '30d', '90d'], default: '30d' },
          },
        ],
        responses: {
          200: jsonResponse(ref('PortfolioHistoryResponse')),
          400: jsonResponse(ref('ValidationErrorResponse'), 'Validation error'),
          401: jsonResponse(ref('ErrorResponse'), 'Unauthorized'),
          404: jsonResponse(ref('ErrorResponse'), 'Not found'),
        },
      },
    },
    '/api/portfolio/{userId}/earnings': {
      get: {
        tags: ['Portfolio'],
        security: bearerSecurity,
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          200: jsonResponse(ref('PortfolioEarningsResponse')),
          401: jsonResponse(ref('ErrorResponse'), 'Unauthorized'),
          404: jsonResponse(ref('ErrorResponse'), 'Not found'),
        },
      },
    },
    '/api/transactions/detail/{txHash}': {
      get: {
        tags: ['Transactions'],
        security: bearerSecurity,
        parameters: [
          {
            name: 'txHash',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: jsonResponse(ref('TransactionDetailResponse')),
          401: jsonResponse(ref('ErrorResponse'), 'Unauthorized'),
          404: jsonResponse(ref('ErrorResponse'), 'Not found'),
        },
      },
    },
    '/api/transactions/{userId}': {
      get: {
        tags: ['Transactions'],
        security: bearerSecurity,
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
          {
            name: 'page',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, default: 1 },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 50, default: 5 },
          },
        ],
        responses: {
          200: jsonResponse(ref('TransactionListResponse')),
          400: jsonResponse(ref('ValidationErrorResponse'), 'Validation error'),
          401: jsonResponse(ref('ErrorResponse'), 'Unauthorized'),
          404: jsonResponse(ref('ErrorResponse'), 'Not found'),
        },
      },
    },
    '/api/protocols/rates': {
      get: {
        tags: ['Protocols'],
        responses: {
          200: jsonResponse(ref('ProtocolRatesResponse')),
        },
      },
    },
    '/api/protocols/agent/status': {
      get: {
        tags: ['Protocols'],
        responses: {
          200: jsonResponse(ref('ProtocolAgentStatusResponse')),
          500: jsonResponse(ref('ErrorResponse'), 'Internal server error'),
        },
      },
    },
    '/api/deposit': {
      post: {
        tags: ['Deposit'],
        security: bearerSecurity,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: ref('TransactionMutationRequest'),
            },
          },
        },
        responses: {
          201: jsonResponse(ref('TransactionMutationResponse'), 'Created'),
          400: jsonResponse(ref('ValidationErrorResponse'), 'Validation error'),
          401: jsonResponse(ref('ErrorResponse'), 'Unauthorized'),
          404: jsonResponse(ref('ErrorResponse'), 'Not found'),
          409: jsonResponse(ref('ErrorResponse'), 'Conflict'),
        },
      },
    },
    '/api/withdraw': {
      post: {
        tags: ['Withdraw'],
        security: bearerSecurity,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: ref('TransactionMutationRequest'),
            },
          },
        },
        responses: {
          201: jsonResponse(ref('TransactionMutationResponse'), 'Created'),
          400: jsonResponse(ref('ValidationErrorResponse'), 'Validation error'),
          401: jsonResponse(ref('ErrorResponse'), 'Unauthorized'),
          404: jsonResponse(ref('ErrorResponse'), 'Not found'),
          409: jsonResponse(ref('ErrorResponse'), 'Conflict'),
        },
      },
    },
    '/api/vault/state': {
      get: {
        tags: ['Vault'],
        responses: {
          200: jsonResponse(ref('VaultStateResponse')),
        },
      },
    },
    '/api/vault/balance': {
      get: {
        tags: ['Vault'],
        security: bearerSecurity,
        responses: {
          200: jsonResponse(ref('VaultBalanceResponse')),
          401: jsonResponse(ref('ErrorResponse'), 'Unauthorized'),
          404: jsonResponse(ref('ErrorResponse'), 'Not found'),
        },
      },
    },
    '/api/vault/build-transaction': {
      post: {
        tags: ['Vault'],
        security: bearerSecurity,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['deposit', 'withdraw'] },
                  amount: { type: 'number', exclusiveMinimum: 0 },
                  assetSymbol: { type: 'string' },
                },
                required: ['type', 'amount', 'assetSymbol'],
              },
            },
          },
        },
        responses: {
          200: jsonResponse(ref('VaultBuildTransactionResponse')),
          400: jsonResponse(ref('ValidationErrorResponse'), 'Validation error'),
          401: jsonResponse(ref('ErrorResponse'), 'Unauthorized'),
        },
      },
    },
    '/api/analytics/apy-history': {
      get: {
        tags: ['Analytics'],
        security: bearerSecurity,
        parameters: [
          {
            name: 'period',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['7d', '30d', '90d'], default: '30d' },
          },
        ],
        responses: {
          200: jsonResponse(ref('AnalyticsApyHistoryResponse')),
          400: jsonResponse(ref('ValidationErrorResponse'), 'Validation error'),
        },
      },
    },
    '/api/analytics/user-yield': {
      get: {
        tags: ['Analytics'],
        security: bearerSecurity,
        parameters: [
          {
            name: 'period',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['7d', '30d', '90d'], default: '30d' },
          },
        ],
        responses: {
          200: jsonResponse(ref('AnalyticsUserYieldResponse')),
          400: jsonResponse(ref('ValidationErrorResponse'), 'Validation error'),
        },
      },
    },
    '/api/analytics/protocol-performance': {
      get: {
        tags: ['Analytics'],
        parameters: [
          {
            name: 'period',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['7d', '30d', '90d'], default: '30d' },
          },
        ],
        responses: {
          200: jsonResponse(ref('AnalyticsProtocolPerformanceResponse')),
          400: jsonResponse(ref('ValidationErrorResponse'), 'Validation error'),
        },
      },
    },
    '/api/stellar/metrics': {
      get: {
        tags: ['Stellar'],
        responses: {
          200: jsonResponse(ref('StellarMetricsResponse')),
          500: jsonResponse(ref('ErrorResponse'), 'Internal server error'),
        },
      },
    },
    '/api/admin/stellar/metrics': {
      get: {
        tags: ['Admin'],
        security: adminSecurity,
        responses: {
          200: jsonResponse(ref('AdminEnvelope')),
          403: jsonResponse(ref('ErrorResponse'), 'Forbidden'),
          500: jsonResponse(ref('ErrorResponse'), 'Internal server error'),
        },
      },
    },
    '/api/admin/dlq/inspect': {
      get: {
        tags: ['Admin'],
        security: adminSecurity,
        parameters: [
          {
            name: 'status',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['PENDING', 'RETRIED', 'RESOLVED'] },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          },
        ],
        responses: {
          200: jsonResponse(ref('AdminEnvelope')),
          403: jsonResponse(ref('ErrorResponse'), 'Forbidden'),
          500: jsonResponse(ref('ErrorResponse'), 'Internal server error'),
        },
      },
    },
    '/api/admin/dlq/retry': {
      post: {
        tags: ['Admin'],
        security: adminSecurity,
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  dryRun: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          200: jsonResponse(ref('AdminEnvelope')),
          400: jsonResponse(ref('ErrorResponse'), 'Bad request'),
          403: jsonResponse(ref('ErrorResponse'), 'Forbidden'),
          500: jsonResponse(ref('ErrorResponse'), 'Internal server error'),
        },
      },
    },
    '/api/admin/dlq/resolve': {
      post: {
        tags: ['Admin'],
        security: adminSecurity,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  eventId: { type: 'string' },
                },
                required: ['eventId'],
              },
            },
          },
        },
        responses: {
          200: jsonResponse(ref('AdminEnvelope')),
          400: jsonResponse(ref('ErrorResponse'), 'Bad request'),
          403: jsonResponse(ref('ErrorResponse'), 'Forbidden'),
          404: jsonResponse(ref('ErrorResponse'), 'Not found'),
          500: jsonResponse(ref('ErrorResponse'), 'Internal server error'),
        },
      },
    },
    '/api/admin/stellar/backfill': {
      post: {
        tags: ['Admin'],
        security: adminSecurity,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  startLedger: { type: 'number' },
                  endLedger: { type: 'number' },
                },
                required: ['startLedger'],
              },
            },
          },
        },
        responses: {
          200: jsonResponse(ref('AdminEnvelope')),
          400: jsonResponse(ref('ErrorResponse'), 'Bad request'),
          403: jsonResponse(ref('ErrorResponse'), 'Forbidden'),
          500: jsonResponse(ref('ErrorResponse'), 'Internal server error'),
        },
      },
    },
  },
} as const

export type OpenApiSpec = typeof openApiSpec
