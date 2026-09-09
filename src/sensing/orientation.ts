/**
 * Phone orientation as a three.js quaternion that can be assigned directly to
 * a camera: the camera's local -Z (its view direction) is the phone's -Z,
 * i.e. the direction through the screen away from the user. World frame is
 * three.js Y-up; the yaw origin is whatever the sensor started with, which is
 * why yaw is only ever used relative to a reference (see design §4.3).
 *
 * Source priority: RelativeOrientationSensor (Generic Sensor API, gyro-fused,
 * screen-referenced) → `deviceorientation` events → touch/mouse drag.
 */
import * as THREE from 'three';
import { RateMeter } from './rate';

export type OrientationKind = 'generic-sensor' | 'deviceorientation' | 'drag' | 'none';

export interface OrientationSource {
  readonly kind: OrientationKind;
  readonly quaternion: THREE.Quaternion;
  readonly rate: RateMeter;
  /** True once at least one reading has arrived. */
  readonly ready: boolean;
  start(): Promise<void>;
  stop(): void;
}

/** Sensor world (X east, Y north, Z up) → three.js world (Y up). */
const Z_UP_TO_Y_UP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

function screenAngleRad(): number {
  const a = screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0;
  return THREE.MathUtils.degToRad(a);
}

export class GenericSensorOrientation implements OrientationSource {
  readonly kind = 'generic-sensor' as const;
  readonly quaternion = new THREE.Quaternion();
  readonly rate = new RateMeter();
  ready = false;
  private sensor: RelativeOrientationSensor | null = null;
  private readonly tmp = new THREE.Quaternion();

  static available(): boolean {
    return typeof RelativeOrientationSensor !== 'undefined';
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        // 'screen' reference frame: the sensor already accounts for the
        // display rotation, so portrait and landscape need no correction.
        const s = new RelativeOrientationSensor({ frequency: 60, referenceFrame: 'screen' });
        this.sensor = s;
        s.onerror = (ev) => {
          if (!settled) { settled = true; reject(ev.error); }
          this.ready = false;
        };
        s.onreading = () => {
          const q = s.quaternion;
          if (!q) return;
          this.tmp.set(q[0], q[1], q[2], q[3]);
          this.quaternion.copy(Z_UP_TO_Y_UP).multiply(this.tmp);
          this.rate.tick();
          if (!this.ready) { this.ready = true; if (!settled) { settled = true; resolve(); } }
        };
        s.start();
        // If no reading comes within 1.5 s, treat as unavailable.
        setTimeout(() => { if (!settled) { settled = true; this.stop(); reject(new Error('no readings in 2 s')); } }, 2000);
      } catch (e) {
        reject(e);
      }
    });
  }

  stop(): void {
    this.sensor?.stop();
    this.sensor = null;
  }
}

export class DeviceOrientationSource implements OrientationSource {
  readonly kind = 'deviceorientation' as const;
  readonly quaternion = new THREE.Quaternion();
  readonly rate = new RateMeter();
  ready = false;
  private readonly euler = new THREE.Euler();
  private readonly q0 = new THREE.Quaternion();
  private readonly zee = new THREE.Vector3(0, 0, 1);
  private resolveFirst: (() => void) | null = null;

  static available(): boolean {
    return 'DeviceOrientationEvent' in window;
  }

  private onEvent = (e: DeviceOrientationEvent): void => {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    const alpha = THREE.MathUtils.degToRad(e.alpha);
    const beta = THREE.MathUtils.degToRad(e.beta);
    const gamma = THREE.MathUtils.degToRad(e.gamma);
    // Same construction as three.js's DeviceOrientationControls.
    this.euler.set(beta, alpha, -gamma, 'YXZ');
    this.quaternion.setFromEuler(this.euler);
    this.quaternion.multiply(Z_UP_TO_Y_UP);
    this.quaternion.multiply(this.q0.setFromAxisAngle(this.zee, -screenAngleRad()));
    this.rate.tick();
    if (!this.ready) { this.ready = true; this.resolveFirst?.(); this.resolveFirst = null; }
  };

  async start(): Promise<void> {
    // iOS needs an explicit permission; Chromium does not have this method.
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    let note = '';
    if (typeof DOE.requestPermission === 'function') {
      const r = await DOE.requestPermission().catch(() => 'error');
      if (r !== 'granted') note = ` (requestPermission: ${r})`;
    }
    // Listen regardless of the permission answer; some builds answer wrongly.
    window.addEventListener('deviceorientation', this.onEvent);
    await new Promise<void>((resolve, reject) => {
      this.resolveFirst = resolve;
      setTimeout(() => { if (!this.ready) { this.stop(); reject(new Error(`no readings in 2 s${note}`)); } }, 2000);
    });
  }

