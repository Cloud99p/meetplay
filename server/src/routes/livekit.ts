import type { FastifyInstance } from 'fastify';
import { connect } from 'net';

const LIVEKIT_HOST = process.env.LIVEKIT_HOST ?? 'localhost:7880';

/**
 * Lightweight TCP probe to check whether the LiveKit server port is open.
 * Returns { available: true } if the port accepts a TCP connection,
 * { available: false } otherwise.
 */
async function probeLiveKit(): Promise<{ available: boolean }> {
  const [host, portStr] = LIVEKIT_HOST.split(':');
  const port = Number(portStr ?? 7880);

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