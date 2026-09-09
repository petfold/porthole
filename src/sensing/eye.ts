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
 * Inference runs in workers so the render loop never waits for it. Two
 * models: BlazeFace (detector worker, about a millisecond) supplies the eye
 * centres every frame; Face Landmarker (landmarker worker, slow on this
 * phone) runs at a low duty cycle for the iris sizes and the head pose. Its
 * delegate (GPU or CPU) is chosen by measuring both on this device.
 *
 * Screen frame (also the device frame): x right, y up, z toward the user.
 */
import { RateMeter } from './rate';
import type { DetectResult, FaceResult, InMsg, OutMsg, Role } from './eye.worker';

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

export type ModelMode = 'auto' | 'detector' | 'landmarker';

export interface EyeTrackerOptions {
  rate: number;
  cameraOffset: { x: number; y: number };
  focalNorm: number | null;
  delegate: Delegate | 'auto';
  /** 'auto': detector every frame + landmarker at low duty; or one model only (for S8 comparisons). */
  model: ModelMode;
  /** Landmarker duty cycle in 'auto' mode: fraction of wall time it may be busy. */
  landmarkerDuty: number;
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
  /** Inference time of the last frame, per model. */
  inferenceMs = 0;
  detectorMs = 0;
  landmarkerMs = 0;
  delegate: Delegate | '-' = '-';
  detectorDelegate: Delegate | '-' = '-';
  /** Which model produced the last fix. */
  lastSource: Role | '-' = '-';
  readonly detectorRate = new RateMeter();
  readonly landmarkerRate = new RateMeter();
  /** Mean inference time measured per delegate during auto-selection. */
  readonly delegateMs: Partial<Record<Delegate, number>> = {};
  focalNorm: number;
  /** Ratio of the pupil-spacing distance to the raw iris distance, learned while both eyes are visible. */
  irisScale = 1;
  readonly opts: EyeTrackerOptions;

  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;          // landmarker
  private detWorker: Worker | null = null;       // detector
  private busy = false;
  private detBusy = false;
  private lmDoneT = 0;
  private lmStartT = 0;
  /** Latest head-turn foreshortening from the landmarker and when it was measured. */
  private foreshorten = 1;
  private foreshortenT = -Infinity;
  private lastIris: { L: number; R: number; t: number } | null = null;
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
    this.opts = { rate: 30, cameraOffset: { x: 0, y: 0.072 }, focalNorm: null, delegate: 'auto', model: 'auto', landmarkerDuty: 0.25, ...opts };
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

