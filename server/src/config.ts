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

/**
 * Parse an env override that may legitimately be **0** ("close every session",
 * "allow no sessions").
 *
 * `Number(v) || fallback` looks equivalent but is a trap: 0 is falsy, so a
 * deliberate 0 silently becomes the default — a guard that can't be tightened.
 * NaN and negatives fall back instead of coercing to something surprising.
 */
function envCount(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export interface ServerConfig {
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  livekitHost: string;
  jwtSecret: string;
  deepgramApiKey: string;
  deepgramModel: string;
  deepgramLanguage: string;
  /** Global kill switch for the Deepgram relay (STT_ENABLED=0). */
  sttEnabled: boolean;
  /** Hard caps for a single caption session — abuse/cost backstops, not metering. */
  sttMaxSessionSeconds: number;
  sttMaxAudioBytes: number;
  sttMaxConcurrent: number;
  sttMaxPerIp: number;
  databaseUrl?: string;
  useMemoryDb: boolean;
  rateLimitMax: number;
  port: number;
  staticDir: string;
  omnilearnUrl: string;
  omnilearnApiKey: string;
  omnilearnEnabled: boolean;
  /** Call recording (LiveKit Egress) — see S3RecordingConfig below. */
  recordingEnabled: boolean;
  recordingAudioOnly: boolean;
  recordingPreset: string;
  recordingS3: S3RecordingConfig | null;
}

/**
 * S3-compatible destination for egress recordings.
 *
 * Egress has NO managed storage: every EncodedFileOutput must name a
 * destination bucket (`output: { case: 's3' | 'gcp' | 'azure' | 'aliOSS' }`),
 * otherwise the API rejects the request with "missing or invalid field:
 * output". Cloudflare R2 / Backblaze B2 / MinIO all speak the S3 API, so a
 * single S3 config covers every free/cheap option:
 *
 *   Cloudflare R2 (10 GB free, no egress fees):
 *     S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
 *     S3_REGION=auto
 *     S3_FORCE_PATH_STYLE=1
 *     S3_PUBLIC_BASE_URL=https://pub-<hash>.r2.dev   (or a custom domain)
 *
 * `publicBaseUrl` is only used to build a download link when egress doesn't
 * return one itself (self-hosted/R2 setups return `filepath`, not a URL).
 */
export interface S3RecordingConfig {
  accessKey: string;
  secret: string;
  bucket: string;
  region: string;
  endpoint: string;
  forcePathStyle: boolean;
  /** Public bucket/CDN base URL used to build a download link. Optional. */
  publicBaseUrl: string;
  /** Object-key prefix inside the bucket (default 'meetplay'). */
  prefix: string;
}

const env = process.env;

/**
 * Production is anything that isn't the explicit dev/demo memory mode:
 * NODE_ENV=production, or a real DATABASE_URL without USE_MEMORY_DB=1.
 * In production a missing JWT_SECRET must be a HARD FAILURE — signing every
 * room token with the public 'meetplay-dev-secret' fallback would let anyone
 * forge host tokens (and the fallback string sits in this public repo).
 */
export function isProductionMode(): boolean {
  return (
    env.NODE_ENV === 'production' ||
    (Boolean(env.DATABASE_URL) && env.USE_MEMORY_DB !== '1')
  );
}

export function loadConfig(): ServerConfig {
  // LiveKit is optional at startup for dev/test in "text mode", but token
  // minting will fail with a clear error if keys are missing. We read them
  // here so the rest of the codebase never hardcodes a fallback.
  const livekitUrl = env.LIVEKIT_URL?.trim() ?? '';
  const livekitApiKey = env.LIVEKIT_API_KEY?.trim() ?? '';
  const livekitApiSecret = env.LIVEKIT_API_SECRET?.trim() ?? '';

  const jwtSecret = env.JWT_SECRET?.trim();
  if (isProductionMode() && !jwtSecret) {
    throw new Error(
      'JWT_SECRET is not set. Refusing to boot in production with the public ' +
        'dev fallback (it would let anyone forge room tokens). Set a strong ' +
        'random JWT_SECRET in your deployment environment.',
    );
  }

  return {
    livekitUrl,
    livekitApiKey,
    livekitApiSecret,
    livekitHost: env.LIVEKIT_HOST?.trim() ?? 'localhost:7880',
    jwtSecret: jwtSecret ?? 'meetplay-dev-secret', // dev/demo only — prod throws above
    deepgramApiKey: env.DEEPGRAM_API_KEY?.trim() ?? '',
    // flux-general-en (v2) is the default: turn-based with EagerEndOfTurn,
    // much lower latency than nova-2 during fast/continuous speech, and
    // diarization is not needed (every client transcribes only its own mic
    // and the server remaps speakers to the sender). nova-2 stays supported
    // via DEEPGRAM_MODEL for the diarized "Who Said That?" path.
    deepgramModel: env.DEEPGRAM_MODEL?.trim() ?? 'flux-general-en',
    // Language/variant for transcription. Deepgram supports regional English
    // variants — e.g. en-NG (Nigerian English), en-GB, en-US, en-IN — which
    // noticeably improve word accuracy for accented speech. Default 'en'
    // (generic) unless DEEPGRAM_LANGUAGE is set.
    deepgramLanguage: env.DEEPGRAM_LANGUAGE?.trim() ?? 'en',
    // ── Caption relay guards ──────────────────────────────────────────────
    // /api/stt is a credentialed Deepgram relay: anyone who can reach the URL
    // can spend the project's credits. These caps are backstops, not metering —
    // a tutorial is ≤45 min and a room is a handful of people, so the defaults
    // sit far above real use and only catch a runaway room or an outsider.
    // `|| default` also swallows a non-numeric env value.
    sttEnabled: env.STT_ENABLED !== '0',
    sttMaxSessionSeconds: envCount(env.STT_MAX_SESSION_SECONDS, 5400), // 90 min
    sttMaxAudioBytes: envCount(env.STT_MAX_AUDIO_BYTES, 209715200), // 200 MB (~1.7 h of PCM16)
    sttMaxConcurrent: envCount(env.STT_MAX_CONCURRENT, 60),
    // A classroom on one wifi/NAT shares an IP, so this stays generous:
    // 6 students on one network is 6 sessions from one address.
    sttMaxPerIp: envCount(env.STT_MAX_PER_IP, 30),
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    useMemoryDb: !env.DATABASE_URL || env.USE_MEMORY_DB === '1',
    rateLimitMax: Number(env.RATE_LIMIT_MAX ?? 120),
    port: Number(env.PORT ?? 3001),
    staticDir: env.STATIC_DIR ?? '',
    omnilearnUrl: env.OMNILEARN_URL?.trim() || 'http://localhost:8080',
    omnilearnApiKey: env.OMNILEARN_API_KEY?.trim() || '',
    omnilearnEnabled: env.OMNILEARN_ENABLED !== '0',
    // RECORDING_ENABLED=0 force-disables. Otherwise recording is "on" as
    // soon as a storage destination exists (checked in recording.ts) —
    // the button simply fails with a clear reason when S3 is missing.
    recordingEnabled: env.RECORDING_ENABLED !== '0',
    // Audio-only recording (OGG/Opus) skips the video pipeline entirely:
    // far cheaper, tiny files, and a transcript-friendly artifact. Video is
    // the default because the recap page plays it back inline.
    recordingAudioOnly: env.RECORDING_AUDIO_ONLY === '1',
    recordingPreset: env.RECORDING_PRESET?.trim() || 'H264_1080P_30',
    recordingS3: readS3Config(),
  };
}

/**
 * Read the S3-compatible recording destination from the environment.
 * Returns null unless the minimum (bucket + key + secret) is present, so a
 * half-configured deployment degrades to "recording unavailable" instead of
 * a confusing egress failure.
 */
function readS3Config(): S3RecordingConfig | null {
  const bucket = env.S3_BUCKET?.trim() ?? '';
  // Accepted names, in order. The last two are Cloudflare's own field labels
  // ("Access Key ID" / "Secret Access Key") — people paste those straight into a
  // Railway/Vercel env form, and a silently missing credential just disables
  // recording with no hint about which variable is wrong.
  const accessKey =
    (env.S3_ACCESS_KEY ?? env.S3_ACCESS_KEY_ID ?? env.Access_Key_ID)?.trim() ?? '';
  const secret =
    (env.S3_SECRET ?? env.S3_SECRET_ACCESS_KEY ?? env.Secret_Access_Key)?.trim() ?? '';
  if (!bucket || !accessKey || !secret) return null;
  return {
    accessKey,
    secret,
    bucket,
    // R2 ignores region but the AWS SDK needs *something*; 'auto' is R2's
    // documented placeholder and is harmless on real AWS when S3_REGION is set.
    region: env.S3_REGION?.trim() || 'auto',
    endpoint: env.S3_ENDPOINT?.trim() || '',
    // Path-style is required by R2/MinIO; AWS accepts it too. Default on
    // unless explicitly disabled.
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== '0',
    publicBaseUrl: (env.S3_PUBLIC_BASE_URL ?? env.R2_PUBLIC_BASE_URL)?.trim() || '',
    prefix: env.S3_PREFIX?.trim().replace(/^\/+|\/+$/g, '') || 'meetplay',
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
