# Call recording (LiveKit Egress → S3-compatible bucket)

MeetPlay records the call with **LiveKit Egress** (room composite) and stores the
file in a bucket **you own**. The recap page then plays it back.

Two facts drive the whole design:

1. **Egress has no managed storage.** Every `EncodedFileOutput` must name a
   destination (`output: { case: 's3' | 'gcp' | 'azure' | 'aliOSS' }`) or the API
   rejects the request with `missing or invalid field: output`. That one missing
   field is why recording shipped broken twice. See
   `server/src/livekit/recording.ts` — the output must also be passed **bare**
   (not wrapped in `EncodedOutputs`), and `S3Upload` must be a real Message
   instance, not a plain object.
2. **Recordings are the most sensitive artifact the app produces** (meetings,
   students, minors). So the bucket stays **private** and links are signed.

## Private bucket + signed URLs (default)

Nothing is public. The database stores only the **object key**
(`room_recordings.filepath`); every time a recap is loaded the server mints a
**fresh SigV4 signed URL** for it (`server/src/storage/presign.ts`):

- valid for `RECORDING_URL_TTL_SECONDS` (default **3600** = 1 hour, SigV4 caps at
  7 days)
- returned as `downloadUrl` with `urlExpiresIn` alongside, so the recap UI can say
  "link expires in N min — reload for a fresh one"
- never persisted, so a shared recap link can't be replayed against the bucket
  after it lapses

`S3_PUBLIC_BASE_URL` (alias `R2_PUBLIC_BASE_URL`) still exists as a fallback for
public buckets, but it is **optional** — leave it unset and presigning does the
job. Do not enable the R2 `pub-*.r2.dev` development URL for production: it makes
every recording permanently world-readable to anyone holding the link.

## Env vars

| Var | Notes |
|---|---|
| `S3_BUCKET` | bucket name |
| `S3_ACCESS_KEY` / `S3_SECRET` | R2 API token with **Object Read & Write**, scoped to this bucket |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` — **without** a trailing `/bucket` |
| `S3_REGION` | `auto` for R2; a real region for AWS |
| `S3_FORCE_PATH_STYLE` | default ON (required by R2/MinIO/B2) |
| `S3_PREFIX` | key prefix, default `meetplay` |
| `RECORDING_ENABLED` | `0` force-disables (button shows a reason) |
| `RECORDING_AUDIO_ONLY` | `1` = `.ogg`/Opus, ~4× cheaper egress minutes, no video of participants |
| `RECORDING_PRESET` | video preset, e.g. `H264_720P_30` |
| `RECORDING_URL_TTL_SECONDS` | signed-link lifetime, default 3600 |

Half-configured storage (`bucket` but no keys, say) degrades to *"recording
unavailable, here's why"* rather than a broken button — see
`recordingAvailability()`.

## Retention & cost

- **Retention** is enforced in the bucket: R2 → *Object Lifecycle Rules* → delete
  objects under `meetplay/` after N days. Set it there, not in code.
- **Egress minutes are billed by LiveKit, separately from storage.** The free
  Build tier includes 60 egress minutes/month; then $0.02/min video or
  **$0.005/min audio-only**. R2 itself is 10 GB free with zero egress fees.
- Audio-only is the pilot default recommendation: 4× cheaper and it keeps
  participants off video.

## Verification

```bash
npm run verify:recording   # asserts the exact egress payload shape (locks the old bug out)
npm run verify:presign     # 24 checks: key normalization, signature, expiry, fallbacks
```

`verify:presign` is offline (no bucket needed) and covers the trap that matters:
keys start with `S3_PREFIX` (`meetplay/...`) and the bucket may be named
`meetplay` too — so the bucket segment is only stripped when it's provably a
bucket (path-style endpoint URL, or an `s3://` URI), never from a bare key.

## Troubleshooting

| Symptom | Look for |
|---|---|
| Button disabled with a reason | `RECORDING_ENABLED=0`, or `S3_*` incomplete, or LiveKit unset |
| `recording:error` on click | the WS response message; egress errors are also logged with the bucket/creds detail |
| Recording stops but no playback | `room_recordings.filepath` is set but presigning failed → check the API token's scope and `S3_ENDPOINT` |
| Egress `EGRESS_FAILED` in the log | bucket name/region/credentials — `waitForFileResult()` surfaces the real error instead of hanging |
| 403 on playback after a while | the signed URL expired — reload the recap for a fresh one |
