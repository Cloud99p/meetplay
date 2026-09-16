/**
 * Live check: proves the configured recording bucket is reachable and usable
 * with the credentials in the environment — BEFORE a real session depends on it.
 *
 * What it does (all on a throwaway key under `<prefix>/_healthcheck/`):
 *   1. PutObject   — can we write? (egress uploads need this)
 *   2. HeadObject  — is the object really there?
 *   3. presign+GET — does a signed playback URL actually fetch the bytes?
 *   4. signature  — a bogus key returns 404 (NoSuchKey), NOT 403
 *                   (a 403 means the signature/credentials are wrong)
 *   5. DeleteObject — cleans up, and proves delete works (lifecycle does this later)
 *
 * Usage (from the repo root):
 *   node --env-file=.env scripts/verify-r2-live.mjs
 * or with the S3_* vars already in the environment.
 *
 * It writes and deletes ONE small text object; nothing else is touched.
 * Credentials are never printed.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const bucket = process.env.S3_BUCKET?.trim();
const accessKey = (process.env.S3_ACCESS_KEY ?? process.env.S3_ACCESS_KEY_ID)?.trim();
const secret = (process.env.S3_SECRET ?? process.env.S3_SECRET_ACCESS_KEY)?.trim();
const endpoint = process.env.S3_ENDPOINT?.trim() || undefined;
const region = process.env.S3_REGION?.trim() || 'auto';
const forcePathStyle = process.env.S3_FORCE_PATH_STYLE !== '0';
const prefix = process.env.S3_PREFIX?.trim().replace(/^\/+|\/+$/g, '') || 'meetplay';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
}

if (!bucket || !accessKey || !secret) {
  console.error('Missing S3_BUCKET / S3_ACCESS_KEY / S3_SECRET (use --env-file=.env)');
  process.exit(1);
}

console.log(`Bucket:   ${bucket}`);
console.log(`Endpoint: ${endpoint ?? '(AWS default for ' + region + ')'}`);
console.log(`Style:    ${forcePathStyle ? 'path-style' : 'virtual-host'}`);
console.log(`Prefix:   ${prefix}\n`);

const client = new S3Client({
  region,
  ...(endpoint ? { endpoint } : {}),
  forcePathStyle,
  credentials: { accessKeyId: accessKey, secretAccessKey: secret },
});

const key = `${prefix}/_healthcheck/${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
const body = `meetplay healthcheck ${new Date().toISOString()}\n`;

try {
  // 1. write
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'text/plain' }));
    check('PutObject succeeds (this is what egress needs)', true, key);
  } catch (e) {
    check('PutObject succeeds (this is what egress needs)', false, e.message);
    throw e;
  }

  // 2. head
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    check(
      'HeadObject sees the object',
      head.ContentLength === Buffer.byteLength(body),
      `${head.ContentLength} bytes`,
    );
  } catch (e) {
    check('HeadObject sees the object', false, e.message);
  }

  // 3. presigned GET — the exact mechanism the recap page uses.
  // NB: keep the expiry generous. A locally skewed clock (>1 min ahead) makes a
  // short-lived signature look already expired (R2 answers `ExpiredRequest`),
  // which is a property of whoever GENERATES the URL — in production that's the
  // server, whose clock is NTP-synced.
  const signedUrl = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 300 },
  );
  const res = await fetch(signedUrl);
  const text = await res.text();
  check('presigned GET returns 200', res.status === 200, `status=${res.status}`);
  check('presigned GET returns the exact bytes', text === body);
  check('signed URL carries a signature', signedUrl.includes('X-Amz-Signature'));
  console.log(`      signed URL host: ${new URL(signedUrl).host}`);

  // 4. A missing key must NOT be readable, and the rejection must come from
  // "no such object" rather than "bad signature" — a SignatureDoesNotMatch
  // would mean the credentials/format are wrong and every playback would fail.
  const bogus = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: `${prefix}/_healthcheck/does-not-exist-${Date.now()}` }),
    { expiresIn: 300 },
  );
  const bogusRes = await fetch(bogus);
  const bogusBody = await bogusRes.text();
  const bogusCode = /<Code>([^<]+)<\/Code>/.exec(bogusBody)?.[1] ?? '';
  check(
    'missing key → 404 (not 403): credentials and signature are valid',
    bogusRes.status === 404 && !/SignatureDoesNotMatch/i.test(bogusBody),
    `status=${bogusRes.status}${bogusCode ? ` code=${bogusCode}` : ''}`,
  );

  // 5. delete + confirm gone
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  const after = await fetch(signedUrl);
  check('DeleteObject removes it (signed GET now 404)', after.status === 404, `status=${after.status}`);
} catch (e) {
  console.error('\nAborted:', e?.message ?? e);
  process.exitCode = 1;
} finally {
  client.destroy();
}

console.log(failures === 0 ? '\nBucket is ready for recording.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? process.exitCode ?? 0 : 1;