    this.status = 'loading models';
    const mode = this.opts.model;
    if (mode !== 'detector') {
      this.worker = new Worker(new URL('./eye.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<OutMsg>) => this.onWorker(e.data);
      const first: Delegate = this.opts.delegate === 'CPU' ? 'CPU' : 'GPU';
      await this.init(this.worker, 'landmarker', first);
      if (this.opts.delegate === 'auto') this.probe = { delegate: first, ms: [] };
    }
    if (mode !== 'landmarker') {
      this.detWorker = new Worker(new URL('./eye.worker.ts', import.meta.url), { type: 'module' });
      this.detWorker.onmessage = (e: MessageEvent<OutMsg>) => this.onWorker(e.data);
      try {
        // The detector is cheap on the CPU; the GPU delegate only adds set-up and transfer cost.
        await this.init(this.detWorker, 'detector', this.opts.delegate === 'GPU' ? 'GPU' : 'CPU');
      } catch (e) {
        console.warn('[eye] detector unavailable, landmarker only:', (e as Error).message);
        this.detWorker.terminate();
        this.detWorker = null;
        if (!this.worker) throw e;
      }
    }
    this.tracking = true;
    this.status = 'tracking';
    this.schedule();
  }

  private init(w: Worker, role: Role, delegate: Delegate): Promise<void> {
    return new Promise((resolve, reject) => {
      const handler = (e: MessageEvent<OutMsg>) => {
        if (e.data.type === 'ready' && e.data.role === role) {
          w.removeEventListener('message', handler);
          if (role === 'landmarker') this.delegate = e.data.delegate; else this.detectorDelegate = e.data.delegate;
          resolve();
        } else if (e.data.type === 'error' && e.data.role === role) {
          w.removeEventListener('message', handler);
          if (delegate === 'GPU') { console.warn(`[eye] ${role} GPU delegate failed, using CPU:`, e.data.message); this.init(w, role, 'CPU').then(resolve, reject); }
          else reject(new Error(e.data.message));
        }
      };
      w.addEventListener('message', handler);
      const msg: InMsg = {
        type: 'init',
        role,
        wasmBase: new URL('./mediapipe/wasm', document.baseURI).href,
        modelPath: new URL(role === 'landmarker' ? './models/face_landmarker.task' : './models/blaze_face_short_range.tflite', document.baseURI).href,
        delegate,
      };
      w.postMessage(msg);
    });
  }

  stop(): void {
    this.tracking = false;
    clearTimeout(this.timer);
    for (const w of [this.worker, this.detWorker]) { w?.postMessage({ type: 'close' } as InMsg); w?.terminate(); }
    this.worker = null;
    this.detWorker = null;
    this.detBusy = false;
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

  /** Capture a frame for each worker that is idle and due. */
  private async grab(): Promise<void> {
    const v = this.video;
    if (!v || v.readyState < 2 || v.currentTime === this.lastVideoT) return;
    const now = performance.now();
    const wantDet = !!this.detWorker && !this.detBusy;
    // Landmarker: always when it is the only model; otherwise keep its duty cycle bounded.
    let wantLm = !!this.worker && !this.busy;
    if (wantLm && this.detWorker) {
      const lastCost = this.lmDoneT - this.lmStartT;
      const idleFor = now - this.lmDoneT;
      wantLm = this.probe !== null || idleFor >= Math.max(250, lastCost * (1 / this.opts.landmarkerDuty - 1));
    }
    if (!wantDet && !wantLm) return;
    this.lastVideoT = v.currentTime;
    try {
      if (wantDet) {
        this.detBusy = true;
        const bitmap = await createImageBitmap(v);
        const msg: FrameMsg = { type: 'frame', bitmap, t: now };
        this.detWorker!.postMessage(msg, [bitmap]);
      }
      if (wantLm) {
        this.busy = true;
        this.lmStartT = now;
        const bitmap = await createImageBitmap(v);
        const msg: FrameMsg = { type: 'frame', bitmap, t: now + 0.01 };
        this.worker!.postMessage(msg, [bitmap]);
      }
    } catch {
      this.busy = false;
      this.detBusy = false;
    }
  }

  private onWorker(m: OutMsg): void {
    if (m.type !== 'result') return;
    const now = performance.now();
    if (m.role === 'detector') { this.detBusy = false; this.detectorMs = m.ms; this.detectorRate.tick(now); }
    else { this.busy = false; this.lmDoneT = now; this.landmarkerMs = m.ms; this.landmarkerRate.tick(now); if (this.probe && m.ms > 0) this.stepProbe(m.ms); }
    if (!this.tracking) return;
    this.captureW = m.w; this.captureH = m.h;

    // Landmarker output refreshes the head pose and iris sizes; it sets the fix only when there is no detector.
    if (m.role === 'landmarker' && m.face) {
      this.absorbLandmarks(m.face, m.w, m.h, now);
      if (this.detWorker) return;
    }
    if (m.role === 'detector' && !m.det && this.worker && this.fix && now - this.lastFaceT < 400) return; // landmarker may still see it
    const found = m.role === 'detector' ? !!m.det : !!m.face;
    if (!found) {
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
    this.lastSource = m.role;
    this.inferenceMs = m.ms;
    this.rate.tick(now);
    if (m.role === 'detector') this.measureDetector(m.det!, m.w, m.h, m.t);
    else this.measure(m.face!, m.w, m.h, m.t);
  }

  /** Head-turn foreshortening and iris sizes from a landmarker frame. */
  private absorbLandmarks(face: FaceResult, W: number, H: number, now: number): void {
    if (face.mat && face.mat.length === 16) {
      const ax = face.mat[0]!, ay = face.mat[1]!, az = face.mat[2]!;
      const len = Math.hypot(ax, ay, az) || 1;
      this.foreshorten = Math.max(0.5, Math.hypot(ax, ay) / len);
      this.foreshortenT = now;
    }
    const size = (pts: [number, number][]) => {
      const p = pts.map(([x, y]) => ({ u: x * W, v: y * H }));
      const [, r, t, l, b] = p as [typeof p[0], typeof p[0], typeof p[0], typeof p[0], typeof p[0]];
      return Math.max(Math.hypot(r.u - l.u, r.v - l.v), Math.hypot(t.u - b.u, t.v - b.v));
    };
    this.lastIris = { L: size(face.left), R: size(face.right), t: now };
  }

  /** Fix from the detector's two eye centres: the pupil-spacing cue, head turn from the last landmarker frame. */
  private measureDetector(d: DetectResult, W: number, H: number, t0: number): void {
    const now = performance.now();
    const f = this.focalPx;
    const [a, b] = d.eyes;
    const A = { u: a[0] * W, v: a[1] * H }, B = { u: b[0] * W, v: b[1] * H };
    const ipdPx = Math.hypot(A.u - B.u, A.v - B.v);
    const foreshorten = now - this.foreshortenT < 2000 ? this.foreshorten : 1;
    const ipdCorrPx = ipdPx / foreshorten;
    if (ipdCorrPx < 5) return;
    const z = (f * IPD_MM) / 1000 / ipdCorrPx;
    // D-29: the eye nearest the screen's centre axis. Image-left eye is the subject's right eye (unmirrored camera).
    const axisU = W / 2 - (f * this.opts.cameraOffset.x) / z;
    const axisV = H / 2 + (f * this.opts.cameraOffset.y) / z;
    const dA = Math.hypot(A.u - axisU, A.v - axisV), dB = Math.hypot(B.u - axisU, B.v - axisV);
    const sideA: EyeSide = 'right', sideB: EyeSide = 'left';
    const other: EyeSide = this.chosen === 'left' ? 'right' : 'left';
    const otherNearer = other === sideA ? dA < dB - 0.2 * ipdPx : dB < dA - 0.2 * ipdPx;
    if (otherNearer) {
      if (!this.switchSince) this.switchSince = now;
      if (now - this.switchSince > 300) { this.chosen = other; this.switchSince = 0; }
    } else this.switchSince = 0;
    const E = this.chosen === sideA ? A : B;
    void sideB;
    const x = -((E.u - W / 2) / f) * z + this.opts.cameraOffset.x;
    const y = -((E.v - H / 2) / f) * z + this.opts.cameraOffset.y;
    const iris = this.lastIris && now - this.lastIris.t < 3000 ? this.lastIris : null;
    const irisPx = iris ? (this.chosen === 'left' ? iris.L : iris.R) : 0;
    const zIrisRaw = irisPx > 1 ? (f * IRIS_MM) / 1000 / irisPx : z;
    if (irisPx > 1) this.irisScale += (z / zIrisRaw - this.irisScale) * 0.1;
    this.setFix({
      x, y, z, eye: this.chosen, cue: 'ipd', irisPx, irisLeftPx: iris?.L ?? 0, irisRightPx: iris?.R ?? 0,
      ipdPx, ipdCorrPx, foreshorten, bothVisible: true, zIpd: z, zIris: zIrisRaw * this.irisScale, headTz: null, headMat: null, t: t0,
    }, ipdCorrPx, irisPx, now);
  }

  /** Common tail: velocity from the previous fix, sample history, inertial bridge anchor. */
  private setFix(fix: Omit<EyeFix, 'vx' | 'vy' | 'vz'>, ipdCorrPx: number, irisPx: number, now: number): void {
    const prev = this.fix;
    const dtFix = prev ? (fix.t - prev.t) / 1000 : 0;
    let vx = 0, vy = 0, vz = 0;
    if (prev && dtFix > 0.01 && dtFix < 0.3) {
      const phoneMoved = this.displacement() - this.bridgeAtFix;
      vx = clampAbs((fix.x - prev.x) / dtFix, 1.5);
      vy = clampAbs((fix.y - prev.y) / dtFix, 1.5);
      vz = clampAbs((fix.z - phoneMoved - prev.z) / dtFix, 1.5);
    }
    this.fix = { ...fix, vx, vy, vz };
    this.sizeSamples.push({ iris: irisPx, ipd: ipdCorrPx, t: now });
    if (this.sizeSamples.length > 60) this.sizeSamples.shift();
    this.bridgeAtFix = this.displacement();
    this.bridgeBase = fix.z;
  }

  /** Auto delegate selection: time 8 frames on GPU, then 8 on CPU, keep the faster. */
  private stepProbe(ms: number): void {
    const p = this.probe!;
    p.ms.push(ms);
    if (p.ms.length < 8) return;
    const mean = p.ms.reduce((a, b) => a + b, 0) / p.ms.length;
    this.delegateMs[p.delegate] = mean;
    const other: Delegate = p.delegate === 'GPU' ? 'CPU' : 'GPU';
    const w = this.worker;
    if (!w) { this.probe = null; return; }
    if (this.delegateMs[other] === undefined) {
      this.probe = { delegate: other, ms: [] };
      void this.init(w, 'landmarker', other).catch(() => { this.probe = null; });
      return;
    }
    this.probe = null;
    const best: Delegate = (this.delegateMs.GPU ?? Infinity) <= (this.delegateMs.CPU ?? Infinity) ? 'GPU' : 'CPU';
    console.info(`[eye] landmarker timing GPU ${this.delegateMs.GPU?.toFixed(0)} ms, CPU ${this.delegateMs.CPU?.toFixed(0)} ms → ${best}; detector ${this.detectorMs.toFixed(1)} ms on ${this.detectorDelegate}`);
    if (best !== this.delegate) void this.init(w, 'landmarker', best).catch(() => { /* keep current */ });
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

    this.setFix({
      x, y, z, eye: this.chosen, cue: zIpd !== null ? 'ipd' : 'iris',
      irisPx: E.d, irisLeftPx: L.d, irisRightPx: R.d, ipdPx, ipdCorrPx, foreshorten, bothVisible, zIpd, zIris, headTz, headMat: face.mat, t: t0,
    }, ipdCorrPx, E.d, now);
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
