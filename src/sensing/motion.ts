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
import { RateMeter } from './rate';

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
  startThreshold: 2.0,
  quietThreshold: 0.6,
  quietMs: 180,
  maxHalfMs: 700,
  maxRotationDps: 200,
};

type Phase = 'idle' | 'integrating' | 'settling';

export class ThrottleGesture {
  readonly rate = new RateMeter();
  readonly history: Impulse[] = [];
  phase: Phase = 'idle';
  /** Last raw a_z sample, for the debug panel. */
  az = 0;
  available = false;
  private sign = 0;
  private integral = 0;
  private startT = 0;
  private quietSince = 0;
  private lastT = 0;
  private readonly listeners = new Set<(i: Impulse) => void>();

  constructor(public tuning: ThrottleTuning = { ...DEFAULT_THROTTLE_TUNING }) {}

  onImpulse(fn: (i: Impulse) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private onMotion = (e: DeviceMotionEvent): void => {
    const a = e.acceleration;
    if (!a || a.z === null) return;
    this.available = true;
    const rr = e.rotationRate;
    const dps = rr ? Math.hypot(rr.alpha ?? 0, rr.beta ?? 0, rr.gamma ?? 0) : 0;
    // `interval` is ms in the spec; some browsers report seconds.
    let dt = e.interval > 1 ? e.interval / 1000 : e.interval;
    if (!dt || !isFinite(dt)) dt = 1 / 60;
    this.sample(a.z, dps, dt, performance.now());
  };

  /** Feed one sample. `az` in m/s² (device frame, gravity removed), `dt` in seconds. */
  sample(az: number, rotationDps: number, dt: number, now: number): void {
    this.rate.tick(now);
    this.az = az;
    this.lastT = now;
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
    window.addEventListener('devicemotion', this.onMotion);
  }

  stop(): void {
    window.removeEventListener('devicemotion', this.onMotion);
  }

  static available(): boolean {
    return 'DeviceMotionEvent' in window;
  }
}
