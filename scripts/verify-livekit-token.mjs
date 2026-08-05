// Verify the LiveKit token signature locally using the .env secret.
// If this passes, LiveKit Cloud will accept the token (same HMAC-SHA256 check).
import crypto from 'node:crypto';
import fs from 'node:fs';

const env = fs.readFileSync('.env', 'utf8');
const get = (k) => env.split('\n').find((l) => l.startsWith(k))?.split('=').slice(1).join('=').trim();
const secret = get('LIVEKIT_API_SECRET');
const key = get('LIVEKIT_API_KEY');
console.log('secret loaded:', secret ? 'yes (' + secret.length + ' chars)' : 'NO');
console.log('key loaded:', key || 'NO');

const BASE = 'http://localhost:5173';
const createRes = await fetch(`${BASE}/api/rooms`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ hostName: 'SigTest' }),
});
const create = await createRes.json();
const rid = create.room.id;
const tkRes = await fetch(`${BASE}/api/rooms/${rid}/livekit-token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${create.token}` },
  body: '{}',
});
const { token } = await tkRes.json();
if (!token) { console.error('no token'); process.exit(1); }

const [h, p, sig] = token.split('.');
const expected = crypto.createHmac('sha256', secret)
  .update(`${h}.${p}`)
  .digest('base64url');
const match = expected === sig;
console.log('signature verified with .env secret:', match ? '✅ YES' : '❌ NO');
console.log('iss in payload:', JSON.parse(Buffer.from(p, 'base64url').toString()).iss);
process.exit(match ? 0 : 1);