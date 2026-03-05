# ── Stage 1: Build ──────────────────────────────────────────────
FROM node:20-slim AS build

WORKDIR /app

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy root package files first for layer caching
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY server/ server/
COPY client/ client/

# Build client (React SPA) and server (TypeScript → JS)
RUN npm run build

# ── Stage 2: Runtime ───────────────────────────────────────────
FROM node:20-slim AS runtime

WORKDIR /app

# Install runtime dependencies for better-sqlite3
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Copy built artifacts
COPY --from=build /app/server/dist/ server/dist/
COPY --from=build /app/client/dist/ client/dist/

# Copy package files and install production-only dependencies
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/

# Install build tools, do a production install (rebuilds native modules), then clean up
RUN apt-get update && apt-get install -y python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Create data directory for mounted database
RUN mkdir -p /data

# Environment
ENV NODE_ENV=production
ENV PORT=3001
ENV ENERGY_DB_PATH=/data/energy_dashboard.db

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3001/api/health || exit 1

CMD ["node", "server/dist/index.js"]
