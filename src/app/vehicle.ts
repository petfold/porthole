/**
 * The vehicle: position on the ground, heading, speed. Three steering modes
 * are available for the Phase 1 feel test (D-10 is PROPOSED):
 *
 *  - 'look'     heading = view yaw; you go where you look. Recentre is inert.
 *  - 'yawrate'  phone yaw relative to a body reference is a handlebar angle;
 *               heading turns at a rate proportional to it. The view is the
 *               phone relative to the vehicle. Recentre sets the reference.
 *  - 'roll'     banking the phone steers; yaw looks freely. Recentre inert.
 *
 * The camera is `rotY(viewOffset) * phoneQuaternion`, so `viewOffset` is the
 * only thing that ever rotates the world, and it is a rigid rotation (D-05).
 */
import * as THREE from 'three';

export type SteerMode = 'look' | 'yawrate' | 'roll';

/**
 * 'displacement': speed is proportional to how far the phone is held from its
 *                 base position (a joystick in space). Default.
 * 'impulse':      each push or pull adds or subtracts speed; the vehicle coasts.
 */
export type ThrottleMode = 'displacement' | 'impulse';

export interface VehicleTuning {
  maxSpeed: number;        // m/s forward
  maxReverse: number;      // m/s backward
  impulseGain: number;     // m/s of speed per m/s of phone impulse
  brakeTau: number;        // s, exponential decay while braking
  yawRateGain: number;     // rad/s of turn per rad of handlebar (yawrate mode)
  rollRateGain: number;    // rad/s of turn per rad of bank (roll mode)
  rollDeadband: number;    // rad
  /** Displacement mode: metres of push for full speed, and the deadband. */
  fullSpeedAt: number;     // m
  displacementDeadband: number; // m
  speedTau: number;        // s, smoothing toward the target speed
}

export const DEFAULT_VEHICLE_TUNING: VehicleTuning = {
  maxSpeed: 10,
  maxReverse: 2.5,
  impulseGain: 3,
  brakeTau: 0.35,
  yawRateGain: 1.2,
  rollRateGain: 1.0,
  rollDeadband: 0.08,
  fullSpeedAt: 0.12,
  displacementDeadband: 0.015,
  speedTau: 0.12,
};

export function forwardOf(heading: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(-Math.sin(heading), 0, -Math.cos(heading));
}

export function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export class Vehicle {
  readonly position = new THREE.Vector3();
  heading = 0;
  speed = 0;
  braking = false;
  mode: SteerMode = 'look';
  throttleMode: ThrottleMode = 'displacement';
  /** Displacement mode: target speed set each frame from the phone displacement. */
  targetSpeed = 0;
  /** Rotation of the world about Y relative to the sensor frame (radians). */
  viewOffset = 0;
  /** Phone yaw that means "straight ahead" (yawrate mode). */
  private refYaw = 0;
  /** Current handlebar or bank angle, for the HUD. */
  steer = 0;

  private readonly fwd = new THREE.Vector3();

  constructor(public tuning: VehicleTuning = { ...DEFAULT_VEHICLE_TUNING }, private readonly halfExtent = 100) {}

  /** Place the vehicle; `phoneYaw` is the current sensor yaw so the view starts along `heading`. */
  spawn(position: THREE.Vector3Like, heading: number, phoneYaw: number): void {
    this.position.copy(position);
    this.heading = heading;
    this.speed = 0;
    this.viewOffset = wrap(heading - phoneYaw);
    this.refYaw = phoneYaw;
  }

  get viewYaw(): number {
    return wrap(this.heading);
  }

  addImpulse(value: number): void {
    if (this.throttleMode !== 'impulse') return;
    this.speed = THREE.MathUtils.clamp(this.speed + value * this.tuning.impulseGain, -this.tuning.maxReverse, this.tuning.maxSpeed);
  }

  /** Displacement mode: map phone displacement (m, positive = away) to a target speed. */
  setDisplacement(x: number): void {
    if (this.throttleMode !== 'displacement') return;
    const t = this.tuning;
    const db = t.displacementDeadband;
    const d = Math.abs(x) > db ? x - Math.sign(x) * db : 0;
    const f = THREE.MathUtils.clamp(d / (t.fullSpeedAt - db), -1, 1);
    this.targetSpeed = f >= 0 ? f * t.maxSpeed : f * t.maxReverse;
  }

  /** Switch mode without moving the view. */
  setMode(mode: SteerMode, phoneYaw: number): void {
    this.mode = mode;
    this.heading = wrap(phoneYaw + this.viewOffset);
    this.refYaw = phoneYaw;
    this.steer = 0;
  }

  /** Make the current phone yaw "straight ahead" without moving the view. Only yawrate mode has a reference. */
  recentre(phoneYaw: number): boolean {
    if (this.mode !== 'yawrate') return false;
    const rel = wrap(phoneYaw - this.refYaw);
    this.heading = wrap(this.heading + rel);
    this.refYaw = phoneYaw;
    this.viewOffset = wrap(this.heading - this.refYaw);
    return true;
  }

  /** Advance by dt seconds. `phoneYaw` and `phoneRoll` come from the orientation source. */
  update(dt: number, phoneYaw: number, phoneRoll: number): void {
    switch (this.mode) {
      case 'look':
        this.heading = wrap(phoneYaw + this.viewOffset);
        this.steer = 0;
        break;
      case 'yawrate': {
        const rel = wrap(phoneYaw - this.refYaw);
        this.steer = rel;
        this.heading = wrap(this.heading + rel * this.tuning.yawRateGain * dt);
        this.viewOffset = wrap(this.heading - this.refYaw);
        break;
      }
      case 'roll': {
        const db = this.tuning.rollDeadband;
        const r = Math.abs(phoneRoll) > db ? phoneRoll - Math.sign(phoneRoll) * db : 0;
        this.steer = r;
        this.heading = wrap(this.heading + r * this.tuning.rollRateGain * dt);
        break;
      }
    }

    if (this.braking) {
      this.speed *= Math.exp(-dt / this.tuning.brakeTau);
      if (Math.abs(this.speed) < 0.05) this.speed = 0;
    } else if (this.throttleMode === 'displacement') {
      const k = 1 - Math.exp(-dt / this.tuning.speedTau);
      this.speed += (this.targetSpeed - this.speed) * k;
      if (Math.abs(this.speed) < 0.02 && this.targetSpeed === 0) this.speed = 0;
    }

    forwardOf(this.heading, this.fwd);
    this.position.addScaledVector(this.fwd, this.speed * dt);
    // Stay on the ground and inside the world.
    this.position.y = 0;
    const h = this.halfExtent - 0.5;
    if (Math.abs(this.position.x) > h || Math.abs(this.position.z) > h) {
      this.position.x = THREE.MathUtils.clamp(this.position.x, -h, h);
      this.position.z = THREE.MathUtils.clamp(this.position.z, -h, h);
      this.speed = 0;
    }
  }
}
