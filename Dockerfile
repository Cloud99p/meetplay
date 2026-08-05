# MeetPlay — single-container deploy image.
#
# Runs the full stack in ONE container via the same orchestrator as local dev:
#   - Vite dev server  :5173  (proxies /api, /ws, /rtc to the backend/LiveKit)
#   - Fastify backend  :3001  (in-memory DB by default — zero external deps)
#   - LiveKit server   :7880  (auto-installed + started by scripts/dev.mjs)
#
# The browser only ever talks to :5173 — same-origin, no CORS, no WebSocket
# edge issues on hosts that support WS upgrades (Railway, Render, Fly, VPS).
#
# Deploy: point your PaaS at this Dockerfile and expose port 5173.
# For a production Postgres, set DATABASE_URL and USE_MEMORY_DB=0.

FROM node:20-slim

# curl + bash are needed by scripts/dev.mjs (LiveKit auto-install + probe)
RUN apt-get update && apt-get install -y --no-install-recommends curl bash \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
RUN npm ci

# Copy source
COPY . .

# The dev orchestrator is also the runtime orchestrator here: it starts
# backend + vite + (auto-installed) LiveKit and proxies everything through :5173.
EXPOSE 5173

# In-memory DB unless DATABASE_URL is provided
ENV USE_MEMORY_DB=1

CMD ["npm", "run", "dev"]