  stop(): void {
    window.removeEventListener('deviceorientation', this.onEvent);
  }
}

/** Desktop fallback: drag to look, arrow keys to look. */
export class DragOrientation implements OrientationSource {
  readonly kind = 'drag' as const;
  readonly quaternion = new THREE.Quaternion();
  readonly rate = new RateMeter();
  ready = true;
  yaw = 0;
  pitch = 0;
  roll = 0;
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(private readonly el: HTMLElement) {}

  private last: { x: number; y: number } | null = null;
  private onDown = (e: PointerEvent): void => { this.last = { x: e.clientX, y: e.clientY }; };
  private onUp = (): void => { this.last = null; };
  private onMove = (e: PointerEvent): void => {
    if (!this.last) return;
    const dx = e.clientX - this.last.x;
    const dy = e.clientY - this.last.y;
    this.last = { x: e.clientX, y: e.clientY };
    // Drag the world with the finger: dragging right looks left.
    this.yaw += dx * 0.004;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
    this.update();
  };
  private onKey = (e: KeyboardEvent): void => {
    const step = 0.05;
    if (e.key === 'ArrowLeft') this.yaw += step;
    else if (e.key === 'ArrowRight') this.yaw -= step;
    else if (e.key === 'q') this.roll = THREE.MathUtils.clamp(this.roll + step, -1, 1);
    else if (e.key === 'e') this.roll = THREE.MathUtils.clamp(this.roll - step, -1, 1);
    else return;
    this.update();
  };

  private update(): void {
    this.euler.set(this.pitch, this.yaw, this.roll, 'YXZ');
    this.quaternion.setFromEuler(this.euler);
    this.rate.tick();
  }

  async start(): Promise<void> {
    this.update();
    this.el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('keydown', this.onKey);
  }

  stop(): void {
    this.el.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('keydown', this.onKey);
  }
}

export interface OrientationChoice {
  source: OrientationSource;
  /** Why each higher-priority source was skipped. */
  log: string[];
}

/** Try sources in priority order; return the first that produces readings. */
export async function chooseOrientation(fallbackEl: HTMLElement, force?: OrientationKind): Promise<OrientationChoice> {
  const log: string[] = [];
  const tryStart = async (s: OrientationSource): Promise<boolean> => {
    try {
      await s.start();
      log.push(`${s.kind}: ok`);
      return true;
    } catch (e) {
      log.push(`${s.kind}: ${(e as Error).message ?? e}`);
      return false;
    }
  };
  if ((force === undefined || force === 'generic-sensor') && GenericSensorOrientation.available()) {
    const s = new GenericSensorOrientation();
    if (await tryStart(s)) return { source: s, log };
  } else if (force === undefined) log.push('generic-sensor: not in this browser');
  if ((force === undefined || force === 'deviceorientation') && DeviceOrientationSource.available()) {
    const s = new DeviceOrientationSource();
    if (await tryStart(s)) return { source: s, log };
  } else if (force === undefined) log.push('deviceorientation: not in this browser');
  const s = new DragOrientation(fallbackEl);
  await s.start();
  log.push('drag: fallback');
  return { source: s, log };
}

/** Yaw (rotation about world Y) of the view direction, radians; 0 = -Z, positive = counterclockwise from above. */
const fwd = new THREE.Vector3();
const up = new THREE.Vector3();
export function yawOf(q: THREE.Quaternion): number {
  fwd.set(0, 0, -1).applyQuaternion(q);
  const horiz = Math.hypot(fwd.x, fwd.z);
  if (horiz > 0.2) return Math.atan2(-fwd.x, -fwd.z);
  // Looking almost straight up or down: use the phone's top edge instead.
  up.set(0, 1, 0).applyQuaternion(q);
  const s = fwd.y < 0 ? 1 : -1; // looking down: top edge points forward
  return Math.atan2(-s * up.x, -s * up.z);
}

/** Roll: how far the phone's right edge is above horizontal, radians. Positive = banked left. */
const right = new THREE.Vector3();
export function rollOf(q: THREE.Quaternion): number {
  right.set(1, 0, 0).applyQuaternion(q);
  return Math.asin(THREE.MathUtils.clamp(right.y, -1, 1));
}
