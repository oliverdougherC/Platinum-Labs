# syntax=docker/dockerfile:1

# Multi-stage production image for the Homelab Homepage (PLA-196).
#
# The app is a long-running Node server: it holds in-process timers (connector
# scheduler, aggregate loop, hourly maintenance) and last-known-good state, so it
# expects a persistent process — it is NOT stateless/serverless.
#
# `better-sqlite3` is a native addon; it is compiled in the `deps` stage against
# the same Node/OS as the runner, then carried through Next's standalone output.

# ---- deps: install and compile node_modules (incl. native better-sqlite3) ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Build toolchain for better-sqlite3's native compile.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# ---- builder: produce the standalone Next build ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner: minimal image with only what the server needs ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    HOMELAB_DB_PATH=/data/homelab.db

# Non-root runtime user; owns the persistent data dir.
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs \
    && mkdir -p /data && chown -R nextjs:nodejs /data

# Standalone server + the static assets it does not inline.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000
VOLUME ["/data"]

# Liveness probe — 200 while the process can serve requests (connector outages
# do not fail this by design).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
