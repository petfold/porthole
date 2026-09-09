#!/usr/bin/env node
/**
 * Upload `dist/` to Swarm as a collection and print the bzz address.
 * Phase 1b (plan.md) and spike S4. Needs BEE_URL and BEE_STAMP in the
 * environment or in `.env`.
 *
 *   pnpm build && pnpm publish:swarm
 */
import { Bee } from '@ethersphere/bee-js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal .env loader so the script has no extra dependency.
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const beeUrl = process.env.BEE_URL ?? 'http://localhost:1633';
const stamp = process.env.BEE_STAMP;
const dist = resolve(process.cwd(), process.argv[2] ?? 'dist');

if (!stamp) {
  console.error('BEE_STAMP is not set. Buy an immutable stamp on the Bee node and put its batch id in .env.');
  process.exit(2);
}
if (!existsSync(resolve(dist, 'index.html'))) {
  console.error(`${dist}/index.html not found. Run \`pnpm build\` first.`);
  process.exit(2);
}

const bee = new Bee(beeUrl);
try {
  const health = await bee.status.getHealth();
  console.error(`Bee ${health.version} at ${beeUrl}`);
} catch (e) {
  console.error(`No Bee reachable at ${beeUrl}: ${e.message ?? e}`);
  process.exit(1);
}

const result = await bee.collection.streamFromDirectory(
  stamp,
  dist,
  (p) => process.stderr.write(`\r${p.total ? Math.round((100 * p.processed) / p.total) : 0}%`),
  { indexDocument: 'index.html', errorDocument: 'index.html', pin: true },
);
process.stderr.write('\n');

const ref = result.reference.toHex();
console.log(ref);
console.error(`Local:   ${beeUrl}/bzz/${ref}/`);
console.error(`Gateway: https://gateway.ethswarm.org/bzz/${ref}/ (if the node is connected to mainnet)`);
console.error(`Open the address on the phone with ?debug to run spike S4 (sensors, mic, WebRTC from a Swarm origin).`);
