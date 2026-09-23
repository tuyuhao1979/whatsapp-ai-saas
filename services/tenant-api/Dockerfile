FROM node:20-alpine AS builder
WORKDIR /app

# openssl is required so `prisma generate` can resolve the OpenSSL 3 engine
# (see binaryTargets in prisma/schema.prisma).
RUN apk add --no-cache openssl

# Install dependencies first for better layer caching
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

# Generate Prisma client
COPY prisma ./prisma
RUN pnpm exec prisma generate

# Build TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ---------------------------------------------------------------------------
# Runtime image — no devDependencies, no TypeScript compiler
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# libssl is what the Prisma query engine links against at runtime; without it
# the container exits immediately with "Error loading shared library
# libssl.so.1.1". wget is used by the HEALTHCHECK below.
RUN apk add --no-cache openssl

# Copy production artifacts only
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY package.json ./

# Run as non-root for security
USER node

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/v1/healthz || exit 1

CMD ["node", "dist/server.js"]
