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
 *   - img-src      data:/blob: avatars and canvas game rendering, PLUS the
 *                  Clerk image proxy. Clerk serves every user's picture from
 *                  `img.clerk.com` (a proxy that re-hosts the Google/GitHub
 *                  avatar), so without that origin the <img> is silently
 *                  blocked and every user falls back to initials while the
 *                  console fills with CSP violations. Not derived from the
 *                  publishable key: the image proxy host is fixed and shared
 *                  by all Clerk instances, unlike the frontend-API origin.
 *   - style-src    'unsafe-inline' for inline layout styles in the SPA and
 *                  the before-paint theme script's documentElement attribute.
 *                  Plus the Google Fonts stylesheet origin: fonts are
 *                  requested by an @import/link in the served HTML, so the
 *                  stylesheet itself must be allowed here as well as the font
 *                  files in font-src.
 *   - font-src     'self' data: plus the Google Fonts file origins.
 *   - script-src   'self' plus the Clerk origin when accounts are on. Clerk
 *                  loads `clerk.browser.js` from its own frontend-API domain
 *                  (`<slug>.clerk.accounts.dev` in dev, the custom domain in
 *                  prod) and will not initialise without it. That origin is
 *                  derived from the publishable key, never hard-coded.
 *                  ALSO blob: — AudioWorklet modules are loaded from a blob
 *                  URL constructed at runtime, and browsers check worklet
 *                  loading against script-src, NOT worker-src (worker-src
 *                  covers Worker/SharedWorker). Without blob: here the worklet
 *                  is refused and the STT adapter falls back to the deprecated
 *                  ScriptProcessorNode, which runs the audio callback on the
 *                  main thread — degrading caption timing. blob: does not
 *                  meaningfully widen the XSS surface: creating a blob script
 *                  already requires script execution.
 *                  NOTE: still no 'unsafe-inline' — Clerk's script is
 *                  external, so allowing its origin keeps the XSS guarantee.
 *                  This directive is what stops stored XSS, so it still does
 *                  NOT get 'unsafe-inline'; Vite emits external module scripts.
 *   - frame-ancestors 'none' duplicates X-Frame-Options for modern browsers.
 *
 * The theme script in index.html is inline, so it is pinned by SHA-256 in
 * script-src rather than allowed with 'unsafe-inline'. The hash is computed
 * from the built HTML at boot (see themeScriptHash), so editing that script
 * cannot silently break the policy or silently disable it.
 */

import crypto from 'node:crypto';

export interface CspInputs {
  /** LIVEKIT_URL as configured, e.g. wss://meetplay-x.livekit.cloud */
  livekitUrl: string;
  /** Public bucket/CDN base for recordings (S3_PUBLIC_BASE_URL / R2_PUBLIC_BASE_URL). Optional. */
  recordingBaseUrl: string;
  /** CLERK_PUBLISHABLE_KEY as configured, server side. Optional. */
  clerkPublishableKey?: string;
  /** SHA-256 of the inline theme script in the served HTML, e.g. "sha256-abc...". Optional. */
  themeScriptHash?: string;
}

/** Google Fonts serves the stylesheet and the font files from two hosts. */
const GOOGLE_FONT_HOSTS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

/**
 * Clerk's image proxy. Every Clerk-hosted avatar (an OAuth picture re-hosted
 * by Clerk) is served from here, so it must be allowed for images whenever
 * accounts are configured. Fixed host, not derived from the key.
 */
const CLERK_IMAGE_HOSTS = ['https://img.clerk.com'];

/**
 * Resolve the Clerk frontend-API origin from a publishable key.
 *
 * Clerk publishable keys are `pk_test_<base64(host + '$')>`; the encoded part
 * decodes to the exact host that serves `clerk.browser.js`. In production the
 * same encoding carries the custom domain, so this works for both without a
 * second env var. Returns [] when the key is absent or unparseable, which
 * simply leaves script-src at 'self'.
 */
export function clerkOrigin(publishableKey: string): string[] {
  const key = publishableKey?.trim();
  if (!key) return [];
  const encoded = key.replace(/^pk_(test|live)_/, '');
  if (!encoded || encoded === key) return [];
  try {
    // atob exists in Node 16+; the '-'/'_' alphabet is converted first because
    // some keys are emitted base64url rather than plain base64.
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const host = decoded.replace(/\$$/, '').trim();
    if (!/^[a-z0-9.-]+$/i.test(host)) return [];
    return [`https://${host}`];
  } catch {
    return [];
  }
}

