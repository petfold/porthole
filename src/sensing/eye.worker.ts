/**
 * Face model inference off the main thread. One worker instance runs one
 * model, chosen at init:
 *  - 'detector': BlazeFace short range, six keypoints, about a millisecond.
 *    Gives both eye centres → the pupil-spacing distance cue at full rate.
 *  - 'landmarker': Face Landmarker, 478 points and the head pose matrix.
 *    Slow on this phone; used at a low rate for the iris cue and the
 *    head-turn correction.
 * Receives ImageBitmaps; timestamps come from the main thread and must
 * increase.
 */
import { FaceDetector, FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const LEFT_IRIS = [468, 469, 470, 471, 472];
const RIGHT_IRIS = [473, 474, 475, 476, 477];

export type Role = 'detector' | 'landmarker';
export interface InitMsg { type: 'init'; role: Role; wasmBase: string; modelPath: string; delegate: 'GPU' | 'CPU' }
export interface FrameMsg { type: 'frame'; bitmap: ImageBitmap; t: number }
export type InMsg = InitMsg | FrameMsg | { type: 'close' };

export interface FaceResult {
  /** [x, y] normalised to the image, [centre, right, top, left, bottom]. */
  left: [number, number][];
  right: [number, number][];
  /** 4×4 column-major face-to-camera transform, or null. */
  mat: number[] | null;
}
export interface DetectResult {
  /** Eye centres, normalised image coordinates, [imageLeft, imageRight]. */
  eyes: [[number, number], [number, number]];
  /** Bounding box, normalised: x, y, w, h. */
  box: [number, number, number, number];
  score: number;
}
export type OutMsg =
  | { type: 'ready'; role: Role; delegate: 'GPU' | 'CPU' }
  | { type: 'error'; role: Role; message: string }
  | { type: 'result'; role: Role; t: number; ms: number; w: number; h: number; face: FaceResult | null; det: DetectResult | null };

let role: Role = 'detector';
let lm: FaceLandmarker | null = null;
let det: FaceDetector | null = null;
const post = (m: OutMsg) => (self as unknown as Worker).postMessage(m);

/**
 * MediaPipe loads its wasm loader with `importScripts`, which a module worker
 * lacks; the loader is a classic script that declares `var ModuleFactory`.
 * Fetch it and evaluate it in the global scope so that global exists.
 */
async function ensureModuleFactory(loaderUrl: string): Promise<void> {
  if ((self as unknown as { ModuleFactory?: unknown }).ModuleFactory) return;
  const src = await (await fetch(loaderUrl)).text();
  (0, eval)(src); // indirect eval: top-level `var` becomes a worker global
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const m = e.data;
  if (m.type === 'init') {
    lm?.close(); lm = null;
    det?.close(); det = null;
    role = m.role;
    try {
      const fileset = await FilesetResolver.forVisionTasks(m.wasmBase);
      await ensureModuleFactory(fileset.wasmLoaderPath);
      if (role === 'landmarker') {
        lm = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: m.modelPath, delegate: m.delegate },
          runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: false, outputFacialTransformationMatrixes: true,
        });
      } else {
        det = await FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: m.modelPath, delegate: m.delegate },
          runningMode: 'VIDEO', minDetectionConfidence: 0.65,
        });
      }
      post({ type: 'ready', role, delegate: m.delegate });
    } catch (err) {
      post({ type: 'error', role, message: (err as Error).message ?? String(err) });
    }
  } else if (m.type === 'frame') {
    const bmp = m.bitmap;
    const w = bmp.width, h = bmp.height;
    let face: FaceResult | null = null;
    let d: DetectResult | null = null;
    let ms = 0;
    const t0 = performance.now();
    try {
      if (role === 'landmarker' && lm) {
        const res = lm.detectForVideo(bmp, m.t);
        const f = res.faceLandmarks[0];
        if (f && f.length >= 478) {
          const pick = (idx: number[]) => idx.map((i) => [f[i]!.x, f[i]!.y] as [number, number]);
          const mat = res.facialTransformationMatrixes?.[0]?.data;
          face = { left: pick(LEFT_IRIS), right: pick(RIGHT_IRIS), mat: mat ? Array.from(mat) : null };
        }
      } else if (role === 'detector' && det) {
        const res = det.detectForVideo(bmp, m.t);
        const best = res.detections[0];
        const kp = best?.keypoints;
        if (best && kp && kp.length >= 2) {
          // Keypoints 0 and 1 are the eyes; order them by image position rather than trusting labels.
          const a: [number, number] = [kp[0]!.x, kp[0]!.y], b: [number, number] = [kp[1]!.x, kp[1]!.y];
          const eyes: [[number, number], [number, number]] = a[0] <= b[0] ? [a, b] : [b, a];
          const bb = best.boundingBox;
          d = {
            eyes,
            box: bb ? [bb.originX / w, bb.originY / h, bb.width / w, bb.height / h] : [0, 0, 1, 1],
            score: best.categories[0]?.score ?? 0,
          };
        }
      }
      ms = performance.now() - t0;
    } catch { /* dropped frame */ }
    bmp.close();
    post({ type: 'result', role, t: m.t, ms, w, h, face, det: d });
  } else if (m.type === 'close') {
    lm?.close(); lm = null;
    det?.close(); det = null;
  }
};
