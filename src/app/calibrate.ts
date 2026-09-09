/**
 * Spike S8 calibration screen (`?calibrate`). No 3D. Two big buttons, one
 * per A4 edge. Each tap records the iris and pupil-spacing measurements of
 * the last 1.5 s together with the true distance, and posts the record to
 * the dev server (`/__record`, see vite.config.ts) and to localStorage.
 * The focal length is derived offline from these records.
 */
import { EyeTracker, IRIS_MM, IPD_MM } from '../sensing/eye';

const TARGETS = [
  { label: 'A4 long edge', cm: 29.7 },
  { label: 'A4 short edge', cm: 21.0 },
  { label: 'A4 diagonal (fold corner to corner)', cm: 36.4 },
];
const PER_TARGET = 5;
/** Head-pose block: all at the A4 long edge, 29.7 cm. */
const POSES = [
  { key: 'square', label: 'Head square, looking at the camera' },
  { key: 'left', label: 'Head turned left (nose towards your left shoulder)' },
  { key: 'right', label: 'Head turned right' },
  { key: 'up', label: 'Chin up, looking down at the phone with your eyes' },
  { key: 'down', label: 'Chin down, looking up at the phone with your eyes' },
];
const PER_POSE = 3;
const POSE_CM = 29.7;

export async function calibrationMode(): Promise<void> {
  document.getElementById('start')?.remove();
  document.getElementById('view')?.remove();
  const root = document.getElementById('hud') as HTMLElement;
  root.className = 'calib';
  root.style.pointerEvents = 'auto';
  root.innerHTML = `
    <h1>Eye distance calibration</h1>
    <p class="how">Hold the phone upright at eye level, screen towards you, and look straight at the camera with your
    head square to it. Put one end of the sheet's edge on the screen and the other under your eye. Hold still one
    second, then tap the button for that edge. Do each five times.</p>
    <div class="live">starting camera…</div>
    <div class="buttons"></div>
    <h2>Head turn, at the A4 long edge (29.7 cm)</h2>
    <p class="how">Keep the sheet's long edge between screen and eye. Turn or tilt your head about a quarter turn,
    roughly 20 to 30 degrees, and keep looking at the phone with your eyes. Hold still one second, then tap. Three each.</p>
    <div class="poses"></div>
    <div class="log"></div>
    <p class="how small">Records go to <code>spikes/records/s8-calibration.jsonl</code> on the dev machine.</p>`;
  const live = root.querySelector('.live') as HTMLElement;
  const buttons = root.querySelector('.buttons') as HTMLElement;
  const log = root.querySelector('.log') as HTMLElement;

  const counts = new Map<string, number>();
  const session = Math.random().toString(36).slice(2, 8);
  const eyes = new EyeTracker({ rate: 20 });
  try {
    await eyes.start();
  } catch (e) {
    live.textContent = `camera failed: ${(e as Error).message}`;
    return;
  }

  const takeRecord = async (cm: number, label: string, pose: string | null): Promise<boolean> => {
      const f = eyes.fix;
      const r = eyes.recentSizes(1500);
      if (!f || r.n < 5 || performance.now() - f.t > 700) {
        log.textContent = 'No steady face in view. Hold still with the phone facing you and try again.';
        navigator.vibrate?.([30, 40, 30]);
        return false;
      }
      const record = {
        kind: pose ? 's8-pose' : 's8-calibration',
        session,
        t: new Date().toISOString(),
        trueDistanceCm: cm,
        label,
        pose,
        irisMedianPx: r.iris,
        ipdCorrMedianPx: r.ipd,
        irisSamples: r.n,
        irisLeftPx: f.irisLeftPx,
        irisRightPx: f.irisRightPx,
        ipdPx: f.ipdPx,
        ipdCorrPx: f.ipdCorrPx,
        foreshorten: f.foreshorten,
        bothVisible: f.bothVisible,
        headTz: f.headTz,
        headMat: f.headMat,
        chosenEye: f.eye,
        capture: eyes.captureSize,
        screenCss: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
        inferenceMs: eyes.inferenceMs,
        delegate: eyes.delegate,
        delegateMs: eyes.delegateMs,
        focalNormInUse: eyes.focalNorm,
        ua: navigator.userAgent,
        // Implied focal lengths, for a quick look: f = px × distance / size.
        fFromIris: (r.iris * cm) / (IRIS_MM / 10),
        fFromIpd: (f.ipdPx * cm) / (IPD_MM / 10),
        fFromIpdCorr: (r.ipd * cm) / (IPD_MM / 10),
      };
      try {
        const key = 'porthole.s8.records';
        const arr = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[];
        arr.push(record);
        localStorage.setItem(key, JSON.stringify(arr));
      } catch { /* ignore */ }
      let sent = 'not sent';
      try {
        const res = await fetch(new URL('__record?name=s8-calibration', location.href), { method: 'POST', body: JSON.stringify(record) });
        sent = res.ok ? 'sent to dev machine' : `send failed (${res.status})`;
      } catch { sent = 'send failed (no dev server)'; }
      log.textContent = `Recorded ${label}: iris ${r.iris.toFixed(1)} px, pupil spacing ${r.ipd.toFixed(1)} px (head ${(Math.acos(Math.min(1, f.foreshorten)) * 180 / Math.PI).toFixed(0)}° off) · ${sent}`;
      navigator.vibrate?.(25);
      return true;
  };

  const counter = (parent: HTMLElement, key: string, text: string, max: number, onTap: () => Promise<boolean>) => {
    const b = document.createElement('button');
    b.className = 'big';
    b.textContent = `${text} · 0/${max}`;
    b.onclick = async () => {
      if (!(await onTap())) return;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      b.textContent = `${text} · ${n}/${max}`;
      if (n >= max) b.classList.add('done');
    };
    parent.appendChild(b);
  };
  for (const t of TARGETS) counter(buttons, `d${t.cm}`, `${t.label} · ${t.cm} cm`, PER_TARGET, () => takeRecord(t.cm, t.label, null));
  const poses = root.querySelector('.poses') as HTMLElement;
  for (const p of POSES) counter(poses, `p${p.key}`, p.label, PER_POSE, () => takeRecord(POSE_CM, p.label, p.key));

  const tick = () => {
    const f = eyes.fix;
    const r = eyes.recentSizes(1500);
    const fresh = f && performance.now() - f.t < 700;
    const head = f ? (Math.acos(Math.min(1, f.foreshorten)) * 180 / Math.PI) : 0;
    live.innerHTML = fresh
      ? `<b>face found</b> · head ${head.toFixed(0)}° off axis${head > 12 ? ' <b class="warn">(face the camera)</b>' : ''} · ` +
        `${eyes.delegate} ${eyes.inferenceMs.toFixed(0)} ms · ${eyes.rate.hz}/s · est. ${(f!.z * 100).toFixed(1)} cm`
      : `<b class="warn">${eyes.status}</b> · point the phone at your face`;
    live.classList.toggle('ok', !!fresh);
    requestAnimationFrame(tick);
  };
  tick();
}
