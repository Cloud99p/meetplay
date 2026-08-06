# MeetPlay — production single-container image.
#
# Builds the frontend (vite build -> dist/) and runs the Fastify backend which
# serves: static frontend (SPA fallback) + REST API + WebSocket, all on ONE port.
# Browser talks to one origin — no CORS, no proxy, no WebSocket edge issues.
#
# ALL configuration comes from environment variables (see .env.example).
# Server-side vars (LIVEKIT_*, JWT_SECRET, DATABASE_URL) are read at runtime.
# Client-side vars (VITE_*) are baked into the bundle at BUILD time — pass them
# as build args (Railway/Render inject env vars into docker builds automatically).
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

# --- Client build-time env (baked into the frontend bundle) ---
# VITE_STT_MODE=mock|webspeech|deepgram
# VITE_LIVEKIT_URL=wss://... (optional client-side LiveKit override)
# VITE_SERVER_URL=https://... (optional server override for the frontend)
# NOTE: DEEPGRAM_API_KEY is SERVER-side (read at runtime by the /api/stt
# proxy) — set it as a runtime env var, NOT a build arg.
ARG VITE_STT_MODE=mock
ARG VITE_LIVEKIT_URL=
ARG VITE_SERVER_URL=
ENV VITE_STT_MODE=$VITE_STT_MODE \
    VITE_LIVEKIT_URL=$VITE_LIVEKIT_URL \
    VITE_SERVER_URL=$VITE_SERVER_URL

# Build the frontend -> dist/ and compile the server -> server/dist/
RUN npm run build && cd server && npx tsc -p tsconfig.json

# In-memory DB unless DATABASE_URL is provided
ENV USE_MEMORY_DB=1

# Server listens on $PORT (Railway injects it; default 3001)
EXPOSE 3001

CMD ["node", "server/dist/index.js"]
