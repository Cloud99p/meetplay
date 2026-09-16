/**
 * Verifies pre-signed recording playback URLs — offline, no bucket needed.
 *
 * Why this exists: the alternative to a private bucket is a public one, and a
 * public recording URL is a permanent, unauthenticated link to a meeting (with
 * minors in it, for the pilot). So the bucket stays private and the server
 * signs short-lived GET URLs. Two things must therefore be true and stay true:
 *
 *   1. signing is used (a signature + expiry in the URL), not a plain public link
 *   2. the object key is derived correctly from whatever egress/db stored —
 *      a bare key, a leading-slash key, an s3:// URI, or a full https URL
 *
 * Run: npx tsx scripts/verify-presign.ts   (from the repo root)
 */

import assert from 'node:assert';

// Must be set before config is read. No DATABASE_URL => not "production mode",
// so the JWT_SECRET guard doesn't fire; set it anyway for realism.
process.env.JWT_SECRET ??= 'presign-test-secret';

let failures = 0;
function check(name: string, cond: unknown, detail = ''): void {
  const ok = Boolean(cond);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const { objectKeyFromFilepath, presignRecordingUrl, presignTtlSeconds, withSignedRecordingUrls } =
  await import('../server/src/storage/presign.js');

const BUCKET = 'meetplay';
const ENDPOINT = 'https://180ee06ec7d6cd691572770a02c0e130.r2.cloudflarestorage.com';
/** The stored object key: S3_PREFIX + room + filename (prefix defaults to the
 *  bucket name here, which is exactly the ambiguity these checks lock down). */
const KEY = 'meetplay/room-abc/2026-09-16T14-00-00-000Z.ogg';
const T = { bucket: BUCKET, endpoint: ENDPOINT };

// ─── 1. Not configured → no URL (callers must fall back) ───────────────────
for (const k of ['S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET']) delete process.env[k];
check('unconfigured: presignRecordingUrl() returns null', (await presignRecordingUrl(KEY)) === null);

// ─── 2. Key extraction ────────────────────────────────────────────────────
check('key: stored key passes through untouched', objectKeyFromFilepath(KEY, T) === KEY);
check('key: leading slashes stripped', objectKeyFromFilepath('/' + KEY, T) === KEY);
check(
  'key: s3://bucket/key URI drops the explicit bucket',
  objectKeyFromFilepath(`s3://${BUCKET}/${KEY}`, T) === KEY,
);
check(
  'key: path-style endpoint URL drops the bucket segment',
  objectKeyFromFilepath(`${ENDPOINT}/${BUCKET}/${KEY}`, T) === KEY,
);
check(
  'key: virtual-host style URL keeps the whole path',
  objectKeyFromFilepath(`https://${BUCKET}.abc123.r2.cloudflarestorage.com/${KEY}`, T) === KEY,
);
check(
  'key: public/CDN URL path is left alone (never strips the key prefix)',
  objectKeyFromFilepath(`https://pub-abc123.r2.dev/${KEY}`, T) === KEY,
);
check('key: empty input → null', objectKeyFromFilepath('', T) === null);
check('key: bucket-only URL → null', objectKeyFromFilepath(`${ENDPOINT}/${BUCKET}`, T) === null);
check('key: s3:// bucket-only URI → null', objectKeyFromFilepath(`s3://${BUCKET}`, T) === null);

// ─── 3. Configure a bucket and sign ───────────────────────────────────────
process.env.S3_BUCKET = BUCKET;
process.env.S3_ACCESS_KEY = 'test-access-key';
process.env.S3_SECRET = 'test-secret-key';
process.env.S3_ENDPOINT = ENDPOINT;
process.env.S3_REGION = 'auto';
process.env.S3_FORCE_PATH_STYLE = '1';
process.env.RECORDING_URL_TTL_SECONDS = '900';

const url = await presignRecordingUrl(KEY);
check('configured: a URL is produced', typeof url === 'string' && url.length > 0);

const u = new URL(url!);
check('signed: hits the R2 endpoint host', u.host === new URL(ENDPOINT).host, u.host);
check(
  'signed: path-style keeps the bucket in the path',
  u.pathname === `/${BUCKET}/${KEY}`,
  u.pathname,
);
check('signed: SigV4 algorithm present', u.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256');
check('signed: signature present', (u.searchParams.get('X-Amz-Signature') ?? '').length === 64);
check(
  'signed: credential names the access key (never the secret)',
  (u.searchParams.get('X-Amz-Credential') ?? '').startsWith('test-access-key/'),
);
check('signed: secret never appears in the URL', !url!.includes('test-secret-key'));
check('signed: expiry honours RECORDING_URL_TTL_SECONDS', u.searchParams.get('X-Amz-Expires') === '900');
check('signed: expiry reported as 900s', presignTtlSeconds() === 900);

// ─── 4. TTL handling ──────────────────────────────────────────────────────
process.env.RECORDING_URL_TTL_SECONDS = '999999999';
check('ttl: clamped to the 7-day SigV4 maximum', presignTtlSeconds() === 7 * 24 * 60 * 60);
process.env.RECORDING_URL_TTL_SECONDS = 'nonsense';
check('ttl: invalid value falls back to the 1h default', presignTtlSeconds() === 3600);
process.env.RECORDING_URL_TTL_SECONDS = '900';

// ─── 5. A different key yields a different signature ──────────────────────
const other = new URL((await presignRecordingUrl('meetplay/room-xyz/other.ogg'))!);
check(
  'different object → different signature',
  other.searchParams.get('X-Amz-Signature') !== u.searchParams.get('X-Amz-Signature'),
);
check('different object → keeps its own key', other.pathname.endsWith('room-xyz/other.ogg'));

// ─── 6. Recap helper: signs what it can, preserves stored URL otherwise ───
const recs = await withSignedRecordingUrls([
  { filepath: KEY, downloadUrl: null },
  { filepath: null, downloadUrl: 'https://example.test/legacy.mp4' },
]);
check('recap: signs the playable recording', recs?.[0].downloadUrl?.includes('X-Amz-Signature') === true);
check('recap: reports the expiry for the UI', recs?.[0].urlExpiresIn === 900);
check(
  'recap: keeps the stored URL when there is no key to sign',
  recs?.[1].downloadUrl === 'https://example.test/legacy.mp4' && recs?.[1].urlExpiresIn === null,
);
check('recap: undefined stays undefined (never recorded)', (await withSignedRecordingUrls(undefined)) === undefined);

// ─── 7. Cloudflare's own field labels are accepted as credential names ────
// Pasting "Access Key ID" / "Secret Access Key" verbatim into a hosting env form
// is an easy mistake, and it silently disables recording with no clue as to why.
const { loadConfig } = await import('../server/src/config.js');
delete process.env.S3_ACCESS_KEY;
delete process.env.S3_SECRET;
process.env.Access_Key_ID = 'cf-label-key';
process.env.Secret_Access_Key = 'cf-label-secret';
const aliasCfg = loadConfig().recordingS3;
check('alias: Access_Key_ID / Secret_Access_Key configure storage', aliasCfg !== null);
const aliasUrl = await presignRecordingUrl(KEY);
check(
  'alias: the aliased access key signs URLs',
  (aliasUrl ?? '').includes('cf-label-key'),
);
// Restore the canonical names for anything that runs after this.
process.env.S3_ACCESS_KEY = 'test-access-key';
process.env.S3_SECRET = 'test-secret-key';
delete process.env.Access_Key_ID;
delete process.env.Secret_Access_Key;

// ─── 8. Missing the bucket is the one thing that cannot be aliased ────────
delete process.env.S3_BUCKET;
check('no bucket → storage not configured (recording disabled)', loadConfig().recordingS3 === null);
process.env.S3_BUCKET = BUCKET;

console.log(failures === 0 ? '\nAll presign checks passed.' : `\n${failures} check(s) failed.`);
assert.ok(failures === 0, 'presign verification failed');
process.exit(failures === 0 ? 0 : 1);
