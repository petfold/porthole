/**
 * Push/pull throttle gesture from linear acceleration along the screen
 * normal, in the device frame (design §4.3, spike S6).
 *
 * The device Z axis points out of the screen toward the user. A push away
 * from the body therefore starts with negative Z acceleration; a pull with
 * positive. We integrate the first half of the gesture (until the sign flips)
 * to get the phone's peak velocity, then wait for the phone to settle before
 * arming again, so the return motion is not read as a second gesture.
 */
import * as THREE from 'three';
import { RateMeter } from './rate.ts';

export type MotionKind = 'linear-acceleration-sensor' | 'devicemotion' | 'devicemotion+gravity' | 'none';

export interface Impulse {
  /** Peak phone velocity along the screen normal, m/s. Positive = push (away). */
  value: number;
  /** Duration of the accelerating half, ms. */
  ms: number;
  t: number;
}

export interface ThrottleTuning {
  /** |a_z| that starts a gesture, m/s². */
  startThreshold: number;
  /** |a_z| below which the phone counts as still, m/s². */
  quietThreshold: number;
  /** How long it must be still before the next gesture is accepted, ms. */
  quietMs: number;
  /** Longest accelerating half we accept, ms. */
  maxHalfMs: number;
  /** Ignore gestures while the phone rotates faster than this, deg/s. */
  maxRotationDps: number;
}

export const DEFAULT_THROTTLE_TUNING: ThrottleTuning = {
  startThreshold: 1.2,
  quietThreshold: 0.5,
  quietMs: 180,
  maxHalfMs: 700,
  maxRotationDps: 200,
};

export interface DisplacementTuning {
  /** |a| below which the phone counts as still, m/s². */
  stillAccel: number;
  /** Rotation rate below which the phone counts as still, deg/s. */
  stillDps: number;
  /** How long it must be quiet before velocity is zeroed, ms. */
  stillMs: number;
  /** Below this estimated speed a quiet phone is at rest, m/s. Faster and quiet = cruising. */
  stillSpeed: number;
  /** A quiet phone is always at rest after this long, ms, whatever the velocity estimate says. */
  stillForceMs: number;
  /** Velocity leak time constant, s. Bounds drift during long moves. */
  velocityTau: number;
  /** Displacement leak time constant, s. Slowly returns the base to the hand. */
  displacementTau: number;
  /** Clamp on displacement, m. */
  maxDisplacement: number;
}

export const DEFAULT_DISPLACEMENT_TUNING: DisplacementTuning = {
  stillAccel: 0.3,
  stillDps: 40,
  stillMs: 250,
  stillSpeed: 0.12,
  stillForceMs: 900,
  velocityTau: 3,
  displacementTau: 60,
  maxDisplacement: 0.4,
};

type Phase = 'idle' | 'integrating' | 'settling';

export class ThrottleGesture {
  readonly rate = new RateMeter();
  readonly history: Impulse[] = [];
  phase: Phase = 'idle';
  /** Last raw a_z sample, for the debug panel. */
  az = 0;
  available = false;
  kind: MotionKind = 'none';
  /** Set by the app: the phone's current device→world quaternion, for gravity removal. */
  orientation: THREE.Quaternion | null = null;
  private sensor: LinearAccelerationSensor | null = null;
  private lastSensorT = 0;
  private readonly gravity = new THREE.Vector3();
  private readonly invQ = new THREE.Quaternion();
  private sign = 0;
  private integral = 0;
  private startT = 0;
  private quietSince = 0;
  private lastT = 0;
  private readonly listeners = new Set<(i: Impulse) => void>();
  private readonly vectorListeners = new Set<(ax: number, ay: number, az: number, dps: number, dt: number, now: number) => void>();

  /**
   * Displacement estimate along the screen normal, metres, positive = away
   * from the user, relative to the base set by `rebase()`. Velocity is zeroed
   * whenever the phone is still (zero-velocity update), so drift only
   * accumulates while it moves.
   */
  x = 0;
  /** Estimated velocity along the screen normal, m/s, positive = away. */
  v = 0;
  private stillSince = 0;
  still = true;

  constructor(
    public tuning: ThrottleTuning = { ...DEFAULT_THROTTLE_TUNING },
    public displacement: DisplacementTuning = { ...DEFAULT_DISPLACEMENT_TUNING },
  ) {}

  /** Make the current phone position the base (zero displacement). */
  rebase(): void {
    this.x = 0;
    this.v = 0;
  }

  private integrate(az: number, rotationDps: number, dt: number, now: number): void {
    const d = this.displacement;
    const a = -az; // away from the user is -Z in the device frame
    if (Math.abs(a) < d.stillAccel && rotationDps < d.stillDps) {
      if (!this.stillSince) this.stillSince = now;
      const quietFor = now - this.stillSince;
      // Quiet and slow = at rest. Quiet but fast = cruising at constant speed; keep integrating,
      // unless it has been quiet so long that the velocity must be drift.
      if ((quietFor > d.stillMs && Math.abs(this.v) < d.stillSpeed) || quietFor > d.stillForceMs) {
        this.v = 0;
        this.still = true;
      }
    } else {
      this.stillSince = 0;
      this.still = false;
    }
    this.v = (this.v + a * dt) * Math.exp(-dt / d.velocityTau);
    this.x = (this.x + this.v * dt) * Math.exp(-dt / d.displacementTau);
    this.x = Math.max(-d.maxDisplacement, Math.min(d.maxDisplacement, this.x));
  }

