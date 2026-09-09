/**
 * Passive sensor probe for spike S1. Listens to every orientation and motion
 * event stream regardless of which one drives the view, and tracks yaw drift
 * of the chosen source while the phone rests. Read by the debug panel only.
 */
import type * as THREE from 'three';
import { RateMeter } from './rate';
import { yawOf } from './orientation';

export class SensorProbe {
  readonly deviceorientation = new RateMeter();
  readonly deviceorientationabsolute = new RateMeter();
  readonly devicemotion = new RateMeter();
  /** Last relative and absolute alpha, for comparing compass vs gyro yaw. */
  alpha: number | null = null;
  alphaAbsolute: number | null = null;
  /** Yaw drift tracking of the chosen orientation source. */
  private driftStartYaw: number | null = null;
  private driftStartT = 0;
  driftDeg = 0;
  driftSeconds = 0;

  private onDO = (e: DeviceOrientationEvent): void => { this.deviceorientation.tick(); this.alpha = e.alpha; };
  private onDOA = (e: DeviceOrientationEvent): void => { this.deviceorientationabsolute.tick(); this.alphaAbsolute = e.alpha; };
  private onDM = (): void => { this.devicemotion.tick(); };

  start(): void {
    window.addEventListener('deviceorientation', this.onDO);
    window.addEventListener('deviceorientationabsolute' as 'deviceorientation', this.onDOA);
    window.addEventListener('devicemotion', this.onDM);
  }

  /** Call each frame with the chosen source's quaternion. */
  trackDrift(q: THREE.Quaternion, now = performance.now()): void {
    const yaw = yawOf(q);
    if (this.driftStartYaw === null) { this.driftStartYaw = yaw; this.driftStartT = now; }
    let d = yaw - this.driftStartYaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.driftDeg = (d * 180) / Math.PI;
    this.driftSeconds = (now - this.driftStartT) / 1000;
  }

  resetDrift(): void {
    this.driftStartYaw = null;
  }
}
