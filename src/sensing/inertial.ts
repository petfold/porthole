/**
 * Short-horizon inertial position of the phone in the world frame.
 *
 * Gravity-free acceleration (device frame) is rotated into the world with
 * the orientation quaternion and integrated twice, with zero-velocity
 * updates while the phone is still and leaky integration to bound drift.
 * On its own the position wanders within a second; its purpose is the
 * displacement over the last 100–300 ms, which the eye tracker uses to
 * carry a camera fix forward while the phone moves (D-34). A one-second
 * history allows lookups at a fix's capture time.
 */
import * as THREE from 'three';

export interface InertialTuning {
  stillAccel: number;   // m/s²
  stillDps: number;     // deg/s
  stillMs: number;      // ms quiet before velocity is zeroed
  stillSpeed: number;   // m/s: below this, quiet = at rest; above, quiet = cruising
  stillForceMs: number; // ms quiet after which velocity is zeroed regardless
  velocityTau: number;  // s
  positionTau: number;  // s
}

export const DEFAULT_INERTIAL_TUNING: InertialTuning = {
  stillAccel: 0.3,
  stillDps: 40,
  stillMs: 250,
  stillSpeed: 0.12,
  stillForceMs: 900,
  velocityTau: 2,
  positionTau: 20,
};

export class InertialPose {
  readonly velocity = new THREE.Vector3();
  readonly position = new THREE.Vector3();
  still = true;
  private stillSince = 0;
  private readonly aWorld = new THREE.Vector3();
  private readonly history: { t: number; p: THREE.Vector3 }[] = [];
  private lastHistT = 0;

  constructor(private readonly orientation: () => THREE.Quaternion, public tuning: InertialTuning = { ...DEFAULT_INERTIAL_TUNING }) {}

  /** Feed one gravity-free acceleration sample in the device frame. */
  feed(ax: number, ay: number, az: number, rotationDps: number, dt: number, now: number): void {
    const t = this.tuning;
    const mag = Math.hypot(ax, ay, az);
    if (mag < t.stillAccel && rotationDps < t.stillDps) {
      if (!this.stillSince) this.stillSince = now;
      const quiet = now - this.stillSince;
      if ((quiet > t.stillMs && this.velocity.length() < t.stillSpeed) || quiet > t.stillForceMs) {
        this.velocity.set(0, 0, 0);
        this.still = true;
      }
    } else {
      this.stillSince = 0;
      this.still = false;
    }
    this.aWorld.set(ax, ay, az).applyQuaternion(this.orientation());
    this.velocity.addScaledVector(this.aWorld, dt).multiplyScalar(Math.exp(-dt / t.velocityTau));
    this.position.addScaledVector(this.velocity, dt).multiplyScalar(Math.exp(-dt / t.positionTau));
    if (now - this.lastHistT > 8) {
      const e = this.history.length >= 120 ? this.history.shift()! : { t: 0, p: new THREE.Vector3() };
      e.t = now; e.p.copy(this.position);
      this.history.push(e);
      this.lastHistT = now;
    }
  }

  /** Position at time `t` (nearest sample within the last second), or the current one. */
  positionAt(t: number, out: THREE.Vector3): THREE.Vector3 {
    const h = this.history;
    if (!h.length) return out.copy(this.position);
    let best = h[h.length - 1]!;
    for (let i = h.length - 1; i >= 0; i--) { const e = h[i]!; if (Math.abs(e.t - t) < Math.abs(best.t - t)) best = e; if (e.t < t) break; }
    return out.copy(best.p);
  }
}