/**
 * Reduce a URL to its CSP source expression: scheme + host + port.
 *
 * CSP matches sources by scheme/host/port, never by path, so
 * `wss://x.livekit.cloud/rtc` must become `wss://x.livekit.cloud`.
 *
 * WHY ALL FOUR SCHEMES (`wss ws https http`) FOR A LIVEKIT HOST:
 *
 * A LiveKit URL is configured as wss:// (or https://), but the browser SDK
 * speaks BOTH transports to that same host:
 *   - the signal channel is a WebSocket                  -> wss:
 *   - `POST /rtc/validate` and the ICE callbacks are
 *     ordinary `fetch()` calls over HTTPS                -> https:
 * CSP treats `wss:` and `https:` as distinct sources, so emitting only the
 * websocket sibling leaves `/rtc/validate` blocked. In production that showed
 * up as "connect-src ... blocked" followed by "The media server is not running
 * or unreachable" and a call that never connected — while the server-side
 * LiveKit probe reported healthy, because the block was browser-side only.
 *
 * Emitting the http(s) sibling is not a widening of trust: it is the same
 * origin (same host, same port) that script-src/connect-src already reach over
 * the websocket. A redundant source costs nothing; a missing one breaks every
 * call.
 *
 * The http:/ws: forms are included for local/self-hosted LiveKit (plain
 * http://host:7880 on a LAN), where browsers require the exact scheme.
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
  // Every sibling scheme for the same origin — see the note above on why the
  // http(s) form is mandatory even when the configured URL is wss://.
  const schemes = scheme === 'ws' || scheme === 'wss' ? ['wss', 'ws', 'https', 'http'] : ['https', 'http', 'wss', 'ws'];
  return schemes.map((s) => `${s}://${host}`);
}

export function buildCsp(inputs: CspInputs): string {
  const clerk = clerkOrigin(inputs.clerkPublishableKey ?? '');
  // Clerk is a live API client, not just a script host: it XHRs its own origin
  // (/v1/dev_browser, /v1/client, token refresh) on boot and on every session
  // change, so the same origin must appear in connect-src as well as
  // script-src. Omitting it here makes Clerk fail with an opaque "Failed to
  // fetch" and silently leaves the app in guest mode.
  const connect = ["'self'", ...toCspOrigin(inputs.livekitUrl), ...clerk];
  const media = ["'self'", 'blob:', ...toCspOrigin(inputs.recordingBaseUrl)];
  const scriptSrc = ["'self'", 'blob:', ...clerk];
  if (inputs.themeScriptHash) scriptSrc.push(`'${inputs.themeScriptHash}'`);
  // Only widen img-src when accounts are on: with no Clerk there is nothing
  // to load from the proxy, and an unused origin is one more allowed host.
  const imgSrc = ["'self'", 'data:', 'blob:', ...(clerk.length ? CLERK_IMAGE_HOSTS : [])];

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    `style-src 'self' 'unsafe-inline' ${GOOGLE_FONT_HOSTS[0]}`,
    "img-src " + imgSrc.join(' '),
    `media-src ${media.join(' ')}`,
    `font-src 'self' data: ${GOOGLE_FONT_HOSTS[1]}`,
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self' blob:",
    `frame-src 'self' ${clerk.join(' ')}`.trim(),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * Extract the inline `<script>` blocks from the served HTML and hash them for
 * script-src.
 *
 * The theme script must run before first paint, so it cannot become a separate
 * file; that makes a CSP hash the only way to allow it without
 * 'unsafe-inline'. Hashing the *served* HTML (rather than a copy of the source)
 * means a stale hard-coded hash can never mismatch — and if the script is
 * edited, the hash changes with it.
 *
 * Vite's production build injects no inline scripts of its own, but any that
 * appear are included, so this stays correct if the build changes.
 */
export function themeScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const body = m[1];
    if (!body.trim()) continue;
    const digest = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
    hashes.push(`sha256-${digest}`);
  }
  return hashes;
}
