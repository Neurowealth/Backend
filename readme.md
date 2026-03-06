
# NeuroWealth — Backend

About
-----
NeuroWealth is an autonomous AI investment agent that automatically manages and grows users' crypto assets on the Stellar blockchain. Deposit once, the AI finds the best yield opportunities across Stellar's DeFi ecosystem; users can withdraw anytime with no lock-ups.

This repository contains the backend API (Express + TypeScript), Stellar integration, Prisma schema and migrations, and utilities for authentication (Stellar signature challenge + JWT sessions).

Quickstart
----------
1. Copy the example environment file and adjust secrets:

```powershell
copy .env.example .env
```

2. Edit `.env` and set secure values:
- `DATABASE_URL` — PostgreSQL connection string (see below)
- `DB_NAME`, `DB_PASSWORD` — used by `docker-compose.yml` when running Postgres locally
- `JWT_SEED` — 64-hex secret (generate with `openssl rand -hex 64`)
- `WALLET_ENCRYPTION_KEY` — 32-byte hex (generate with `openssl rand -hex 32`)

Docker (Postgres)
------------------
To run a local Postgres instance used by the project:

```powershell
docker compose up -d
docker compose ps
docker compose logs anylistDB --tail 200
```

The `docker-compose.yml` expects these env vars (set them in your `.env`):

```
DB_NAME=neurowealth
DB_PASSWORD=postgres_password_here
DATABASE_URL=postgresql://postgres:postgres_password_here@localhost:5432/neurowealth
```

Prisma & Database migrations
----------------------------
Generate the Prisma client (run after any `schema.prisma` change):

```bash
npx prisma generate
```

Create and apply a migration (development):

```bash
npx prisma migrate dev --name init
```

Notes:
- `migrate dev` will create a new migration in `prisma/migrations/` and apply it to the database specified by `DATABASE_URL`.
- To reset a development database (WARNING: destroys data):

```bash
npx prisma migrate reset
# or if your Prisma version requires preview option
npx prisma migrate reset --preview-feature
```

Apply migrations in production (use CI or a deployment task):

```bash
npx prisma migrate deploy
```

Seeding
-------
If you have a seed script (see `prisma/seed.ts`), run:

```bash
npx prisma db seed
```

Running the backend
-------------------
Development (with ts-node + nodemon):

```bash
npm install
npm run dev
```

Build and run:

```bash
npm run build
npm start
```

Testing
-------
Run unit tests (Jest):

```bash
npm test
```

Auth overview (short)
---------------------
- `POST /api/auth/challenge` — client posts `stellarPubKey`, server returns a one-time `nonce`.
- Client signs `nonce` with their Stellar key (Freighter) and sends signature to `POST /api/auth/verify`.
- Server verifies signature, creates user if missing, issues JWT (stored as a session in DB).
- Protected endpoints require `Authorization: Bearer <token>` and are validated against the `sessions` table; logout removes the session.

Troubleshooting
---------------
- If the app logs `Cannot connect to database`, check `DATABASE_URL`, and that Postgres is running (Docker or external).
- If migrating fails, confirm the DB user has permission to CREATE/ALTER tables.
- Ensure `JWT_SEED` and `WALLET_ENCRYPTION_KEY` are set when running the server.
