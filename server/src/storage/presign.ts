/**
 * Pre-signed playback URLs for call recordings (Cloudflare R2 / B2 / S3).
 *
 * WHY: LiveKit egress uploads the file to a bucket WE own, and the recap page
 * needs to play it back. The cheap way is a public bucket (`pub-*.r2.dev` or a
 * custom domain) — but that makes every recording permanently world-readable
 * to anyone holding the URL, with no expiry. These are recordings of meetings,
 * including minors in a tutorial-centre pilot. So the bucket stays PRIVATE and
 * we mint a short-lived signed URL per view instead:
 *
 *   GET /api/rooms/:id/recap  ->  fresh signed URL, valid for N seconds
 *
 * The stored object key (`filepath` in room_recordings) is all that lives in
 * the database: no long-lived secret URL is persisted, and a shared recap link
 * can't be replayed against the bucket once the signature expires.
 *
 * `S3_PUBLIC_BASE_URL` is still honoured by the recording module as a fallback
 * for public buckets, but the presigner takes precedence wherever it applies.
 */

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { loadConfig, type S3RecordingConfig } from '../config.js';

/**
 * How long a generated playback link stays valid. Short by design: the recap
 * page gets a fresh one on every load, and a leaked URL dies quickly.
 */
const DEFAULT_TTL_SECONDS = 3600;

export function presignTtlSeconds(): number {
  const raw = Number(process.env.RECORDING_URL_TTL_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL_SECONDS;
  // S3 SigV4 caps expiry at 7 days.
  return Math.min(Math.floor(raw), 7 * 24 * 60 * 60);
}

let cachedClient: S3Client | null = null;
let cachedClientKey = '';

function clientFor(s3: S3RecordingConfig): S3Client {
  const key = `${s3.endpoint}|${s3.region}|${s3.accessKey}|${s3.forcePathStyle}|${s3.bucket}`;
  if (cachedClient && cachedClientKey === key) return cachedClient;
  cachedClient = new S3Client({
    // R2 wants "auto"; AWS derives its own endpoint from a real region.
    region: s3.region || 'auto',
    ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
    forcePathStyle: s3.forcePathStyle,
    credentials: { accessKeyId: s3.accessKey, secretAccessKey: s3.secret },
  });
  cachedClientKey = key;
  return cachedClient;
}

/**
 * Normalize whatever egress/db handed us into a bare object key.
 *
 * Accepts a stored object key (`meetplay/room-abc/1.ogg`), a leading-slash key,
 * an `s3://bucket/key` URI, or a full http(s) URL (egress returns one on some
 * deployments). The bucket segment is only stripped when we can PROVE it is a
 * bucket and not part of the key:
 *
 *   - `s3://bucket/...`            → bucket is explicit, strip the first segment
 *   - `https://<bucket>.host/...`  → virtual-host style, nothing to strip
 *   - `https://<S3 endpoint>/...`  → path-style, first segment IS the bucket
 *   - anything else (CDN / pub-*.r2.dev / bare key) → leave the path alone
 *
 * The last rule matters: our own keys start with the S3_PREFIX (`meetplay/`),
 * which is also the bucket name here — stripping a leading `meetplay/` from a
 * bare key would silently point every playback at a non-existent object.
 */
export function objectKeyFromFilepath(
  filepath: string,
  target: { bucket: string; endpoint?: string },
): string | null {
  const bucket = target.bucket ?? '';
  let raw = (filepath ?? '').trim();
  if (!raw) return null;

  const endpointHost = (() => {
    try {
      return target.endpoint ? new URL(target.endpoint).hostname : '';
    } catch {
      return '';
    }
  })();

  const stripBucketSegment = (path: string): string => {
    if (!bucket) return path;
    if (path === bucket) return ''; // the URL points at the bucket, not an object
    return path.startsWith(`${bucket}/`) ? path.slice(bucket.length + 1) : path;
  };

  if (raw.startsWith('s3://')) {
    const rest = raw.slice('s3://'.length);
    const slash = rest.indexOf('/');
    if (slash === -1) return null; // bucket only, no key
    raw = rest.slice(slash + 1);
    return raw.replace(/^\/+/, '') || null;
  }

  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    let path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const virtualHostStyle = bucket && url.hostname.startsWith(`${bucket}.`);
    const pathStyle = endpointHost && url.hostname === endpointHost;
    if (!virtualHostStyle && pathStyle) path = stripBucketSegment(path);
    return path || null;
  }

  // Bare object key (with or without a leading slash) — use it as-is.
  return raw.replace(/^\/+/, '') || null;
}

/**
 * Mint a signed GET URL for a stored recording. Returns null when recording
 * storage isn't configured (or the key is unusable) so callers can fall back
 * to a stored/public URL instead of rendering a broken player.
 */
export async function presignRecordingUrl(
  filepath: string | null | undefined,
): Promise<string | null> {
  const s3 = loadConfig().recordingS3;
  if (!s3 || !filepath) return null;

  const key = objectKeyFromFilepath(filepath, { bucket: s3.bucket, endpoint: s3.endpoint });
  if (!key) return null;

  try {
    return await getSignedUrl(
      clientFor(s3),
      new GetObjectCommand({ Bucket: s3.bucket, Key: key }),
      { expiresIn: presignTtlSeconds() },
    );
  } catch (e) {
    console.warn('[s3] presign failed:', (e as Error)?.message ?? e);
    return null;
  }
}

/**
 * Swap every recording's `downloadUrl` for a freshly signed one, keeping the
 * stored URL as a fallback when signing isn't possible. Used by both the recap
 * endpoint and the in-session stop response, so a URL is never persisted
 * long-lived and always plays.
 */
export async function withSignedRecordingUrls<
  T extends { filepath: string | null; downloadUrl: string | null },
>(recordings: T[] | undefined): Promise<(T & { urlExpiresIn: number | null })[] | undefined> {
  if (!recordings) return undefined;
  return Promise.all(
    recordings.map(async (r) => {
      const signed = await presignRecordingUrl(r.filepath);
      return {
        ...r,
        downloadUrl: signed ?? r.downloadUrl,
        urlExpiresIn: signed ? presignTtlSeconds() : null,
      };
    }),
  );
}
