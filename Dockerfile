FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

# tsconfig.build.json is what `npm run build` compiles with (package.json:9),
# and prebuild copies docs/openapi.yaml into dist/docs (package.json:38), so
# both must be present before the build runs (#791).
COPY tsconfig.json tsconfig.build.json ./
COPY docs/openapi.yaml ./docs/openapi.yaml
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime

RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

USER app

EXPOSE 3001

# `prisma` is a runtime dependency at the same version as @prisma/client
# (package.json), so `--no-install` never reaches the network at container
# start and the CLI can never drift to a mismatched major (#792).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "npx --no-install prisma migrate deploy && node dist/index.js"]
