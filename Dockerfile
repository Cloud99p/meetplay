# MeetPlay — production single-container image.
#
# Builds the frontend (vite build -> dist/) and runs the Fastify backend which
# serves: static frontend (SPA fallback) + REST API + WebSocket, all on ONE port.
# Browser talks to one origin — no CORS, no proxy, no WebSocket edge issues.
# LiveKit Cloud URL/key/secret are committed fallbacks (no .env needed).
#
# Deploy: point your PaaS (Railway/Render/Fly) at this Dockerfile.
# The server listens on $PORT (Railway injects it) at 0.0.0.0.

FROM node:20-slim

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
RUN npm ci

# Copy source
COPY . .

# Build the frontend -> dist/ and compile the server -> server/dist/
RUN npm run build && cd server && npx tsc -p tsconfig.json

# In-memory DB unless DATABASE_URL is provided
ENV USE_MEMORY_DB=1

# Server listens on $PORT (Railway injects it; default 3001)
EXPOSE 3001

CMD ["node", "server/dist/index.js"]
