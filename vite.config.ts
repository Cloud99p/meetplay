import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import svgr from 'vite-plugin-svgr'

// Custom plugin to handle ?import&react syntax (alias to ?react)
const svgImportPlugin = () => ({
  name: 'svg-import-alias',
  resolveId(id: string) {
    // Transform ?import&react to ?react for vite-plugin-svgr
    if (id.includes('?import&react')) {
      return id.replace('?import&react', '?react');
    }
    return null;
  },
});

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [
    react(),
    tailwindcss(),
    svgImportPlugin(),
    svgr({
      // Support named ReactComponent export (for ?react syntax)
      svgrOptions: {
        exportType: 'named',
        namedExport: 'ReactComponent',
        ref: true,
        svgo: false,
        titleProp: true,
      },
      include: '**/*.svg?react',
    }),
    // Intercept WebSocket upgrades to /rtc/v1 and fail fast with a 404,
    // so the LiveKit SDK's V1 → V0 fallback works through the Vite proxy
    // (the http-proxy hangs when the upstream returns non-101 to an upgrade).
    {
      name: 'livekit-v1-fallback',
      configureServer(server) {
        server.httpServer?.on('upgrade', (req, socket, _head) => {
          const url = req.url ?? '';
          if (url.startsWith('/rtc/v1')) {
            socket.write(
              'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
            );
            socket.destroy();
          }
        });
      },
    },
  ],
  server: {
    allowedHosts: true as const,
    hmr: false,
    proxy: {
      // Forward API + WebSocket traffic to the MeetPlay backend, which
      // scripts/dev.mjs starts on :3001 (in-memory DB, no Postgres needed).
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // The STT pipeline uses a WebSocket to same-origin /api/stt
        // (browser mic -> PCM16 -> WS -> Deepgram proxy). Without ws: true
        // the Vite proxy swallows the upgrade and the Deepgram adapter's
        // socket never opens, so captions stay empty.
        ws: true,
      },
      // Health check (used by Railway/paas readiness probes)
      '/health': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
      // Proxy LiveKit WebSocket connections so the browser never connects
      // directly to the sandbox's localhost:7880 — it goes through the
      // same host that serves the page (Vite dev proxy or platform proxy).
      // Target uses http:// so both WebSocket upgrades and HTTP validation
      // requests (/rtc/validate) are forwarded to LiveKit on :7880.
      '/rtc': {
        target: 'http://localhost:7880',
        ws: true,
      },
    },
  },
}))
