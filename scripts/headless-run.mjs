#!/usr/bin/env node
/**
 * Load the app in headless Chromium with a fake camera and print its console
 * for a while. Used to smoke-test paths that need a user gesture or media:
 *
 *   node scripts/headless-run.mjs "http://localhost:5174/?autostart&eye" 40
 *
 * Needs `chromium` on PATH (the snap works; it can only write under $HOME).
 */
import { spawn } from 'node:child_process';

const url = process.argv[2] ?? 'http://localhost:5173/?autostart';
const seconds = Number(process.argv[3] ?? 30);
const port = 9333;

const chrome = spawn('chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--window-size=800,600', `--remote-debugging-port=${port}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', (d) => { const s = String(d); if (/DevTools listening/.test(s)) ready(); });

async function ready() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
  ws.onopen = () => {
    send('Runtime.enable');
    send('Log.enable');
    send('Network.enable');
    send('Page.navigate', { url });
    setTimeout(() => { ws.close(); chrome.kill(); }, seconds * 1000);
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
      if (!/\[vite\]/.test(text)) console.log(`${(m.params.timestamp / 1000).toFixed(0)} ${m.params.type}: ${text}`);
    } else if (m.method === 'Runtime.exceptionThrown') {
      console.log('EXCEPTION:', m.params.exceptionDetails.text, m.params.exceptionDetails.exception?.description ?? '');
    } else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
      console.log(`HTTP ${m.params.response.status}: ${m.params.response.url}`);
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      console.log('LOG error:', m.params.entry.text);
    }
  };
}
chrome.on('exit', () => process.exit(0));
