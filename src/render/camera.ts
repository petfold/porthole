/**
 * True-geometry camera (D-05). The vertical field of view is the angle the
 * screen subtends at the assumed viewing distance. Browsers do not expose
 * physical screen size; a CSS pixel on Android is nominally 1/160 inch, and a
 * calibration factor (persisted) corrects the estimate.
 */
import * as THREE from 'three';

export const VIEWING_DISTANCE_M = 0.4;
const NOMINAL_MM_PER_CSS_PX = 25.4 / 160;
const KEY = 'porthole.screenCalibration';

export class WindowCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** Multiplier on the nominal CSS-px size. 1.0 = trust the browser. */
  calibration: number;

  constructor() {
    this.camera = new THREE.PerspectiveCamera(20, 1, 0.05, 1000);
    let c = 1;
    try { c = parseFloat(localStorage.getItem(KEY) ?? '1') || 1; } catch { /* no storage */ }
    this.calibration = c;
    this.resize();
  }

  get mmPerCssPx(): number {
    return NOMINAL_MM_PER_CSS_PX * this.calibration;
  }

  /** Estimated physical size of the viewport in millimetres. */
  get viewportMm(): { w: number; h: number } {
    return { w: window.innerWidth * this.mmPerCssPx, h: window.innerHeight * this.mmPerCssPx };
  }

  /** Vertical FOV in degrees for the current viewport. */
  get verticalFovDeg(): number {
    const hM = this.viewportMm.h / 1000;
    return THREE.MathUtils.radToDeg(2 * Math.atan(hM / 2 / VIEWING_DISTANCE_M));
  }

  setCalibration(c: number): void {
    this.calibration = THREE.MathUtils.clamp(c, 0.5, 2);
    try { localStorage.setItem(KEY, String(this.calibration)); } catch { /* ignore */ }
    this.resize();
  }

  resize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.fov = this.verticalFovDeg;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Off-axis ("generalized") perspective: the screen is a window of the
   * viewport's physical size centred on the origin of the screen frame,
   * and the eye sits at (ex, ey, ez) in that frame (z toward the user).
   * The frustum passes exactly through the window's edges, so the picture
   * is correct for that eye position and nothing is warped (D-05, D-27).
   * Call every frame; it replaces the symmetric projection from `resize`.
   */
  applyEye(ex: number, ey: number, ez: number): void {
    const vp = this.viewportMm;
    const w = vp.w / 1000, h = vp.h / 1000;
    const n = this.camera.near, f = this.camera.far;
    const s = n / Math.max(0.02, ez);
    const left = (-w / 2 - ex) * s;
    const right = (w / 2 - ex) * s;
    const top = (h / 2 - ey) * s;
    const bottom = (-h / 2 - ey) * s;
    this.camera.projectionMatrix.makePerspective(left, right, top, bottom, n, f, this.camera.coordinateSystem);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
  }
}
