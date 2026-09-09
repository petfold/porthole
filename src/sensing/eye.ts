/**
 * Eye position from the front camera (D-27, D-29, spike S8).
 *
 * Distance comes from the apparent iris diameter: the visible iris is
 * 11.7 mm across in adults, so with a focal length `f` in pixels and an
 * iris of `p` pixels, distance = f × 11.7 mm / p. That distance is to the
 * entrance pupil, which is also the eye's centre of perspective. Lateral
 * position comes from the pixel offset of the iris centre. Landmarks come
 * from MediaPipe Face Landmarker at a configurable rate; between fixes the
 * inertial displacement estimator carries the distance forward.
 *
 * Screen frame (also the device frame): x right, y up, z toward the user.
 */
import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import { RateMeter } from './rate';

export const IRIS_MM = 11.7;
export const IPD_MM = 63;
export const DEFAULT_EYE_DISTANCE_M = 0.4;

/** MediaPipe iris landmark indices: [centre, right, top, left, bottom] in image space. */
const LEFT_IRIS = [468, 469, 470, 471, 472];
const RIGHT_IRIS = [473, 474, 475, 476, 477];

export type EyeSide = 'left' | 'right';

export interface EyeFix {
  /** Eye position in the screen frame, metres. */
  x: number;
  y: number;
  z: number;
  eye: EyeSide;
  irisPx: number;
  /** Distance from the IPD cue when both eyes were visible, else null. */
  ipdDistance: number | null;
  t: number;
}

export interface EyeTrackerOptions {
  /** Inferences per second. */
  rate: number;
  /** Camera position relative to the screen centre, screen frame, metres. Pixel 7a: hole at top centre. */
  cameraOffset: { x: number; y: number };
  /** Focal length in pixels for the requested capture size; null = estimate from a 95° diagonal FOV. */
  focalPx: number | null;
}

const KEY_F = 'porthole.eyeFocalPx';

export class EyeTracker {
  readonly rate = new RateMeter();
  /** Latest camera fix, or null when no face has been seen recently. */
  fix: EyeFix | null = null;
  /** Smoothed eye position used for rendering, screen frame, metres. */
  readonly eye = { x: 0, y: 0, z: DEFAULT_EYE_DISTANCE_M };
  tracking = false;
  private _status = 'off';
  get status(): string { return this._status; }
  set status(v: string) { if (v !== this._status) { this._status = v; console.info(`[eye] ${v}`); } }
  inferenceMs = 0;
  delegate: 'GPU' | 'CPU' | '-' = '-';
  focalPx: number;
  readonly opts: EyeTrackerOptions;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private landmarker: FaceLandmarker | null = null;
  private timer = 0;
  private lastVideoT = -1;
  private chosen: EyeSide = 'right';
  private switchSince = 0;
  /** Inertial displacement (m, positive = away from the user) at the last fix, for bridging. */
  private bridgeBase = 0;
  private bridgeAtFix = 0;
  private displacement = () => 0;

  constructor(opts?: Partial<EyeTrackerOptions>) {
    this.opts = { rate: 10, cameraOffset: { x: 0, y: 0.072 }, focalPx: null, ...opts };
    let stored: number | null = null;
    try { const v = localStorage.getItem(KEY_F); if (v) stored = parseFloat(v) || null; } catch { /* no storage */ }
    this.focalPx = this.opts.focalPx ?? stored ?? 0; // 0 = derive from the capture size once known
  }

  /** Provide the inertial displacement source (metres along the screen normal, positive = away). */
  setDisplacementSource(fn: () => number): void {
    this.displacement = fn;
  }

