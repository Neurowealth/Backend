# NeuroWealth Backend

[![CI](https://github.com/Neurowealth/Backend/actions/workflows/node-ci.yml/badge.svg)](https://github.com/Neurowealth/Backend/actions/workflows/node-ci.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> Autonomous AI investment agent backend that manages and grows crypto assets on the **Stellar blockchain**. Users deposit once and the AI finds yield opportunities across Stellar's DeFi ecosystem.

## Features

- **AI-Powered Portfolio Management** - Autonomous rebalancing using Anthropic Claude
- **Stellar Blockchain Integration** - Native Soroban smart contracts, claimable balances, and multi-sig support
- **DeFi Yield Optimization** - Automated yield farming across Stellar protocols
- **Real-time Analytics** - Monte Carlo simulations, correlation analysis, factor exposure, stress testing
- **NLP Trading Interface** - Natural language commands for portfolio management (Telegram, WhatsApp)
- **Circuit Breaker System** - Automated risk management with exposure caps and rebalance cost analysis
- **Privacy & Compliance** - GDPR/CCPA erasure, Travel Rule support, audit trail
- **Tax Reporting** - Multi-jurisdiction tax calculation (US, UK, DE, CA, AU)
- **Referral Program** - Multi-tier referral system with fraud detection

## Quickstart

```bash
# 1. Clone and install
git clone https://github.com/Neurowealth/Backend.git
cd Backend
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your values

# 3. Start database
docker-compose up -d

# 4. Run migrations
npx prisma migrate deploy

# 5. Start development server
npm run dev
```

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start development server with hot-reload |
| `npm test` | Run all tests |
| `npm run test:unit` | Run unit tests only |
| `npm run test:integration` | Run integration tests |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run TypeScript type check |
| `npm run build` | Build for production |
| `npm run format` | Format code with Prettier |
| `npm run validate:spec` | Validate OpenAPI specification |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22+ / TypeScript 5.3 |
| Framework | Express.js |
| Database | PostgreSQL 14+ (Prisma ORM) |
| Cache/Queue | Redis (ioredis) |
| Blockchain | Stellar SDK, Soroban smart contracts |
| AI | Anthropic Claude SDK |
| Monitoring | OpenTelemetry, Prometheus, Sentry |
| Security | Helmet, CORS, JWT, Zod validation |
| Docs | Swagger UI, OpenAPI (Redocly-validated) |
| Testing | Jest, Supertest |
| CI/CD | GitHub Actions, Dependabot |
| Deployment | Docker, Kubernetes |

## Project Structure

```
Backend/
├── src/
│   ├── agent/          # AI agent, strategies, risk management
│   ├── analytics/      # Monte Carlo, correlation, factor analysis
│   ├── auth/           # JWT authentication, API keys
│   ├── compliance/     # Travel Rule, KYC support
│   ├── controllers/    # Request handlers
│   ├── fiat/           # Fiat on-ramp (Transak)
│   ├── jobs/           # Background jobs (erasure, treasury, reconciliation)
│   ├── middleware/      # Auth, rate limiting, sub-accounts
│   ├── nlp/            # Natural language processing
│   ├── outbox/         # Transactional outbox pattern
│   ├── privacy/        # Data mapping, erasure policies
│   ├── referral/       # Multi-tier referral system
│   ├── routes/         # API route definitions
│   ├── stellar/        # Stellar SDK integration
│   ├── strategy/       # Strategy simulation
│   ├── tax/            # Multi-jurisdiction tax reporting
│   ├── telegram/       # Telegram bot integration
│   ├── whatsapp/       # WhatsApp bot integration
│   └── validators/     # Zod request validation
├── tests/
│   ├── unit/           # Unit tests
│   ├── integration/    # Integration tests
│   └── load/           # Load tests
├── prisma/             # Database schema & migrations
├── docs/               # Documentation (38+ files)
├── deploy/             # Kubernetes & monitoring configs
└── scripts/            # Operational scripts
```

## Documentation

| Document | Description |
|----------|-------------|
| [Documentation Index](docs/DOCUMENTATION_INDEX.md) | Master index with reading order |
| [API Reference](docs/API_REFERENCE.md) | Full endpoint reference |
| [Deployment Guide](docs/DEPLOYMENT.md) | Local, staging, production setup |
| [Runbook](docs/RUNBOOK.md) | Operational runbook |
| [OpenAPI Spec](docs/openapi.yaml) | Machine-readable API specification |
| [Contributing](CONTRIBUTING.md) | How to contribute |
| [Security Policy](SECURITY.md) | Vulnerability reporting & security measures |

## Environment Variables

See [`.env.example`](.env.example) for all required environment variables.

Key variables:
- `DATABASE_URL` - PostgreSQL connection string
- `STELLAR_NETWORK` - `testnet` or `mainnet`
- `STELLAR_AGENT_SECRET_KEY` - Stellar secret key
- `VAULT_CONTRACT_ID` - Deployed vault contract ID
- `JWT_SECRET` - JWT signing secret
- `ANTHROPIC_API_KEY` - Claude AI API key

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the ISC License - see the [LICENSE](LICENSE) file for details.
