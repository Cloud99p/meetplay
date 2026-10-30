/**
 * Content-Security-Policy, built once at boot from the real runtime
 * configuration.
 *
 * WHY this is a function and not a constant:
 *
 * The browser has to reach exactly three kinds of origin, and which ones
 * depends on env:
 *   1. its own API and WebSocket  -> 'self'
 *   2. the LiveKit media server   -> LIVEKIT_URL (wss://... in prod)
 *   3. recording playback         -> the signed S3/R2 URL is fetched from
 *                                    /api/rooms/:id/recap (same origin) and
 *                                    then played, so only media-src needs the
 *                                    bucket host, not connect-src.
 *
 * An earlier version shipped `connect-src 'self' wss: https:` with a comment
 * saying hostnames "cannot be known at build time". They can: they are known
 * at *server start*, which is when this runs. Allowing the bare `https:`
 * scheme meant a successful XSS on any page could POST data to any host on the
 * internet — the exact thing CSP exists to stop.
 *
 * FEATURES AND THE POLICIES THEY NEED (do not tighten blindly):
 *   - connect-src  self + LiveKit. The Deepgram socket is opened by the server
 *                  (see routes/stt.ts), never by the browser, so
 *                  api.deepgram.com must NOT appear here.
 *   - media-src    blob: for LiveKit remote tracks and canvas/audio mixing;
 *                  the bucket origin for pre-signed recording playback.
 *   - img-src      data:/blob: avatars and canvas game rendering.
 *   - style-src    'unsafe-inline' for inline layout styles in the SPA and
 *                  the before-paint theme script's documentElement attribute.
 *   - script-src   'self' only. This is the directive that stops stored XSS,
 *                  so it does NOT get 'unsafe-inline'. Vite emits external
 *                  module scripts in production, so 'self' is sufficient.
 *   - frame-ancestors 'none' duplicates X-Frame-Options for modern browsers.
 */

export interface CspInputs {
  /** LIVEKIT_URL as configured, e.g. wss://meetplay-x.livekit.cloud */
  livekitUrl: string;
  /** Public bucket/CDN base for recordings (S3_PUBLIC_BASE_URL / R2_PUBLIC_BASE_URL). Optional. */
  recordingBaseUrl: string;
}

/**
 * Reduce a URL to its CSP source expression: scheme + host + port.
 *
 * CSP matches sources by scheme/host/port, never by path, so
 * `wss://x.livekit.cloud/rtc` must become `wss://x.livekit.cloud`.
 * A LiveKit URL may also be configured as https:// (the SDK accepts both and
 * rewrites internally), so both the given scheme and its websocket sibling are
 * emitted — a wrong guess here breaks every call, which is a far worse failure
 * than one redundant source.
 *
 * Returns [] for empty/unparseable input so a half-configured deploy degrades
 * to 'self' instead of emitting a broken directive.
 */
export function toCspOrigin(rawUrl: string): string[] {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return [];
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return [];
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:' && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return [];
  }
  const host = parsed.host; // includes port when non-default
  const scheme = parsed.protocol.replace(':', '');
  const schemes =
    scheme === 'ws' ? ['ws', 'wss'] : scheme === 'wss' ? ['wss', 'ws'] : scheme === 'http' ? ['http', 'https'] : ['https', 'http'];
  return schemes.map((s) => `${s}://${host}`);
}

export function buildCsp(inputs: CspInputs): string {
  const connect = ["'self'", ...toCspOrigin(inputs.livekitUrl)];
  const media = ["'self'", 'blob:', ...toCspOrigin(inputs.recordingBaseUrl)];

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `media-src ${media.join(' ')}`,
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}
