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
];
const PER_TARGET = 5;

export async function calibrationMode(): Promise<void> {
  document.getElementById('start')?.remove();
  document.getElementById('view')?.remove();
  const root = document.getElementById('hud') as HTMLElement;
  root.className = 'calib';
  root.style.pointerEvents = 'auto';
  root.innerHTML = `
    <h1>Eye distance calibration</h1>
    <p class="how">Hold the phone upright, screen towards you. Put one end of the sheet's edge on the screen and the other
    under your eye. Hold still one second, then tap the button for that edge. Do each five times.</p>
    <div class="live">starting camera…</div>
    <div class="buttons"></div>
    <div class="log"></div>
    <p class="how small">Records go to <code>spikes/records/s8-calibration.jsonl</code> on the dev machine.</p>`;
  const live = root.querySelector('.live') as HTMLElement;
  const buttons = root.querySelector('.buttons') as HTMLElement;
  const log = root.querySelector('.log') as HTMLElement;

  const counts = new Map<number, number>();
  const session = Math.random().toString(36).slice(2, 8);
  const eyes = new EyeTracker({ rate: 20 });
  try {
    await eyes.start();
  } catch (e) {
    live.textContent = `camera failed: ${(e as Error).message}`;
    return;
  }

  for (const t of TARGETS) {
    const b = document.createElement('button');
    b.className = 'big';
    b.textContent = `${t.label} · ${t.cm} cm · 0/${PER_TARGET}`;
    b.onclick = async () => {
      const f = eyes.fix;
      const r = eyes.recentIris(1500);
      if (!f || r.n < 5 || performance.now() - f.t > 700) {
        log.textContent = 'No steady face in view. Hold still with the phone facing you and try again.';
        navigator.vibrate?.([30, 40, 30]);
        return;
      }
      const record = {
        kind: 's8-calibration',
        session,
        t: new Date().toISOString(),
        trueDistanceCm: t.cm,
        label: t.label,
        irisMedianPx: r.median,
        irisSamples: r.n,
        irisLeftPx: f.irisLeftPx,
        irisRightPx: f.irisRightPx,
        ipdPx: f.ipdPx,
        chosenEye: f.eye,
        capture: eyes.captureSize,
        screenCss: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
        inferenceMs: eyes.inferenceMs,
        delegate: eyes.delegate,
        ua: navigator.userAgent,
        // Implied focal lengths, for a quick look: f = px × distance / size.
        fFromIris: (r.median * t.cm) / (IRIS_MM / 10),
        fFromIpd: (f.ipdPx * t.cm) / (IPD_MM / 10),
      };
      const n = (counts.get(t.cm) ?? 0) + 1;
      counts.set(t.cm, n);
      b.textContent = `${t.label} · ${t.cm} cm · ${n}/${PER_TARGET}`;
      if (n >= PER_TARGET) b.classList.add('done');
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
      log.textContent = `Recorded ${t.cm} cm: iris ${r.median.toFixed(1)} px, IPD ${f.ipdPx.toFixed(1)} px · ${sent}`;
      navigator.vibrate?.(25);
    };
    buttons.appendChild(b);
  }

  const tick = () => {
    const f = eyes.fix;
    const r = eyes.recentIris(1500);
    const fresh = f && performance.now() - f.t < 700;
    live.innerHTML = fresh
      ? `<b>face found</b> · iris ${r.median.toFixed(1)} px (${r.n} samples) · ${eyes.delegate} · ${eyes.inferenceMs.toFixed(0)} ms · ${eyes.rate.hz}/s`
      : `<b class="warn">${eyes.status}</b> · point the phone at your face`;
    live.classList.toggle('ok', !!fresh);
    requestAnimationFrame(tick);
  };
  tick();
}
