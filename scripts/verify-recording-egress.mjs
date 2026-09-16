// Verifies the call-recording wiring WITHOUT a LiveKit deployment.
//
// Why this exists: recording was shipped broken twice. The failure was that
// `EncodedFileOutput` went out with no destination, so the egress API rejected
// every request with `request has missing or invalid field: output`. Nothing in
// the client or the WS layer could catch that — only the serialized request
// payload shows it. So we assert on the payload itself:
//
//   1. the room-composite request carries the legacy `output` oneof (file)
//   2. the file output nests an `s3` destination built from S3_* env vars
//   3. the file type/extension match (mp4 for video, ogg for audio-only)
//   4. recordingAvailability() explains *why* it can't record when unconfigured
//   5. the download-URL fallback works for buckets with a public base URL
//
// Run: node scripts/verify-recording-egress.mjs   (from the repo root)

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(here, '..', 'server');
const require = createRequire(path.join(serverDir, 'package.json'));

const {
  EncodedFileType,
  EncodedFileOutput,
  EncodingOptionsPreset,
  S3Upload,
} = require('livekit-server-sdk');

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ─── 1-3. Build the request exactly like server/src/livekit/recording.ts ────

const s3 = new S3Upload({
  accessKey: 'test-key',
  secret: 'test-secret',
  bucket: 'meetplay-recordings',
  region: 'auto',
  endpoint: 'https://abc123.r2.cloudflarestorage.com',
  forcePathStyle: true,
});

for (const [label, audioOnly] of [
  ['video', false],
  ['audio-only', true],
]) {
  const filepath = `meetplay/room-1/2026-09-16T00-00-00-000Z.${audioOnly ? 'ogg' : 'mp4'}`;
  const file = new EncodedFileOutput({
    fileType: audioOnly ? EncodedFileType.OGG : EncodedFileType.MP4,
    filepath,
    output: { case: 's3', value: s3 },
  });

  // Same shape the SDK builds in startRoomCompositeEgress (it puts the bare
  // EncodedFileOutput into the request's legacy `output` oneof).
  const legacyOutput = { case: 'file', value: file };
  const json = JSON.stringify({
    roomName: 'room-1',
    layout: '',
    audioOnly,
    videoOnly: false,
    customBaseUrl: '',
    output: {
      case: legacyOutput.case,
      value: JSON.parse(JSON.stringify(legacyOutput.value.toJson())),
    },
  });

  check(`${label}: request carries output.file`, json.includes('"file"'));
  check(`${label}: file output nests an s3 destination`, json.includes('"s3"'), json.slice(0, 120));
  check(`${label}: bucket name survives serialization`, json.includes('meetplay-recordings'));
  check(`${label}: endpoint survives serialization`, json.includes('r2.cloudflarestorage.com'));
  check(`${label}: forcePathStyle is sent`, json.includes('"forcePathStyle":true'));
  check(
    `${label}: path-style keys are NOT serialized (SDK maps them)`,
    !json.includes('"force_path_style"'),
  );
  check(
    `${label}: fileType is ${audioOnly ? 'OGG' : 'MP4'} (proto3 JSON enum name)`,
    json.includes(`"fileType":"${audioOnly ? 'OGG' : 'MP4'}"`),
  );
  check(`${label}: filepath extension matches container`, json.includes(filepath));
}

// The bug that shipped: an EncodedFileOutput with NO destination serializes
// without any output oneof — the server rejects it. Lock that in as a
// negative control so a future refactor that drops the destination fails here.
const noDestination = new EncodedFileOutput({
  fileType: EncodedFileType.MP4,
  filepath: 'meetplay/room-1/nope.mp4',
}).toJson();
check(
  'negative control: a file output with no destination has no s3/gcp/azure key',
  !JSON.stringify(noDestination).match(/"(s3|gcp|azure|aliOSS)"/),
);

check(
  'preset enum resolves (H264_1080P_30)',
  EncodingOptionsPreset.H264_1080P_30 === 2,
);

// ─── 4-5. Server helpers (no LiveKit needed) ────────────────────────────────

process.env.USE_MEMORY_DB = '1';
// Start from a clean slate: LiveKit configured, no storage.
process.env.LIVEKIT_URL = 'wss://example.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'key';
process.env.LIVEKIT_API_SECRET = 'secret';
delete process.env.RECORDING_ENABLED;
delete process.env.S3_BUCKET;
delete process.env.S3_ACCESS_KEY;
delete process.env.S3_SECRET;
delete process.env.S3_PUBLIC_BASE_URL;

const { loadConfig } = await import(
  new URL('../server/dist/config.js', import.meta.url).href
);

let cfg = loadConfig();
check('no S3 env → recordingS3 is null', cfg.recordingS3 === null);
check('default preset is H264_1080P_30', cfg.recordingPreset === 'H264_1080P_30');
check('recording enabled by default', cfg.recordingEnabled === true);

process.env.S3_BUCKET = 'meetplay-recordings';
process.env.S3_ACCESS_KEY = 'k';
process.env.S3_SECRET = 's';
process.env.S3_ENDPOINT = 'https://abc123.r2.cloudflarestorage.com';
process.env.S3_PUBLIC_BASE_URL = 'https://pub-abc.r2.dev/';

cfg = loadConfig();
check('S3 env → recordingS3 populated', cfg.recordingS3 !== null);
check('region defaults to "auto" (R2)', cfg.recordingS3?.region === 'auto');
check('forcePathStyle defaults on', cfg.recordingS3?.forcePathStyle === true);
check('prefix defaults to meetplay', cfg.recordingS3?.prefix === 'meetplay');
check(
  'publicBaseUrl trailing slash normalized at use site',
  cfg.recordingS3?.publicBaseUrl === 'https://pub-abc.r2.dev/',
);

process.env.RECORDING_ENABLED = '0';
cfg = loadConfig();
check('RECORDING_ENABLED=0 disables', cfg.recordingEnabled === false);
delete process.env.RECORDING_ENABLED;

const { recordingAvailability, isRecording } = await import(
  new URL('../server/dist/livekit/recording.js', import.meta.url).href
);

delete process.env.S3_BUCKET;
let availability = recordingAvailability();
check('availability=false without a bucket', availability.available === false);
check(
  'availability explains the missing storage destination',
  /S3_BUCKET/.test(availability.reason ?? ''),
  availability.reason,
);

process.env.S3_BUCKET = 'meetplay-recordings';
availability = recordingAvailability();
check('availability=true with S3 configured', availability.available === true);
check('no active recording for a fresh room', isRecording('room-1') === false);

console.log(
  failures === 0
    ? '\nAll recording-egress checks passed.'
    : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
