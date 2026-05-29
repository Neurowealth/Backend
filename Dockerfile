# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies (including devDependencies needed for tsc + prisma generate)
COPY package*.json ./
RUN npm ci

# Generate Prisma client (requires schema but not a live DB)
COPY prisma ./prisma
RUN npx prisma generate

# Compile TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune dev dependencies — only production deps go into the runtime image
RUN npm ci --omit=dev

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Least-privilege user
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Copy compiled output, production node_modules, and Prisma artefacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY package.json ./

USER app

EXPOSE 3001

# Run migrations then start the server.
# In Kubernetes use an initContainer for the migrate step so rollout is atomic.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
