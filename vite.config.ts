import { defineConfig, type PluginOption } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { appendFileSync, mkdirSync } from 'node:fs';

/**
 * Dev-only recorder: the phone POSTs JSON lines to /__record and they land in
 * spikes/records/<name>.jsonl on this machine, so spike measurements taken on
 * the phone can be read here. Not part of the app; nothing like it exists in
 * the built bundle.
 */
function recorder(): PluginOption {
  return {
    name: 'porthole-recorder',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/__record') || req.method !== 'POST') return next();
        const name = (new URL(req.url, 'http://x').searchParams.get('name') ?? 'default').replace(/[^a-z0-9_-]/gi, '_');
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          mkdirSync('spikes/records', { recursive: true });
          appendFileSync(`spikes/records/${name}.jsonl`, body.trim() + '\n');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end('ok');
        });
      });
    },
  };
}

// Sensor, microphone, and WebRTC APIs need a secure context. `localhost` is
// one already; a phone on the LAN is not, so `pnpm dev:phone` turns on a
// self-signed certificate (accept the browser warning once).
const https = process.env.PORTHOLE_HTTPS === '1';

export default defineConfig({
  // Swarm serves the bundle under /bzz/<ref>/, so every asset path must be
  // relative. Never use absolute "/..." URLs in the app.
  base: './',
  plugins: [recorder(), https ? (basicSsl() as PluginOption) : undefined].filter(Boolean) as PluginOption[],
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 800 },
});