  async start(): Promise<void> {
    if (this.tracking) return;
    this.status = 'starting camera';
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: Math.max(15, this.opts.rate) } },
      audio: false,
    });
    const video = document.createElement('video');
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    this.video = video;
    if (!this.focalPx) {
      // Assume a 95° diagonal field of view (typical wide selfie camera) until calibrated.
      const diag = Math.hypot(video.videoWidth, video.videoHeight);
      this.focalPx = diag / 2 / Math.tan((95 / 2) * Math.PI / 180);
    }
    this.status = 'loading model';
    const fileset = await FilesetResolver.forVisionTasks('./mediapipe/wasm');
    const create = (delegate: 'GPU' | 'CPU') => FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: './models/face_landmarker.task', delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
    try {
      this.landmarker = await create('GPU');
      this.delegate = 'GPU';
    } catch (e) {
      console.warn('[eye] GPU delegate failed, using CPU', e);
      this.landmarker = await create('CPU');
      this.delegate = 'CPU';
    }
    this.tracking = true;
    this.status = 'tracking';
    this.schedule();
  }

  stop(): void {
    this.tracking = false;
    clearTimeout(this.timer);
    this.landmarker?.close();
    this.landmarker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video = null;
    this.fix = null;
    this.status = 'off';
  }

  setRate(rate: number): void {
    this.opts.rate = rate;
  }

  /** Calibrate the focal length: the user holds the phone at `distanceM` from the eye. */
  calibrate(distanceM: number): boolean {
    if (!this.fix) return false;
    this.focalPx = (this.fix.irisPx * distanceM) / (IRIS_MM / 1000);
    try { localStorage.setItem(KEY_F, String(this.focalPx)); } catch { /* ignore */ }
    return true;
  }

  private schedule(): void {
    if (!this.tracking) return;
    this.timer = window.setTimeout(() => { this.infer(); this.schedule(); }, 1000 / this.opts.rate);
  }

  private infer(): void {
    const v = this.video, lm = this.landmarker;
    if (!v || !lm || v.readyState < 2) return;
    const now = performance.now();
    if (v.currentTime === this.lastVideoT) return;
    this.lastVideoT = v.currentTime;
    const t0 = performance.now();
    let res: FaceLandmarkerResult;
    try { res = lm.detectForVideo(v, now); } catch { return; }
    this.inferenceMs = performance.now() - t0;
    this.rate.tick(now);
    const face = res.faceLandmarks[0];
    if (!face || face.length < 478) {
      if (this.fix && now - this.fix.t > 1500) { this.fix = null; this.status = 'no face'; }
      return;
    }
    this.status = 'tracking';
    const W = v.videoWidth, H = v.videoHeight;
    const px = (i: number) => { const l = face[i]!; return { u: l.x * W, v: l.y * H }; };
    const iris = (idx: number[]) => {
      const c = px(idx[0]!), r = px(idx[1]!), t = px(idx[2]!), l = px(idx[3]!), b = px(idx[4]!);
      // The iris is a circle; seen obliquely it is an ellipse whose major axis is the true diameter.
      const d = Math.max(Math.hypot(r.u - l.u, r.v - l.v), Math.hypot(t.u - b.u, t.v - b.v));
      return { ...c, d };
    };
    const L = iris(LEFT_IRIS), R = iris(RIGHT_IRIS);

    // D-29: the eye whose image is nearest the screen's centre axis. The camera is above the
    // screen centre, so that axis appears below the image centre by f × offset / distance.
    const dGuess = (this.focalPx * (IRIS_MM / 1000)) / Math.max(1, (L.d + R.d) / 2);
    const axisU = W / 2 - (this.focalPx * this.opts.cameraOffset.x) / dGuess; // image u runs opposite to screen x
    const axisV = H / 2 + (this.focalPx * this.opts.cameraOffset.y) / dGuess;
    const distL = Math.hypot(L.u - axisU, L.v - axisV), distR = Math.hypot(R.u - axisU, R.v - axisV);
    const ipdPx = Math.hypot(L.u - R.u, L.v - R.v);
    const other: EyeSide = this.chosen === 'left' ? 'right' : 'left';
    const otherNearer = other === 'left' ? distL < distR - 0.2 * ipdPx : distR < distL - 0.2 * ipdPx;
    if (otherNearer) {
      if (!this.switchSince) this.switchSince = now;
      if (now - this.switchSince > 300) { this.chosen = other; this.switchSince = 0; }
    } else this.switchSince = 0;
    const E = this.chosen === 'left' ? L : R;

    const z = (this.focalPx * (IRIS_MM / 1000)) / E.d;
    // Pixel offsets to metres at that distance; image u opposes screen x, image v opposes screen y.
    const x = -((E.u - W / 2) / this.focalPx) * z + this.opts.cameraOffset.x;
    const y = -((E.v - H / 2) / this.focalPx) * z + this.opts.cameraOffset.y;
    const ipdDistance = ipdPx > 1 ? (this.focalPx * (IPD_MM / 1000)) / ipdPx : null;
    this.fix = { x, y, z, eye: this.chosen, irisPx: E.d, ipdDistance, t: now };
    this.bridgeAtFix = this.displacement();
    this.bridgeBase = z;
  }

  /** Call every frame: fuse the last fix with the inertial displacement and smooth. */
  update(dt: number): void {
    if (!this.tracking || !this.fix) {
      // Fall back to the default distance, gently.
      const k = 1 - Math.exp(-dt / 0.5);
      this.eye.x += (0 - this.eye.x) * k;
      this.eye.y += (0 - this.eye.y) * k;
      this.eye.z += (DEFAULT_EYE_DISTANCE_M - this.eye.z) * k;
      return;
    }
    // Moving the phone away from the user (positive displacement) increases the eye distance.
    const bridged = Math.max(0.05, this.bridgeBase + (this.displacement() - this.bridgeAtFix));
    const k = 1 - Math.exp(-dt / 0.12);
    this.eye.x += (this.fix.x - this.eye.x) * k;
    this.eye.y += (this.fix.y - this.eye.y) * k;
    this.eye.z += (bridged - this.eye.z) * k;
  }

  static available(): boolean {
    return !!navigator.mediaDevices?.getUserMedia;
  }
}
