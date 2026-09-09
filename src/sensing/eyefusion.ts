/**
 * Pure sensor fusion for the eye position: no camera, no DOM, no timers, so
 * the identical code runs in the app and in the offline replay/simulation
 * scripts (`scripts/s8-replay.ts`, `scripts/s8-simulate.ts`).
 *
 * Inputs (all timestamps in ms on one clock):
 *  - orientation samples: device→world quaternion, every render frame
 *  - acceleration samples: gravity-free, device frame (optional)
 *  - camera fixes: eye position in the screen frame at capture time
 * Output: `eye`, the eye position in the screen frame to render from.
 *
 * Model: the eye is nearly stationary in the world; the phone moves. A fix is
 * anchored in the world using the phone pose at capture (orientation always,
 * position when the inertial estimate is enabled), filtered there, and
 * re-expressed in the screen frame every frame from the current pose. Range
 * (distance) is dead-reckoned separately with its own smoothing.
 */
import * as THREE from 'three';
import { OneEuroFilter } from './filter.ts';
import { InertialPose, type InertialTuning, DEFAULT_INERTIAL_TUNING } from './inertial.ts';

export interface FusionParams {
  /** Camera latency between exposure and the grab timestamp, ms. */
  captureLagMs: number;
  /** One-euro filter on the world-frame eye direction (unit vector). */
  dirMinCutoff: number;
  dirBeta: number;
  /** One-euro filter on the world-frame eye position (metres), when inertial is on. */
  posMinCutoff: number;
  posBeta: number;
  /** Range smoothing time constant, s, and after reacquisition. */
  rangeTau: number;
  gentleTau: number;
  gentleMs: number;
  /** Max dead-reckoning of range from fix velocity, s. */
  rangeAheadMax: number;
  /** Use the inertial position (translation compensation). */
  inertial: boolean;
  /** Smoothing of the current inertial position before use, s. */
  inertialNowTau: number;
  inertialTuning: InertialTuning;
  /** Default eye distance with no tracking, m. */
  defaultDistance: number;
}

export const DEFAULT_FUSION_PARAMS: FusionParams = {
  captureLagMs: 100,
  // S8 simulation: lag dominates true error; 1 Hz / beta 4 halves nothing but cuts error 11 % at equal roughness.
  dirMinCutoff: 1.0,
  dirBeta: 4,
  posMinCutoff: 0.5,
  posBeta: 3,
  rangeTau: 0.05,
  gentleTau: 0.35,
  gentleMs: 800,
  rangeAheadMax: 0.15,
  inertial: false,
  inertialNowTau: 0.04,
  inertialTuning: { ...DEFAULT_INERTIAL_TUNING },
  defaultDistance: 0.4,
};

export interface FusionFix {
  /** Eye in the screen frame at capture, metres. */
  x: number; y: number; z: number;
  /** Grab timestamp (capture is `captureLagMs` earlier). */
  t: number;
  /** Radial velocity estimate from the previous fix, m/s (0 if unknown). */
  vz: number;
  /** True when the fix follows a tracking gap or an eye switch: blend gently. */
  reacquired: boolean;
}

export class EyeFusion {
  readonly eye = { x: 0, y: 0, z: 0.4 };
  readonly inertial: InertialPose;
  /** Filtered world-frame eye direction (unit) and position (m). */
  readonly dirWorld = new THREE.Vector3(0, 0, 1);
  readonly eyeWorld = new THREE.Vector3();
  readonly dirWorldRaw = new THREE.Vector3(0, 0, 1);
  readonly eyeWorldRaw = new THREE.Vector3();
  private dirValid = false;
  private posValid = false;
  private fix: FusionFix | null = null;
  private lastFixT = -Infinity;
  private reacquiredT = -Infinity;
  private range = 0.4;
  private readonly fdir: OneEuroFilter[];
  private readonly fpos: OneEuroFilter[];
  private readonly qNow = new THREE.Quaternion();
  private readonly qHistory: { t: number; q: THREE.Quaternion }[] = [];
  private readonly qTmp = new THREE.Quaternion();
  private readonly vTmp = new THREE.Vector3();
  private readonly pTmp = new THREE.Vector3();
  private readonly pNow = new THREE.Vector3();
  private pNowValid = false;
  private lastUpdateT = -Infinity;

  constructor(public p: FusionParams = structuredClone(DEFAULT_FUSION_PARAMS)) {
    this.fdir = [0, 1, 2].map(() => new OneEuroFilter(p.dirMinCutoff, p.dirBeta, 1));
    this.fpos = [0, 1, 2].map(() => new OneEuroFilter(p.posMinCutoff, p.posBeta, 1));
    this.inertial = new InertialPose(() => this.qNow, p.inertialTuning);
    this.eye.z = p.defaultDistance;
    this.range = p.defaultDistance;
  }

  /** Current device→world orientation; call every frame before `update`. */
  setOrientation(q: THREE.Quaternion, now: number): void {
    this.qNow.copy(q);
    const h = this.qHistory;
    const last = h[h.length - 1];
    if (!last || now - last.t > 8) {
      const e = h.length >= 60 ? h.shift()! : { t: 0, q: new THREE.Quaternion() };
      e.t = now; e.q.copy(q);
      h.push(e);
    }
  }

  /** Gravity-free acceleration sample, device frame. */
  feedAcceleration(ax: number, ay: number, az: number, dps: number, dt: number, now: number): void {
    this.inertial.feed(ax, ay, az, dps, dt, now);
  }

