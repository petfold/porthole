/**
 * Face landmark inference off the main thread. Receives ImageBitmaps, runs
 * MediaPipe Face Landmarker, and returns only what the eye estimator needs:
 * the ten iris landmarks (normalised image coordinates) and the head pose
 * matrix. Timestamps are supplied by the main thread and must increase.
 */
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const LEFT_IRIS = [468, 469, 470, 471, 472];
const RIGHT_IRIS = [473, 474, 475, 476, 477];

export interface InitMsg { type: 'init'; wasmBase: string; modelPath: string; delegate: 'GPU' | 'CPU' }
export interface FrameMsg { type: 'frame'; bitmap: ImageBitmap; t: number }
export type InMsg = InitMsg | FrameMsg | { type: 'close' };

export interface FaceResult {
  /** [x, y] normalised to the image, [centre, right, top, left, bottom]. */
  left: [number, number][];
  right: [number, number][];
  /** 4×4 column-major face-to-camera transform, or null. */
  mat: number[] | null;
}
export type OutMsg =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'error'; message: string }
  | { type: 'result'; t: number; ms: number; w: number; h: number; face: FaceResult | null };

let lm: FaceLandmarker | null = null;
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
    lm?.close();
    lm = null;
    try {
      const fileset = await FilesetResolver.forVisionTasks(m.wasmBase);
      await ensureModuleFactory(fileset.wasmLoaderPath);
      lm = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: m.modelPath, delegate: m.delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: true,
      });
      post({ type: 'ready', delegate: m.delegate });
    } catch (err) {
      post({ type: 'error', message: (err as Error).message ?? String(err) });
    }
  } else if (m.type === 'frame') {
    const bmp = m.bitmap;
    const w = bmp.width, h = bmp.height;
    if (!lm) { bmp.close(); post({ type: 'result', t: m.t, ms: 0, w, h, face: null }); return; }
    const t0 = performance.now();
    let face: FaceResult | null = null;
    let ms = 0;
    try {
      const res = lm.detectForVideo(bmp, m.t);
      ms = performance.now() - t0;
      const f = res.faceLandmarks[0];
      if (f && f.length >= 478) {
        const pick = (idx: number[]) => idx.map((i) => [f[i]!.x, f[i]!.y] as [number, number]);
        const mat = res.facialTransformationMatrixes?.[0]?.data;
        face = { left: pick(LEFT_IRIS), right: pick(RIGHT_IRIS), mat: mat ? Array.from(mat) : null };
      }
    } catch { /* dropped frame */ }
    bmp.close();
    post({ type: 'result', t: m.t, ms, w, h, face });
  } else if (m.type === 'close') {
    lm?.close();
    lm = null;
  }
};
