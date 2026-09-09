#!/usr/bin/env -S node --experimental-transform-types
/**
 * Simulate a hand-held session with known truth and run EyeFusion on
 * synthetic sensor data, so parameters can be judged by their true error
 * rather than by jitter alone. Noise levels default to those measured on the
 * Pixel 7a (S8 traces); override with --noise '{"fixLateralMm":3}'.
 *
 *   node --experimental-transform-types scripts/s8-simulate.ts [--sweep] [--seconds 60] [--seed 1]
 *
 * Truth model: the eye is fixed in the world apart from slow drift; the phone
 * rotates (tremor + deliberate turns) about a pivot below the screen, so
 * rotation also translates it, plus deliberate translations. Sensors: fused
 * orientation with small noise and no latency; accelerometer with bias and
 * noise; camera fixes at 30/s with 100 ms latency and keypoint noise.
 */
import * as THREE from 'three';
import { EyeFusion, DEFAULT_FUSION_PARAMS, type FusionParams } from '../src/sensing/eyefusion.ts';

interface Noise {
  fixLateralMm: number;   // rms lateral keypoint noise at the eye, mm
  fixRangePct: number;    // rms range noise, %
  fixLatencyMs: number;   // camera latency
  fixLatencyJitterMs: number;
  fixHz: number;
  accBias: number;        // m/s² per axis, slowly varying
  accNoise: number;       // m/s² rms white
  gyroNoiseDeg: number;   // orientation noise rms, degrees
  tremorDeg: number;      // rotational hand tremor rms, degrees (8–12 Hz)
  tremorMm: number;       // translational hand tremor rms, mm
}
const DEFAULT_NOISE: Noise = { fixLateralMm: 2.0, fixRangePct: 0.8, fixLatencyMs: 100, fixLatencyJitterMs: 8, fixHz: 30, accBias: 0.15, accNoise: 0.05, gyroNoiseDeg: 0.1, tremorDeg: 0.4, tremorMm: 1.0 };

