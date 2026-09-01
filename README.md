# Neurowealth Backend

API backend for Neurowealth - a financial planning and investment platform.

## Quickstart

1. Copy `.env.example` to `.env` and fill in the required values.
2. Start the database via Docker Compose: `docker-compose up -d`
3. Run migrations: `npx prisma migrate deploy`
4. Start the development server: `npm run dev`

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start development server with nodemon |
| `npm test` | Run all tests |
| `npm run test:unit` | Run unit tests only |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run TypeScript type check |
| `npm run build` | Build the TypeScript project |

## Environment Variables

See `.env.example` for all required environment variables, including:

- `DATABASE_URL` - PostgreSQL connection string
- `STELLAR_NETWORK` - testnet or mainnet
- `STELLAR_AGENT_SECRET_KEY` - Stellar secret key
- `VAULT_CONTRACT_ID` - deployed vault contract ID
- `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER`, `DB_PASSWORD`
- `JWT_SECRET`, `REFRESH_TOKEN_SECRET`
- And more...

## Documentation

- Full documentation is available in the [docs/](docs/) folder
- Start with [DOCUMENTATION_INDEX.md](docs/DOCUMENTATION_INDEX.md)
- Key guides: [DEPLOYMENT.md](docs/DEPLOYMENT.md), [QUICK_REFERENCE.md](docs/QUICK_REFERENCE.md)

## Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Docker & Docker Compose (for local development)