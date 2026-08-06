// Verify LiveKit Cloud accepts our minted token: connect a real LiveKit client
// to your LIVEKIT_URL (e.g. wss://meetplay-3pba3wsu.livekit.cloud — set it in
// .env). Requires the backend running on PORT.
import { Room } from 'livekit-client';

const PORT = Number(process.argv[2] || 5173);
const BASE = `http://localhost:${PORT}`;

try {
  // create room via app API
  const createRes = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostName: 'LKTest' }),
  });
  const create = await createRes.json();
  const roomId = create.room?.id;
  console.log('room created:', roomId, '| livekitUrl:', create.livekitUrl);

  // mint a LiveKit token from the backend (uses env LIVEKIT_API_KEY/SECRET)
  const tkRes = await fetch(`${BASE}/api/rooms/${roomId}/livekit-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${create.token}`,
    },
  });
  const { token } = await tkRes.json();
  console.log('livekit token minted:', token ? token.slice(0, 30) + '…' : 'NONE');

  // actually connect to LiveKit Cloud
  const room = new Room();
  const url = create.livekitUrl;
  console.log('connecting to', url, '…');
  await room.connect(url, token, { autoSubscribe: true });
  console.log('✅ CONNECTED to LiveKit Cloud!');
  await room.disconnect();
  console.log('✅ disconnected cleanly');
  process.exit(0);
} catch (e) {
  console.error('❌ FAILED:', e?.message ?? e);
  process.exit(1);
}