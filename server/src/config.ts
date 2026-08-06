/**
 * Central environment configuration for the MeetPlay server.
 *
 * ALL credentials and endpoints come from environment variables. There are
 * deliberately NO committed secrets here — set them in your deployment
 * platform (Railway/Render/Fly) or local `.env` (see `.env.example`).
 *
 * Required in production:
 *   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
 * Optional:
 *   JWT_SECRET       (defaults to a dev-only value — set a real one in prod!)
 *   DATABASE_URL     (omit / set USE_MEMORY_DB=1 for in-memory)
 *   RATE_LIMIT_MAX   (default 120 req/min)
 *   PORT             (injected by the platform; default 3001)
 */

export interface ServerConfig {
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  livekitHost: string;
  jwtSecret: string;
  deepgramApiKey: string;
  databaseUrl?: string;
  useMemoryDb: boolean;
  rateLimitMax: number;
  port: number;
  staticDir: string;
}

const env = process.env;

export function loadConfig(): ServerConfig {
  // LiveKit is optional at startup for dev/test in "text mode", but token
  // minting will fail with a clear error if keys are missing. We read them
  // here so the rest of the codebase never hardcodes a fallback.
  const livekitUrl = env.LIVEKIT_URL?.trim() ?? '';
  const livekitApiKey = env.LIVEKIT_API_KEY?.trim() ?? '';
  const livekitApiSecret = env.LIVEKIT_API_SECRET?.trim() ?? '';

  return {
    livekitUrl,
    livekitApiKey,
    livekitApiSecret,
    livekitHost: env.LIVEKIT_HOST?.trim() ?? 'localhost:7880',
    jwtSecret: env.JWT_SECRET?.trim() ?? 'meetplay-dev-secret', // dev-only default
    deepgramApiKey: env.DEEPGRAM_API_KEY?.trim() ?? '',
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    useMemoryDb: !env.DATABASE_URL || env.USE_MEMORY_DB === '1',
    rateLimitMax: Number(env.RATE_LIMIT_MAX ?? 120),
    port: Number(env.PORT ?? 3001),
    staticDir: env.STATIC_DIR ?? '',
  };
}

export function requireLiveKit(config: ServerConfig): {
  url: string;
  apiKey: string;
  apiSecret: string;
} {
  if (!config.livekitUrl || !config.livekitApiKey || !config.livekitApiSecret) {
    throw new Error(
      'LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY and ' +
        'LIVEKIT_API_SECRET in your environment (Railway) or .env.',
    );
  }
  return {
    url: config.livekitUrl,
    apiKey: config.livekitApiKey,
    apiSecret: config.livekitApiSecret,
  };
}