// Deterministic RNG.
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r: () => number) { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

interface Truth { t: number; q: THREE.Quaternion; p: THREE.Vector3; eyeWorld: THREE.Vector3 }

/** Phone pose and eye position at time t (s). Smooth analytic motion so acceleration is well defined. */
function makeTruth(seconds: number, r: () => number, noise: Noise): Truth[] {
  const out: Truth[] = [];
  const dt = 1 / 240; // fine sampling; sensors sample from this
  // Tremor: sum of a few sinusoids around 8–12 Hz with random phases.
  const trem = [0, 1, 2].map(() => ({ f: 8 + 4 * r(), ph: 2 * Math.PI * r(), fy: 8 + 4 * r(), phy: 2 * Math.PI * r() }));
  const pivot = new THREE.Vector3(0, -0.10, -0.03); // hand below and behind the screen centre
  const e = new THREE.Euler();
  for (let i = 0; i <= seconds / dt; i++) {
    const t = i * dt;
    // Deliberate motion programme: slow yaw sweep, pitch sweep, a lateral shift, an approach.
    let yaw = 0, pitch = 0, tx = 0, ty = 0, tz = 0;
    if (t > 5 && t < 15) yaw = 0.35 * Math.sin(2 * Math.PI * 0.25 * (t - 5));          // ±20° at 0.25 Hz
    if (t > 18 && t < 26) pitch = 0.3 * Math.sin(2 * Math.PI * 0.25 * (t - 18));       // ±17°
    if (t > 30 && t < 36) tx = 0.06 * Math.sin(2 * Math.PI * 0.2 * (t - 30));           // ±6 cm lateral shift
    if (t > 40 && t < 48) tz = -0.12 * (0.5 - 0.5 * Math.cos(2 * Math.PI * (t - 40) / 8)); // approach 12 cm and back
    const tremYaw = trem.reduce((a, k) => a + Math.sin(2 * Math.PI * k.f * t + k.ph), 0) / Math.sqrt(3) * noise.tremorDeg * Math.PI / 180;
    const tremPitch = trem.reduce((a, k) => a + Math.sin(2 * Math.PI * k.fy * t + k.phy), 0) / Math.sqrt(3) * noise.tremorDeg * Math.PI / 180;
    const tremX = trem.reduce((a, k) => a + Math.sin(2 * Math.PI * (k.f + 0.7) * t + k.phy), 0) / Math.sqrt(3) * noise.tremorMm / 1000;
    const tremY = trem.reduce((a, k) => a + Math.sin(2 * Math.PI * (k.fy + 0.5) * t + k.ph), 0) / Math.sqrt(3) * noise.tremorMm / 1000;
    e.set(pitch + tremPitch, yaw + tremYaw, 0, 'YXZ');
    const q = new THREE.Quaternion().setFromEuler(e);
    // Screen centre position: rotation about the pivot plus deliberate translation and tremor.
    const p = pivot.clone().negate().applyQuaternion(q).add(pivot).add(new THREE.Vector3(tx + tremX, ty + tremY, tz));
    // Eye: fixed in the world with slow drift.
    const eyeWorld = new THREE.Vector3(0.01 * Math.sin(2 * Math.PI * 0.05 * t), 0.05 + 0.005 * Math.sin(2 * Math.PI * 0.07 * t), 0.33);
    out.push({ t, q, p, eyeWorld });
  }
  return out;
}

export function simulate(overrides: Partial<FusionParams>, noise: Noise = DEFAULT_NOISE, seconds = 60, seed = 1) {
  const r = rng(seed);
  const truth = makeTruth(seconds, r, noise);
  const params: FusionParams = structuredClone(DEFAULT_FUSION_PARAMS);
  Object.assign(params, overrides);
  const fusion = new EyeFusion(params);
  const truthAt = (t: number) => truth[Math.min(truth.length - 1, Math.max(0, Math.round(t * 240)))]!;
  const screenEye = (tr: Truth) => tr.eyeWorld.clone().sub(tr.p).applyQuaternion(tr.q.clone().invert());
  // Accelerometer: second difference of position in the world, rotated to the device frame, + bias + noise.
  const bias = new THREE.Vector3(gauss(r), gauss(r), gauss(r)).multiplyScalar(noise.accBias);
  const errs: number[] = [], rangeErrs: number[] = [], rough: number[] = [];
  const prev: THREE.Vector3[] = [];
  let nextFix = 0.2, lastFaceT = 0, prevFixZ: number | null = null, prevFixT = 0;
  const pending: { due: number; fix: { x: number; y: number; z: number; t: number } }[] = [];
  const frameDt = 1 / 60;
  for (let t = 0; t < seconds; t += frameDt) {
    const now = t * 1000;
    const tr = truthAt(t);
    // Orientation sensor (fused, tiny noise, no latency).
    const qn = tr.q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(gauss(r) * noise.gyroNoiseDeg * Math.PI / 180, gauss(r) * noise.gyroNoiseDeg * Math.PI / 180, 0)));
    fusion.setOrientation(qn, now);
    // Accelerometer sample (60 Hz), from truth positions.
    const a = truthAt(t - 1 / 240), b = truthAt(t), c = truthAt(t + 1 / 240);
    const accWorld = c.p.clone().sub(b.p.clone().multiplyScalar(2)).add(a.p).multiplyScalar(240 * 240);
    const accDev = accWorld.applyQuaternion(tr.q.clone().invert()).add(bias).add(new THREE.Vector3(gauss(r), gauss(r), gauss(r)).multiplyScalar(noise.accNoise));
    fusion.feedAcceleration(accDev.x, accDev.y, accDev.z, 0, frameDt, now);
    // Camera: expose at t, deliver after latency.
    if (t >= nextFix) {
      nextFix += 1 / noise.fixHz;
      const se = screenEye(tr);
      const lat = se.length();
      const noisy = se.clone().add(new THREE.Vector3(gauss(r), gauss(r), 0).multiplyScalar(noise.fixLateralMm / 1000)).multiplyScalar(1 + gauss(r) * noise.fixRangePct / 100);
      const latency = noise.fixLatencyMs + gauss(r) * noise.fixLatencyJitterMs;
      // The grab timestamp is `captureLagMs` after exposure in the real system; here the fix's t = exposure + latency.
      pending.push({ due: now + latency, fix: { x: noisy.x, y: noisy.y, z: noisy.z, t: now + latency } });
      void lat;
    }
    while (pending.length && pending[0]!.due <= now) {
      const { fix } = pending.shift()!;
      const dtFix = prevFixZ !== null ? (fix.t - prevFixT) / 1000 : 0;
      const vz = prevFixZ !== null && dtFix > 0.01 ? Math.max(-1.5, Math.min(1.5, (fix.z - prevFixZ) / dtFix)) : 0;
      fusion.addFix({ ...fix, vz, reacquired: false }, now);
      prevFixZ = fix.z; prevFixT = fix.t; lastFaceT = now;
    }
    fusion.update(now, lastFaceT);
    if (t > 1) {
      const est = new THREE.Vector3(fusion.eye.x, fusion.eye.y, fusion.eye.z);
      const tru = screenEye(tr);
      errs.push((est.clone().normalize().angleTo(tru.clone().normalize()) * 180) / Math.PI);
      rangeErrs.push(Math.abs(est.length() / tru.length() - 1) * 100);
      prev.push(est.clone().normalize());
      if (prev.length >= 3) {
        const [p0, p1, p2] = prev.slice(-3) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
        rough.push((p1.clone().multiplyScalar(2).sub(p0).normalize().angleTo(p2) * 180) / Math.PI);
      }
    }
  }
  const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))] ?? NaN; };
  const rms = (xs: number[]) => Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length);
  return { errRms: rms(errs), errP95: pct(errs, 0.95), rangeErrRms: rms(rangeErrs), roughMed: pct(rough, 0.5), roughP95: pct(rough, 0.95) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const get = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1]! : d; };
  const seconds = Number(get('--seconds', '60')), seed = Number(get('--seed', '1'));
  const noise: Noise = { ...DEFAULT_NOISE, ...JSON.parse(get('--noise', '{}')) };
  const fmt = (name: string, r: ReturnType<typeof simulate>) =>
    console.log(`${name.padEnd(44)} err rms ${r.errRms.toFixed(3)}° p95 ${r.errP95.toFixed(2)}° · range err ${r.rangeErrRms.toFixed(2)} % · rough ${r.roughMed.toFixed(3)}° / p95 ${r.roughP95.toFixed(2)}°`);
  console.log(`simulation ${seconds} s, seed ${seed}, noise ${JSON.stringify(noise)}`);
  if (!args.includes('--sweep')) fmt('defaults', simulate(JSON.parse(get('--params', '{}')), noise, seconds, seed));
  else {
    const variants: [string, Partial<FusionParams>][] = [
      ['current defaults (rotation only)', {}],
      ['dirBeta 1', { dirBeta: 1 }],
      ['dirBeta 4', { dirBeta: 4 }],
      ['dirMinCutoff 0.3', { dirMinCutoff: 0.3 }],
      ['dirMinCutoff 1.0', { dirMinCutoff: 1.0 }],
      ['captureLag 50', { captureLagMs: 50 }],
      ['captureLag 150', { captureLagMs: 150 }],
      ['inertial on', { inertial: true }],
      ['inertial on, posBeta 1', { inertial: true, posBeta: 1 }],
      ['inertial on, posMinCutoff 1.0', { inertial: true, posMinCutoff: 1.0 }],
      ['inertial on, nowTau 0.1', { inertial: true, inertialNowTau: 0.1 }],
      ['inertial on, velocityTau 0.25', { inertial: true, inertialTuning: { ...DEFAULT_FUSION_PARAMS.inertialTuning, velocityTau: 0.25 } }],
    ];
    for (const [name, o] of variants) fmt(name, simulate(o, noise, seconds, seed));
  }
}
