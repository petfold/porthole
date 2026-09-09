/**
 * Eye position from the front camera (D-27, D-29, D-30, spike S8).
 *
 * Two size cues give the distance: the spacing of the two pupils (63 mm,
 * corrected for head turn using the model's head pose) and the visible iris
 * diameter (11.7 mm, works with one eye in frame). The first S8 session
 * showed the iris cue compresses at close range while the pupil spacing
 * behaves, so pupil spacing is primary whenever both eyes are in frame and
 * the iris cue is continuously rescaled against it, then carries on alone
 * when an eye leaves the frame. The measured point is the entrance pupil,
 * the eye's centre of perspective.
 *
 * Inference runs in a worker so the render loop never waits for it. The
 * delegate (GPU or CPU) is chosen by measuring both on this device.
 *
 * Screen frame (also the device frame): x right, y up, z toward the user.
 */
import { RateMeter } from './rate';
import type { FaceResult, InMsg, OutMsg } from './eye.worker';

export const IRIS_MM = 11.7;
export const IPD_MM = 63;
export const DEFAULT_EYE_DISTANCE_M = 0.4;
/**
 * Focal length as a fraction of the longest capture side. Pixel 7a front
 * camera, S8 session 2 (pupil-spacing cue, head square): 492 px at 640 → 0.77.
 */
export const DEFAULT_FOCAL_NORM = 0.77;
const KEY_F = 'porthole.eyeFocalNorm';
/** How long a lost face keeps its last position before drifting back to the default. */
const LOST_HOLD_MS = 20_000;

export type EyeSide = 'left' | 'right';
export type Delegate = 'GPU' | 'CPU';

export interface EyeFix {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  eye: EyeSide;
  /** Which cue set z: pupil spacing or iris. */
  cue: 'ipd' | 'iris';
  irisPx: number;
  irisLeftPx: number;
  irisRightPx: number;
  ipdPx: number;
  /** Pupil spacing corrected for head turn, px. */
  ipdCorrPx: number;
  /** Foreshortening factor of the inter-eye axis (1 = facing the camera). */
  foreshorten: number;
  bothVisible: boolean;
  /** Distances implied by each cue, m. */
  zIpd: number | null;
  zIris: number;
  /** Head translation from the model's pose matrix (its own units), for records. */
  headTz: number | null;
  /** The full 4×4 column-major face-to-camera matrix, for records. */
  headMat: number[] | null;
  t: number;
}

export interface EyeTrackerOptions {
  rate: number;
  cameraOffset: { x: number; y: number };
  focalNorm: number | null;
  delegate: Delegate | 'auto';
}

function clampAbs(v: number, m: number): number { return Math.max(-m, Math.min(m, v)); }

export class EyeTracker {
  readonly rate = new RateMeter();
  fix: EyeFix | null = null;
  readonly eye = { x: 0, y: 0, z: DEFAULT_EYE_DISTANCE_M };
  tracking = false;
  private _status = 'off';
  get status(): string { return this._status; }
  set status(v: string) { if (v !== this._status) { this._status = v; console.info(`[eye] ${v}`); } }
  inferenceMs = 0;
  delegate: Delegate | '-' = '-';
  /** Mean inference time measured per delegate during auto-selection. */
  readonly delegateMs: Partial<Record<Delegate, number>> = {};
  focalNorm: number;
  /** Ratio of the pupil-spacing distance to the raw iris distance, learned while both eyes are visible. */
  irisScale = 1;
  readonly opts: EyeTrackerOptions;

  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private busy = false;
  private timer = 0;
  private lastVideoT = -1;
  private chosen: EyeSide = 'right';
  private switchSince = 0;
  private lastFaceT = 0;
  private reacquiredT = -Infinity;
  private bridgeBase = 0;
  private bridgeAtFix = 0;
  private displacement = () => 0;
  private sizeSamples: { iris: number; ipd: number; t: number }[] = [];
  private probe: { delegate: Delegate; ms: number[] } | null = null;
  private captureW = 0;
  private captureH = 0;

