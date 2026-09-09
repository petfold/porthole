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
  /** Time constant of the acceleration bias estimate (high-pass), s. Hand-held use has zero mean acceleration. */
  biasTau: number;
  stillAccel: number;   // m/s²
  stillDps: number;     // deg/s
  stillMs: number;      // ms quiet before velocity is zeroed
  stillSpeed: number;   // m/s: below this, quiet = at rest; above, quiet = cruising
  stillForceMs: number; // ms quiet after which velocity is zeroed regardless
  velocityTau: number;  // s
  positionTau: number;  // s
}

export const DEFAULT_INERTIAL_TUNING: InertialTuning = {
  biasTau: 1.5,
  stillAccel: 0.35,
  stillDps: 40,
  stillMs: 200,
  stillSpeed: 0.08,
  stillForceMs: 700,
  velocityTau: 0.5,
  positionTau: 10,
};

export class InertialPose {
  readonly velocity = new THREE.Vector3();
  readonly position = new THREE.Vector3();
  still = true;
  private stillSince = 0;
  private readonly aWorld = new THREE.Vector3();
  /** Running estimate of the accelerometer bias (device frame). */
  readonly bias = new THREE.Vector3();
  private samples = 0;
  private readonly history: { t: number; p: THREE.Vector3 }[] = [];
  private lastHistT = 0;

  constructor(private readonly orientation: () => THREE.Quaternion, public tuning: InertialTuning = { ...DEFAULT_INERTIAL_TUNING }) {}

  /** Feed one gravity-free acceleration sample in the device frame. */
  feed(axRaw: number, ayRaw: number, azRaw: number, rotationDps: number, dt: number, now: number): void {
    const t = this.tuning;
    // Bias removal: over a second or two a hand-held phone has zero mean acceleration.
    const kb = 1 - Math.exp(-dt / t.biasTau);
    this.bias.x += (axRaw - this.bias.x) * kb;
    this.bias.y += (ayRaw - this.bias.y) * kb;
    this.bias.z += (azRaw - this.bias.z) * kb;
    this.samples++;
    const ax = axRaw - this.bias.x, ay = ayRaw - this.bias.y, az = azRaw - this.bias.z;
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