  onImpulse(fn: (i: Impulse) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Full gravity-free acceleration vector (device frame) per sample, for other consumers. */
  onVector(fn: (ax: number, ay: number, az: number, dps: number, dt: number, now: number) => void): () => void {
    this.vectorListeners.add(fn);
    return () => this.vectorListeners.delete(fn);
  }

  private emitVector(ax: number, ay: number, az: number, dps: number, dt: number, now: number): void {
    for (const fn of this.vectorListeners) fn(ax, ay, az, dps, dt, now);
  }

  private onMotion = (e: DeviceMotionEvent): void => {
    // The Generic Sensor path has priority once it delivers readings.
    if (this.kind === 'linear-acceleration-sensor') return;
    const rr = e.rotationRate;
    const dps = rr ? Math.hypot(rr.alpha ?? 0, rr.beta ?? 0, rr.gamma ?? 0) : 0;
    // `interval` is ms in the spec; some browsers report seconds.
    let dt = e.interval > 1 ? e.interval / 1000 : e.interval;
    if (!dt || !isFinite(dt)) dt = 1 / 60;

    const a = e.acceleration;
    if (a && a.z !== null) {
      this.kind = 'devicemotion';
      this.available = true;
      const now = performance.now();
      this.sample(a.z, dps, dt, now);
      this.emitVector(a.x ?? 0, a.y ?? 0, a.z, dps, dt, now);
      return;
    }
    // No gravity-free reading: remove gravity ourselves using the orientation.
    const g = e.accelerationIncludingGravity;
    if (g && g.z !== null && this.orientation) {
      this.kind = 'devicemotion+gravity';
      this.available = true;
      // At rest a flat phone reports +9.81 on z (reaction to gravity), i.e. world "up" in the device frame.
      this.invQ.copy(this.orientation).invert();
      this.gravity.set(0, 9.81, 0).applyQuaternion(this.invQ);
      const now = performance.now();
      this.sample(g.z - this.gravity.z, dps, dt, now);
      this.emitVector((g.x ?? 0) - this.gravity.x, (g.y ?? 0) - this.gravity.y, g.z - this.gravity.z, dps, dt, now);
    }
  };

  private startSensor(): void {
    if (typeof LinearAccelerationSensor === 'undefined') return;
    try {
      const s = new LinearAccelerationSensor({ frequency: 60 });
      s.onerror = () => { this.sensor = null; };
      s.onreading = () => {
        if (s.z === null) return;
        const now = performance.now();
        const dt = this.lastSensorT ? Math.min(0.1, (now - this.lastSensorT) / 1000) : 1 / 60;
        this.lastSensorT = now;
        this.kind = 'linear-acceleration-sensor';
        this.available = true;
        // No rotation rate on this path; the gyro gate is skipped.
        this.sample(s.z, 0, dt, now);
        this.emitVector(s.x ?? 0, s.y ?? 0, s.z, 0, dt, now);
      };
      s.start();
      this.sensor = s;
    } catch {
      this.sensor = null;
    }
  }

  /** Feed one sample. `az` in m/s² (device frame, gravity removed), `dt` in seconds. */
  sample(az: number, rotationDps: number, dt: number, now: number): void {
    this.rate.tick(now);
    this.az = az;
    this.lastT = now;
    this.integrate(az, rotationDps, dt, now);
    const t = this.tuning;
    const abs = Math.abs(az);
    switch (this.phase) {
      case 'idle':
        if (abs >= t.startThreshold && rotationDps < t.maxRotationDps) {
          this.phase = 'integrating';
          this.sign = Math.sign(az);
          this.integral = az * dt;
          this.startT = now;
        }
        break;
      case 'integrating': {
        const flipped = Math.sign(az) === -this.sign && abs > t.quietThreshold;
        const tooLong = now - this.startT > t.maxHalfMs;
        if (flipped || tooLong) {
          // Push away = negative z velocity; report push as positive.
          const impulse: Impulse = { value: -this.integral, ms: now - this.startT, t: now };
          this.history.push(impulse);
          if (this.history.length > 20) this.history.shift();
          for (const fn of this.listeners) fn(impulse);
          this.phase = 'settling';
          this.quietSince = now;
        } else {
          this.integral += az * dt;
        }
        break;
      }
      case 'settling':
        if (abs > t.quietThreshold) this.quietSince = now;
        else if (now - this.quietSince > t.quietMs) this.phase = 'idle';
        // Safety valve: never stay in settling for more than 2 s.
        if (now - this.startT > 2000) this.phase = 'idle';
        break;
    }
  }

  start(): void {
    this.startSensor();
    window.addEventListener('devicemotion', this.onMotion);
  }

  stop(): void {
    this.sensor?.stop();
    this.sensor = null;
    window.removeEventListener('devicemotion', this.onMotion);
  }

  static available(): boolean {
    return 'DeviceMotionEvent' in window;
  }
}
