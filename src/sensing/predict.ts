/**
 * Orientation propagation and prediction (D-35).
 *
 * The orientation sensor delivers about 50 distinct samples a second on the
 * Pixel 7a while the display runs at 60, so 40 % of frames would repeat the
 * previous orientation (a 1° step every other frame in the recordings).
 * Each frame the last real sample is propagated forward by its age plus a
 * lookahead horizon for display latency, using the gyroscope's angular rate
 * when available (smooth, full rate) or a rate estimated from successive
 * distinct samples otherwise. Frame-to-frame differentiation of the
 * orientation is never used: it alternates between zero and double on the
 * repeated frames and doubles the roughness (trace session 3).
 *
 * Safety: the gyro's sign convention is verified online against observed
 * rotation; until confirmed, only the sample-derived rate is used.
 */
import * as THREE from 'three';

export class OrientationPredictor {
  /**
   * Lookahead for display latency, ms. 0 until the gyro axis mapping is
   * verified offline: trace session 5 showed the gyro-driven lookahead
   * predicting the sensor's future worse than age propagation alone.
   */
  horizonMs = 0;
  /** Latest smoothed gyro rate, device frame, rad/s (read-only, for traces). */
  get gyroRate(): THREE.Vector3 { return this.rateDev; }
  /** Cap on total propagation (age + horizon), ms. */
  maxAheadMs = 70;
  readonly out = new THREE.Quaternion();
  /** Diagnostics for the trace. */
  sampleAgeMs = 0;
  gyroFresh = false;
  gyroSign = 0; // 0 = unverified, ±1 once confirmed
  private readonly qSample = new THREE.Quaternion();
  private tSample = -Infinity;
  private haveSample = false;
  /** Angular rate from successive distinct samples, world frame, rad/s (EMA). */
  private readonly rateWorld = new THREE.Vector3();
  /** Gyro angular rate, device frame, rad/s (EMA). */
  private readonly rateDev = new THREE.Vector3();
  private gyroT = -Infinity;
  /** Gyro integrated since the last distinct sample, device frame, for the sign check. */
  private readonly gyroInt = new THREE.Vector3();
  private signEvidence = 0;
  private readonly dq = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly qi = new THREE.Quaternion();

  /** Gyro sample, device frame, rad/s. */
  feedGyro(rx: number, ry: number, rz: number, dt: number, now: number): void {
    const k = 1 - Math.exp(-dt / 0.012);
    this.rateDev.x += (rx - this.rateDev.x) * k;
    this.rateDev.y += (ry - this.rateDev.y) * k;
    this.rateDev.z += (rz - this.rateDev.z) * k;
    this.gyroInt.x += rx * dt; this.gyroInt.y += ry * dt; this.gyroInt.z += rz * dt;
    this.gyroT = now;
  }

  /** Propagate the sensor orientation `q` (device→world) to now + horizon. */
  predict(q: THREE.Quaternion, now: number): THREE.Quaternion {
    // New distinct sample?
    if (!this.haveSample || Math.abs(q.dot(this.qSample)) < 1 - 1e-8) {
      if (this.haveSample) {
        const dt = (now - this.tSample) / 1000;
        if (dt > 0.001 && dt < 0.2) {
          // Observed rotation since the previous sample, world frame: dq = q · qSample⁻¹.
          this.dq.copy(this.qSample).invert().premultiply(q);
          rotationVector(this.dq, this.v);
          const k = 0.5;
          this.rateWorld.x += (this.v.x / dt - this.rateWorld.x) * k;
          this.rateWorld.y += (this.v.y / dt - this.rateWorld.y) * k;
          this.rateWorld.z += (this.v.z / dt - this.rateWorld.z) * k;
          // Sign check: the same rotation in the device frame is qSample⁻¹ · dq · qSample = qSample⁻¹ · q.
          if (now - this.gyroT < 100 && this.gyroInt.lengthSq() > 1e-6) {
            this.qi.copy(this.qSample).invert().multiply(q);
            rotationVector(this.qi, this.v);
            this.signEvidence += this.v.dot(this.gyroInt);
            if (Math.abs(this.signEvidence) > 0.02) this.gyroSign = Math.sign(this.signEvidence);
          }
        }
      }
      this.qSample.copy(q);
      this.tSample = now;
      this.haveSample = true;
      this.gyroInt.set(0, 0, 0);
    }
    this.sampleAgeMs = now - this.tSample;
    this.gyroFresh = now - this.gyroT < 100;
    const useGyro = this.gyroFresh && this.gyroSign !== 0;
    // Without a verified gyro, propagate by age only (interpolation to the frame rate; no lookahead).
    const aheadMs = Math.min(this.maxAheadMs, this.sampleAgeMs + (useGyro ? this.horizonMs : 0));
    const ahead = aheadMs / 1000;
    if (useGyro) {
      this.v.copy(this.rateDev).multiplyScalar(this.gyroSign * ahead);
      quaternionFromRotationVector(this.v, this.dq);
      return this.out.copy(this.qSample).multiply(this.dq); // device-frame rotation: q · dq
    }
    this.v.copy(this.rateWorld).multiplyScalar(ahead);
    quaternionFromRotationVector(this.v, this.dq);
    return this.out.copy(this.qSample).premultiply(this.dq); // world-frame rotation: dq · q
  }
}

const MAX_ANGLE = 0.2; // rad, cap on any single propagation

function rotationVector(q: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
  const w = THREE.MathUtils.clamp(q.w, -1, 1);
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  if (s < 1e-9) return out.set(0, 0, 0);
  const angle = 2 * Math.acos(Math.abs(w));
  const sign = w < 0 ? -1 : 1;
  return out.set(q.x, q.y, q.z).multiplyScalar((sign * angle) / s);
}

function quaternionFromRotationVector(v: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  const angle = Math.min(v.length(), MAX_ANGLE);
  if (angle < 1e-9) return out.identity();
  const s = Math.sin(angle / 2) / v.length();
  return out.set(v.x * s, v.y * s, v.z * s, Math.cos(angle / 2));
}