  constructor(opts?: Partial<EyeTrackerOptions>) {
    this.opts = { rate: 20, cameraOffset: { x: 0, y: 0.072 }, focalNorm: null, delegate: 'auto', ...opts };
    let stored: number | null = null;
    try { const v = localStorage.getItem(KEY_F); if (v) stored = parseFloat(v) || null; } catch { /* no storage */ }
    this.focalNorm = this.opts.focalNorm ?? stored ?? DEFAULT_FOCAL_NORM;
  }

  get focalPx(): number { return this.focalNorm * Math.max(this.captureW, this.captureH, 1); }
  get captureSize(): { w: number; h: number } { return { w: this.captureW, h: this.captureH }; }

  setDisplacementSource(fn: () => number): void { this.displacement = fn; }
  setRate(rate: number): void { this.opts.rate = rate; }

  async start(): Promise<void> {
    if (this.tracking) return;
    this.status = 'starting camera';
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    const video = document.createElement('video');
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    this.video = video;
    this.captureW = video.videoWidth;
    this.captureH = video.videoHeight;

    this.status = 'loading model';
    this.worker = new Worker(new URL('./eye.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<OutMsg>) => this.onWorker(e.data);
    const first: Delegate = this.opts.delegate === 'CPU' ? 'CPU' : 'GPU';
    await this.init(first);
    this.tracking = true;
    this.status = 'tracking';
    if (this.opts.delegate === 'auto') this.probe = { delegate: first, ms: [] };
    this.schedule();
  }

  private init(delegate: Delegate): Promise<void> {
    return new Promise((resolve, reject) => {
      const w = this.worker;
      if (!w) return reject(new Error('no worker'));
      const handler = (e: MessageEvent<OutMsg>) => {
        if (e.data.type === 'ready') { w.removeEventListener('message', handler); this.delegate = e.data.delegate; resolve(); }
        else if (e.data.type === 'error') {
          w.removeEventListener('message', handler);
          if (delegate === 'GPU') { console.warn('[eye] GPU delegate failed, using CPU:', e.data.message); this.init('CPU').then(resolve, reject); }
          else reject(new Error(e.data.message));
        }
      };
      w.addEventListener('message', handler);
      const msg: InMsg = {
        type: 'init',
        wasmBase: new URL('./mediapipe/wasm', document.baseURI).href,
        modelPath: new URL('./models/face_landmarker.task', document.baseURI).href,
        delegate,
      };
      w.postMessage(msg);
    });
  }

  stop(): void {
    this.tracking = false;
    clearTimeout(this.timer);
    this.worker?.postMessage({ type: 'close' } as InMsg);
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video = null;
    this.fix = null;
    this.busy = false;
    this.status = 'off';
  }

  private schedule(): void {
    if (!this.tracking) return;
    this.timer = window.setTimeout(() => { void this.grab(); this.schedule(); }, 1000 / this.opts.rate);
  }

  /** Capture a frame and hand it to the worker, unless it is still busy with the last one. */
  private async grab(): Promise<void> {
    const v = this.video;
    if (!v || !this.worker || this.busy || v.readyState < 2 || v.currentTime === this.lastVideoT) return;
    this.lastVideoT = v.currentTime;
    this.busy = true;
    try {
      const bitmap = await createImageBitmap(v);
      const msg: FrameMsg = { type: 'frame', bitmap, t: performance.now() };
      this.worker.postMessage(msg, [bitmap]);
    } catch {
      this.busy = false;
    }
  }

  private onWorker(m: OutMsg): void {
    if (m.type !== 'result') return;
    this.busy = false;
    if (!this.tracking) return;
    const now = performance.now();
    this.inferenceMs = m.ms;
    this.rate.tick(now);
    this.captureW = m.w; this.captureH = m.h;
    if (this.probe && m.ms > 0) this.stepProbe(m.ms);
    if (!m.face) {
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
    this.status = this.probe ? `tracking · timing ${this.probe.delegate}` : 'tracking';
    this.measure(m.face, m.w, m.h, m.t);
  }

  /** Auto delegate selection: time 8 frames on GPU, then 8 on CPU, keep the faster. */
  private stepProbe(ms: number): void {
    const p = this.probe!;
    p.ms.push(ms);
    if (p.ms.length < 8) return;
    const mean = p.ms.reduce((a, b) => a + b, 0) / p.ms.length;
    this.delegateMs[p.delegate] = mean;
    const other: Delegate = p.delegate === 'GPU' ? 'CPU' : 'GPU';
    if (this.delegateMs[other] === undefined) {
      this.probe = { delegate: other, ms: [] };
      void this.init(other).catch(() => { this.probe = null; });
      return;
    }
    this.probe = null;
    const best: Delegate = (this.delegateMs.GPU ?? Infinity) <= (this.delegateMs.CPU ?? Infinity) ? 'GPU' : 'CPU';
    console.info(`[eye] delegate timing GPU ${this.delegateMs.GPU?.toFixed(0)} ms, CPU ${this.delegateMs.CPU?.toFixed(0)} ms → ${best}`);
    if (best !== this.delegate) void this.init(best).catch(() => { /* keep current */ });
  }

  private measure(face: FaceResult, W: number, H: number, t0: number): void {
    const now = performance.now();
    const f = this.focalPx;
    const iris = (pts: [number, number][]) => {
      const p = pts.map(([x, y]) => ({ u: x * W, v: y * H }));
      const [c, r, t, l, b] = p as [typeof p[0], typeof p[0], typeof p[0], typeof p[0], typeof p[0]];
      const d = Math.max(Math.hypot(r.u - l.u, r.v - l.v), Math.hypot(t.u - b.u, t.v - b.v));
      const margin = 0.04;
      const visible = c.u > W * margin && c.u < W * (1 - margin) && c.v > H * margin && c.v < H * (1 - margin);
      return { u: c.u, v: c.v, d, visible };
    };
    const L = iris(face.left), R = iris(face.right);
    const ipdPx = Math.hypot(L.u - R.u, L.v - R.v);
    // Foreshortening of the inter-eye axis: the face frame's x axis projected onto the image plane.
    let foreshorten = 1;
    let headTz: number | null = null;
    if (face.mat && face.mat.length === 16) {
      const ax = face.mat[0]!, ay = face.mat[1]!, az = face.mat[2]!;
      const len = Math.hypot(ax, ay, az) || 1;
      foreshorten = Math.max(0.5, Math.hypot(ax, ay) / len);
      headTz = face.mat[14]!;
    }
    const ipdCorrPx = ipdPx / foreshorten;
    const bothVisible = L.visible && R.visible && ipdPx > 5;

    // D-29: the eye nearest the screen's centre axis, with hysteresis.
    const dGuess = bothVisible ? (f * IPD_MM) / 1000 / ipdCorrPx : (f * IRIS_MM) / 1000 / Math.max(1, (L.d + R.d) / 2);
    const axisU = W / 2 - (f * this.opts.cameraOffset.x) / dGuess;
    const axisV = H / 2 + (f * this.opts.cameraOffset.y) / dGuess;
    const distL = Math.hypot(L.u - axisU, L.v - axisV), distR = Math.hypot(R.u - axisU, R.v - axisV);
    const other: EyeSide = this.chosen === 'left' ? 'right' : 'left';
    const visibleOnly: EyeSide | null = L.visible && !R.visible ? 'left' : R.visible && !L.visible ? 'right' : null;
    if (visibleOnly && visibleOnly !== this.chosen) { this.chosen = visibleOnly; this.switchSince = 0; }
    else {
      const otherNearer = other === 'left' ? distL < distR - 0.2 * ipdPx : distR < distL - 0.2 * ipdPx;
      if (otherNearer && !visibleOnly) {
        if (!this.switchSince) this.switchSince = now;
        if (now - this.switchSince > 300) { this.chosen = other; this.switchSince = 0; }
      } else this.switchSince = 0;
    }
    const E = this.chosen === 'left' ? L : R;

    // Distance: pupil spacing when both eyes are in frame, iris (rescaled) otherwise.
    const zIrisRaw = (f * IRIS_MM) / 1000 / Math.max(1, E.d);
    const zIpd = bothVisible ? (f * IPD_MM) / 1000 / ipdCorrPx : null;
    if (zIpd !== null) {
      const ratio = zIpd / zIrisRaw;
      this.irisScale += (ratio - this.irisScale) * 0.1;
    }
    const zIris = zIrisRaw * this.irisScale;
    const z = zIpd ?? zIris;
    const x = -((E.u - W / 2) / f) * z + this.opts.cameraOffset.x;
    const y = -((E.v - H / 2) / f) * z + this.opts.cameraOffset.y;

    const prev = this.fix;
    const dtFix = prev ? (t0 - prev.t) / 1000 : 0;
    let vx = 0, vy = 0, vz = 0;
    if (prev && dtFix > 0.01 && dtFix < 0.3) {
      const phoneMoved = this.displacement() - this.bridgeAtFix;
      vx = clampAbs((x - prev.x) / dtFix, 1.5);
      vy = clampAbs((y - prev.y) / dtFix, 1.5);
      vz = clampAbs((z - phoneMoved - prev.z) / dtFix, 1.5);
    }
    this.fix = {
      x, y, z, vx, vy, vz, eye: this.chosen, cue: zIpd !== null ? 'ipd' : 'iris',
      irisPx: E.d, irisLeftPx: L.d, irisRightPx: R.d, ipdPx, ipdCorrPx, foreshorten, bothVisible, zIpd, zIris, headTz, headMat: face.mat, t: t0,
    };
    this.sizeSamples.push({ iris: E.d, ipd: ipdCorrPx, t: now });
    if (this.sizeSamples.length > 60) this.sizeSamples.shift();
    this.bridgeAtFix = this.displacement();
    this.bridgeBase = z;
  }

  /** Median iris and corrected pupil-spacing sizes (px) over the last `ms`. */
  recentSizes(ms = 1500): { iris: number; ipd: number; n: number } {
    const now = performance.now();
    const r = this.sizeSamples.filter((s) => now - s.t < ms);
    const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s[Math.floor(s.length / 2)] as number) : 0; };
    return { iris: med(r.map((s) => s.iris)), ipd: med(r.map((s) => s.ipd)), n: r.length };
  }

  /** Set the focal length from a known distance using the corrected pupil spacing. Returns samples used. */
  calibrate(distanceM: number): number {
    const r = this.recentSizes(1500);
    if (r.n < 3 || r.ipd <= 0) return 0;
    const fPx = (r.ipd * distanceM) / (IPD_MM / 1000);
    this.focalNorm = fPx / Math.max(this.captureW, this.captureH, 1);
    try { localStorage.setItem(KEY_F, String(this.focalNorm)); } catch { /* ignore */ }
    if (this.fix) {
      const scale = distanceM / this.fix.z;
      this.fix = { ...this.fix, x: this.fix.x * scale, y: this.fix.y * scale, z: distanceM, vx: 0, vy: 0, vz: 0 };
      this.bridgeBase = distanceM;
      this.bridgeAtFix = this.displacement();
    }
    return r.n;
  }

  update(dt: number): void {
    const now = performance.now();
    const lostFor = now - this.lastFaceT;
    if (!this.tracking || !this.fix || lostFor > LOST_HOLD_MS) {
      const k = 1 - Math.exp(-dt / (this.tracking ? 4 : 0.5));
      this.eye.x += (0 - this.eye.x) * k;
      this.eye.y += (0 - this.eye.y) * k;
      this.eye.z += (DEFAULT_EYE_DISTANCE_M - this.eye.z) * k;
      return;
    }
    const f = this.fix;
    const ahead = Math.min(0.15, Math.max(0, (Math.min(now, this.lastFaceT) - f.t) / 1000));
    const phoneMoved = this.displacement() - this.bridgeAtFix;
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
    return !!navigator.mediaDevices?.getUserMedia && typeof createImageBitmap === 'function';
  }
}

type FrameMsg = Extract<InMsg, { type: 'frame' }>;