  private orientationAt(t: number, out: THREE.Quaternion): THREE.Quaternion {
    const h = this.qHistory;
    if (!h.length) return out.identity();
    let best = h[h.length - 1]!;
    for (let i = h.length - 1; i >= 0; i--) { const e = h[i]!; if (Math.abs(e.t - t) < Math.abs(best.t - t)) best = e; if (e.t < t) break; }
    return out.copy(best.q);
  }

  /** A new camera fix. */
  addFix(f: FusionFix, now: number): void {
    const p = this.p;
    this.fix = f;
    this.lastFixT = now;
    if (f.reacquired) this.reacquiredT = now;
    const gentle = now - this.reacquiredT < p.gentleMs;
    const tCap = f.t - p.captureLagMs;
    this.orientationAt(tCap, this.qTmp);
    // Direction in the world.
    this.vTmp.set(f.x, f.y, f.z).normalize().applyQuaternion(this.qTmp);
    this.dirWorldRaw.copy(this.vTmp);
    for (const fl of this.fdir) fl.minCutoff = gentle ? p.dirMinCutoff / 2 : p.dirMinCutoff;
    if (!this.dirValid || f.reacquired) {
      this.dirWorld.copy(this.vTmp);
      this.fdir.forEach((fl, i) => fl.set(this.vTmp.getComponent(i), now));
      this.dirValid = true;
    } else {
      this.fdir.forEach((fl, i) => this.dirWorld.setComponent(i, fl.filter(this.vTmp.getComponent(i), now)));
      this.dirWorld.normalize();
    }
    // Position in the world (inertial mode).
    if (p.inertial) {
      this.inertial.positionAt(tCap, this.pTmp);
      this.eyeWorldRaw.set(f.x, f.y, f.z).applyQuaternion(this.qTmp).add(this.pTmp);
      for (const fl of this.fpos) fl.minCutoff = gentle ? p.posMinCutoff / 2 : p.posMinCutoff;
      if (!this.posValid || f.reacquired) {
        this.eyeWorld.copy(this.eyeWorldRaw);
        this.fpos.forEach((fl, i) => fl.set(this.eyeWorldRaw.getComponent(i), now));
        this.posValid = true;
      } else {
        this.fpos.forEach((fl, i) => this.eyeWorld.setComponent(i, fl.filter(this.eyeWorldRaw.getComponent(i), now)));
      }
    }
    // Range anchor.
    this.rangeAnchor = Math.hypot(f.x, f.y, f.z);
    this.dispAtFix = this.displacement();
  }

  /** Optional 1-D displacement along the screen normal (positive = away from the user), for range bridging. */
  displacement: () => number = () => 0;
  private rangeAnchor = 0.4;
  private dispAtFix = 0;

  /** Drop the current fix (tracking lost for long). */
  clear(): void {
    this.fix = null;
    this.dirValid = false;
    this.posValid = false;
    this.pNowValid = false;
  }

  get hasFix(): boolean { return this.fix !== null; }

  /** Advance to `now` and compute the screen-frame eye. `lastFaceT` = last time a face was seen. */
  update(now: number, lastFaceT: number): void {
    const p = this.p;
    const dt = this.lastUpdateT > -Infinity ? Math.min(0.1, (now - this.lastUpdateT) / 1000) : 1 / 60;
    this.lastUpdateT = now;
    const f = this.fix;
    if (!f) {
      const k = 1 - Math.exp(-dt / 0.5);
      this.eye.x += (0 - this.eye.x) * k;
      this.eye.y += (0 - this.eye.y) * k;
      this.eye.z += (p.defaultDistance - this.eye.z) * k;
      this.range = this.eye.z;
      return;
    }
    const gentle = now - this.reacquiredT < p.gentleMs;
    const q = this.qTmp.copy(this.qNow).invert();
    if (p.inertial && this.posValid) {
      if (!this.pNowValid) { this.pNow.copy(this.inertial.position); this.pNowValid = true; }
      else this.pNow.lerp(this.inertial.position, 1 - Math.exp(-dt / p.inertialNowTau));
      this.vTmp.copy(this.eyeWorld).sub(this.pNow).applyQuaternion(q);
      if (this.vTmp.z < 0.05) this.vTmp.z = 0.05;
      this.eye.x = this.vTmp.x; this.eye.y = this.vTmp.y; this.eye.z = this.vTmp.z;
      this.range = this.vTmp.length();
      return;
    }
    // Range: dead-reckoned from the fix's radial velocity (capped), bridged by the 1-D displacement, smoothed.
    const ahead = Math.min(p.rangeAheadMax, Math.max(0, (Math.min(now, lastFaceT) - f.t) / 1000));
    const target = Math.max(0.05, this.rangeAnchor + f.vz * ahead + (this.displacement() - this.dispAtFix));
    const k = 1 - Math.exp(-dt / (gentle ? p.gentleTau : p.rangeTau));
    this.range += (target - this.range) * k;
    // Direction: filtered world direction into the screen frame with the current orientation.
    this.vTmp.copy(this.dirWorld).applyQuaternion(q);
    if (this.vTmp.z < 0.2) this.vTmp.z = 0.2;
    this.vTmp.normalize().multiplyScalar(this.range);
    this.eye.x = this.vTmp.x; this.eye.y = this.vTmp.y; this.eye.z = this.vTmp.z;
  }
}
