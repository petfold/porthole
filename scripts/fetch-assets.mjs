#!/usr/bin/env node
/**
 * Put the MediaPipe face landmarker runtime and model into public/ so the
 * bundle is self-contained (no CDN at runtime, D-02). Runs on `pnpm install`
 * via the `prepare` script; safe to re-run.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const wasmSrc = resolve('node_modules/@mediapipe/tasks-vision/wasm');
const wasmDst = resolve('public/mediapipe/wasm');
mkdirSync(wasmDst, { recursive: true });
// Only the SIMD build: every browser we target has WebAssembly SIMD.
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
  copyFileSync(resolve(wasmSrc, f), resolve(wasmDst, f));
}

const modelDir = resolve('public/models');
const model = resolve(modelDir, 'face_landmarker.task');
mkdirSync(modelDir, { recursive: true });
if (!existsSync(model) || statSync(model).size < 1_000_000) {
  const url = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
  console.error(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) { console.error(`download failed: ${res.status}`); process.exit(1); }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(model, Buffer.from(await res.arrayBuffer()));
}
console.error(`assets ready: ${wasmDst}, ${model} (${(statSync(model).size / 1e6).toFixed(1)} MB)`);
