import { defineConfig, type PluginOption } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Sensor, microphone, and WebRTC APIs need a secure context. `localhost` is
// one already; a phone on the LAN is not, so `pnpm dev:phone` turns on a
// self-signed certificate (accept the browser warning once).
const https = process.env.PORTHOLE_HTTPS === '1';

export default defineConfig({
  // Swarm serves the bundle under /bzz/<ref>/, so every asset path must be
  // relative. Never use absolute "/..." URLs in the app.
  base: './',
  plugins: [https ? (basicSsl() as PluginOption) : undefined].filter(Boolean) as PluginOption[],
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 800 },
});
