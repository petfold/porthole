#!/usr/bin/env -S node --experimental-transform-types
/**
 * Replay a recorded trace (spikes/records/s8-trace.jsonl) through EyeFusion
 * with chosen parameters and report jitter and lag of the rendered eye.
 *
 *   node --experimental-transform-types scripts/s8-replay.ts [session] [--sweep] [--params '{"dirBeta":1}']
 *
 * Metrics: roughness = per-frame deviation of the screen-frame eye direction
 * from a linear extrapolation of the two previous frames (isolates noise from
 * smooth motion), median and p95 in degrees; lag = time shift that best
 * aligns the rendered eye direction (world frame) with the raw camera fixes.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { EyeFusion, DEFAULT_FUSION_PARAMS, type FusionParams } from '../src/sensing/eyefusion.ts';

interface Frame { t: number; dt: number; q: number[]; acc?: number[]; fix?: { t: number; x: number; y: number; z: number } }

export function loadTrace(file: string, session?: string): { frames: Frame[]; session: string } {
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const sessions = [...new Set(rows.map((r) => r.s as string))];
  const sid = session ?? sessions[sessions.length - 1]!;
  const frames = rows.filter((r) => r.s === sid && r.k === 'f').map((r) => ({ t: r.t, dt: r.dt, q: r.q, acc: r.acc, fix: r.fix }));
  return { frames, session: sid };
}

const deg = (v: number) => (v * 180) / Math.PI;
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))] ?? NaN; };

export function replay(frames: Frame[], overrides: Partial<FusionParams>) {
  const params: FusionParams = structuredClone(DEFAULT_FUSION_PARAMS);
  Object.assign(params, overrides);
  const fusion = new EyeFusion(params);
  const q = new THREE.Quaternion();
  const out: { t: number; eye: THREE.Vector3; q: THREE.Quaternion }[] = [];
  const rawWorld: { t: number; d: THREE.Vector3 }[] = [];
  let lastFaceT = 0, prevFix: Frame['fix'] | null = null, prevFixNow = 0;
  const qHist: { t: number; q: THREE.Quaternion }[] = [];
  for (const f of frames) {
    q.set(f.q[0]!, f.q[1]!, f.q[2]!, f.q[3]!);
    fusion.setOrientation(q, f.t);
    qHist.push({ t: f.t, q: q.clone() });
    if (f.acc && f.dt > 0) fusion.feedAcceleration(f.acc[0]!, f.acc[1]!, f.acc[2]!, f.acc[3] ?? 0, f.dt / 1000, f.t);
    if (f.fix) {
      const gap = prevFix ? f.t - prevFixNow : Infinity;
      const dtFix = prevFix ? (f.fix.t - prevFix.t) / 1000 : 0;
      const vz = prevFix && dtFix > 0.01 && dtFix < 0.3 ? Math.max(-1.5, Math.min(1.5, (f.fix.z - prevFix.z) / dtFix)) : 0;
      fusion.addFix({ x: f.fix.x, y: f.fix.y, z: f.fix.z, t: f.fix.t, vz, reacquired: gap > 400 }, f.t);
      lastFaceT = f.t;
      prevFix = f.fix; prevFixNow = f.t;
      // Raw fix direction in the world (orientation at capture) for the lag metric.
      const tCap = f.fix.t - params.captureLagMs;
      let best = qHist[qHist.length - 1]!;
      for (let i = qHist.length - 1; i >= 0 && qHist[i]!.t > tCap - 200; i--) if (Math.abs(qHist[i]!.t - tCap) < Math.abs(best.t - tCap)) best = qHist[i]!;
      rawWorld.push({ t: f.t, d: new THREE.Vector3(f.fix.x, f.fix.y, f.fix.z).normalize().applyQuaternion(best.q) });
    }
    fusion.update(f.t, lastFaceT);
    out.push({ t: f.t, eye: new THREE.Vector3(fusion.eye.x, fusion.eye.y, fusion.eye.z), q: q.clone() });
  }
  // Roughness of the screen-frame direction.
  const rough: number[] = [];
  for (let i = 2; i < out.length; i++) {
    const a = out[i - 2]!.eye.clone().normalize(), b = out[i - 1]!.eye.clone().normalize(), c = out[i]!.eye.clone().normalize();
    const pred = b.clone().multiplyScalar(2).sub(a).normalize();
    rough.push(deg(pred.angleTo(c)));
  }
  // Range roughness (relative).
  const rr: number[] = [];
  for (let i = 2; i < out.length; i++) {
    const a = out[i - 2]!.eye.length(), b = out[i - 1]!.eye.length(), c = out[i]!.eye.length();
    rr.push(Math.abs((2 * b - a) / c - 1));
  }
  // Lag: world-frame rendered direction vs raw fixes shifted back.
  const rendWorld = out.map((o) => ({ t: o.t, d: o.eye.clone().normalize().applyQuaternion(o.q) }));
  let bestLag = 0, bestErr = Infinity;
  for (let shift = 0; shift <= 400; shift += 25) {
    let sum = 0, n = 0, j = 0;
    for (let i = 0; i < rendWorld.length; i += 3) {
      const tt = rendWorld[i]!.t - shift;
      while (j + 1 < rawWorld.length && rawWorld[j + 1]!.t <= tt) j++;
      if (!rawWorld[j]) continue;
      sum += deg(rendWorld[i]!.d.angleTo(rawWorld[j]!.d)); n++;
    }
    const e = sum / n;
    if (e < bestErr) { bestErr = e; bestLag = shift; }
  }
  return { roughMed: pct(rough, 0.5), roughP95: pct(rough, 0.95), rangeRoughMed: pct(rr, 0.5) * 100, lagMs: bestLag, lagErr: bestErr, frames: out.length, fixes: rawWorld.length, hasAcc: frames.some((f) => f.acc) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const file = args.find((a) => a.endsWith('.jsonl')) ?? 'spikes/records/s8-trace.jsonl';
  const session = args.find((a) => /^\d{4}T\d{6}$/.test(a));
  const sweep = args.includes('--sweep');
  const pi = args.indexOf('--params');
  const overrides = pi >= 0 ? JSON.parse(args[pi + 1]!) : {};
  const { frames, session: sid } = loadTrace(file, session);
  console.log(`session ${sid}: ${frames.length} frames, acceleration ${frames.some((f) => f.acc) ? 'present' : 'absent'}`);
  const fmt = (name: string, r: ReturnType<typeof replay>) =>
    console.log(`${name.padEnd(44)} rough ${r.roughMed.toFixed(3)}° / p95 ${r.roughP95.toFixed(2)}° · range rough ${r.rangeRoughMed.toFixed(2)} % · lag ${r.lagMs} ms (err ${r.lagErr.toFixed(2)}°)`);
  if (!sweep) { fmt('params ' + JSON.stringify(overrides), replay(frames, overrides)); }
  else {
    const variants: [string, Partial<FusionParams>][] = [
      ['current defaults', {}],
      ['dirBeta 1', { dirBeta: 1 }],
      ['dirBeta 4', { dirBeta: 4 }],
      ['dirMinCutoff 0.3', { dirMinCutoff: 0.3 }],
      ['dirMinCutoff 1.0', { dirMinCutoff: 1.0 }],
      ['captureLag 50', { captureLagMs: 50 }],
      ['captureLag 150', { captureLagMs: 150 }],
      ['rangeTau 0.1', { rangeTau: 0.1 }],
      ['inertial on', { inertial: true }],
      ['inertial on, posBeta 1', { inertial: true, posBeta: 1 }],
      ['inertial on, nowTau 0.08', { inertial: true, inertialNowTau: 0.08 }],
    ];
    for (const [name, o] of variants) fmt(name, replay(frames, o));
  }
}
