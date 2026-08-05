import type { FastifyInstance } from 'fastify';
import { connect } from 'net';

/**
 * Resolve the LiveKit host:port to probe from LIVEKIT_URL if set
 * (e.g. wss://meetplay-xxx.livekit.cloud -> host: meetplay-xxx.livekit.cloud, port 443),
 * falling back to a local dev server.
 */
function resolveProbeTarget(): { host: string; port: number } {
  const url = process.env.LIVEKIT_URL ?? 'wss://meetplay-3pba3wsu.livekit.cloud';
  if (url) {
    try {
      const parsed = new URL(url);
      return {
        host: parsed.hostname,
        port: Number(parsed.port) || (parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? 443 : 80),
      };
    } catch {
      // fall through to default
    }
  }
  const hostPort = process.env.LIVEKIT_HOST ?? 'localhost:7880';
  const [host, portStr] = hostPort.split(':');
  return { host, port: Number(portStr ?? 7880) };
}

/**
 * Lightweight TCP probe to check whether the LiveKit server port is open.
 * Returns { available: true } if the port accepts a TCP connection,
 * { available: false } otherwise.
 */
async function probeLiveKit(): Promise<{ available: boolean }> {
  const { host, port } = resolveProbeTarget();

  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 2_000 }, () => {
      socket.destroy();
      resolve({ available: true });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ available: false });
    });
    socket.on('error', () => {
      socket.destroy();
      resolve({ available: false });
    });
  });
}

export async function livekitRoutes(app: FastifyInstance) {
  // Health check — used by the client to quickly determine if LiveKit
  // is reachable without attempting a WebSocket connection through the
  // Vite proxy (which would hang for 8 s on timeout).
  app.get('/api/livekit/health', async (_req, reply) => {
    const result = await probeLiveKit();
    return reply.send(result);
  });
}

export { probeLiveKit };