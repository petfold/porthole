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
  /** Eye velocity in the screen frame, m/s, from the previous fix (0 after a gap). */
  vx: number;
  vy: number;
  vz: number;
  eye: EyeSide;
  irisPx: number;
  /** Both iris sizes and the pupil spacing in pixels, for calibration records. */
  irisLeftPx: number;
  irisRightPx: number;
  ipdPx: number;
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
/** How long a lost face keeps its last position before drifting back to the default. */
const LOST_HOLD_MS = 20_000;

function clampAbs(v: number, m: number): number {
  return Math.max(-m, Math.min(m, v));
}

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
  /** performance.now() of the last frame in which a face was found. */
  private lastFaceT = 0;
  /** Recent iris sizes (px, with timestamps) for a robust calibration. */
  private irisSamples: { px: number; t: number }[] = [];
  /** Time when tracking was reacquired after a gap; smoothing is gentler for a moment. */
  private reacquiredT = -Infinity;
  /** Inertial displacement (m, positive = away from the user) at the last fix, for bridging. */
  private bridgeBase = 0;
  private bridgeAtFix = 0;
  private displacement = () => 0;

  constructor(opts?: Partial<EyeTrackerOptions>) {
    this.opts = { rate: 20, cameraOffset: { x: 0, y: 0.072 }, focalPx: null, ...opts };
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

  /** Median iris size (px) over the last `ms`, with the sample count. */
  recentIris(ms = 1500): { median: number; n: number } {
    const now = performance.now();
    const r = this.irisSamples.filter((s) => now - s.t < ms).map((s) => s.px).sort((a, b) => a - b);
    return { median: r.length ? (r[Math.floor(r.length / 2)] as number) : 0, n: r.length };
  }

  /** Video capture size, for records. */
  get captureSize(): { w: number; h: number } {
    return { w: this.video?.videoWidth ?? 0, h: this.video?.videoHeight ?? 0 };
  }

  /**
   * Calibrate the focal length: the user holds the phone at `distanceM` from
   * the eye. Uses the median iris size of the last 1.5 s so one noisy frame
   * cannot set it. Returns the number of samples used, 0 if too few.
   */
  calibrate(distanceM: number): number {
    const now = performance.now();
    const recent = this.irisSamples.filter((s) => now - s.t < 1500).map((s) => s.px).sort((a, b) => a - b);
    if (recent.length < 3) return 0;
    const median = recent[Math.floor(recent.length / 2)] as number;
    this.focalPx = (median * distanceM) / (IRIS_MM / 1000);
    try { localStorage.setItem(KEY_F, String(this.focalPx)); } catch { /* ignore */ }
    // Re-express the current fix with the new focal length so the view does not jump later.
    if (this.fix) {
      const scale = distanceM / this.fix.z;
      this.fix = { ...this.fix, x: this.fix.x * scale, y: this.fix.y * scale, z: distanceM, vx: 0, vy: 0, vz: 0 };
      this.bridgeBase = distanceM;
      this.bridgeBase = distanceM;
      this.bridgeAtFix = this.displacement();
    }
    return recent.length;
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
      // Keep the last fix: the view must not jump when the face is lost for a moment.
      // Only after a long absence does update() drift back to the default.
      if (this.fix) {
        const gap = now - this.lastFaceT;
        this.status = gap < LOST_HOLD_MS ? 'no face · holding last' : 'no face · returning to default';
        if (gap > LOST_HOLD_MS + 5000) this.fix = null;
      } else this.status = 'no face';
      return;
    }
    const gap = now - this.lastFaceT;
    if (this.fix && gap > 400) this.reacquiredT = now;
    this.lastFaceT = now;
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
    // The fix describes the frame at t0 (capture), not at the end of inference.
    const prev = this.fix;
    const dtFix = prev ? (t0 - prev.t) / 1000 : 0;
    let vx = 0, vy = 0, vz = 0;
    if (prev && dtFix > 0.01 && dtFix < 0.3) {
      // Velocity of the eye relative to the phone, minus what the phone itself did (bridged).
      const phoneMoved = this.displacement() - this.bridgeAtFix;
      vx = clampAbs((x - prev.x) / dtFix, 1.5);
      vy = clampAbs((y - prev.y) / dtFix, 1.5);
      vz = clampAbs((z - phoneMoved - prev.z) / dtFix, 1.5);
    }
    this.fix = { x, y, z, vx, vy, vz, eye: this.chosen, irisPx: E.d, irisLeftPx: L.d, irisRightPx: R.d, ipdPx, ipdDistance, t: t0 };
    this.irisSamples.push({ px: E.d, t: now });
    if (this.irisSamples.length > 60) this.irisSamples.shift();
    this.bridgeAtFix = this.displacement();
    this.bridgeBase = z;
  }

  /**
   * Call every frame. Target = last fix dead-reckoned forward by its velocity
   * (capped), plus the phone's own inertial displacement since the fix; then
   * a short exponential smoothing. After a tracking gap the smoothing is
   * gentler for a moment so reacquisition does not jump.
   */
  update(dt: number): void {
    const now = performance.now();
    const lostFor = now - this.lastFaceT;
    if (!this.tracking || !this.fix || lostFor > LOST_HOLD_MS) {
      // Return to the default distance slowly (only after a long loss, or when off).
      const k = 1 - Math.exp(-dt / (this.tracking ? 4 : 0.5));
      this.eye.x += (0 - this.eye.x) * k;
      this.eye.y += (0 - this.eye.y) * k;
      this.eye.z += (DEFAULT_EYE_DISTANCE_M - this.eye.z) * k;
      return;
    }
    const f = this.fix;
    // Extrapolate at most 150 ms; beyond that hold the position (a lost face stops the clock).
    const ahead = Math.min(0.15, Math.max(0, (Math.min(now, this.lastFaceT) - f.t) / 1000));
    const phoneMoved = this.displacement() - this.bridgeAtFix; // + = phone moved away from the user
    const tx = f.x + f.vx * ahead;
    const ty = f.y + f.vy * ahead;
    const tz = Math.max(0.05, f.z + f.vz * ahead + phoneMoved);
    const tau = now - this.reacquiredT < 800 ? 0.35 : 0.05;
    const k = 1 - Math.exp(-dt / tau);
    this.eye.x += (tx - this.eye.x) * k;
    this.eye.y += (ty - this.eye.y) * k;
    this.eye.z += (tz - this.eye.z) * k;
  }

  static available(): boolean {
    return !!navigator.mediaDevices?.getUserMedia;
  }
}
