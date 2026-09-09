/**
 * On-screen status line plus a debug panel (gear button, or `?panel`).
 * The panel doubles as the Phase 0 sensor spike (S1, S6, S7): it lists
 * which APIs exist, their rates, recent throttle impulses, and the FOV
 * calibration.
 */
import type { OrientationSource } from '../sensing/orientation';
import type { ThrottleGesture } from '../sensing/motion';
import type { WindowCamera } from '../render/camera';
import type { SteerMode, ThrottleMode, Vehicle } from './vehicle';
import type { SensorProbe } from '../sensing/probe';
import type { EyeTracker } from '../sensing/eye';

export interface HudDeps {
  vehicle: Vehicle;
  orientation: () => OrientationSource;
  orientationLog: () => string[];
  throttle: ThrottleGesture;
  probe: SensorProbe;
  window: WindowCamera;
  onMode(mode: SteerMode): void;
  onThrottleMode(mode: ThrottleMode): void;
  onRecentre(): void;
  onRespawn(): void;
  onStop(): void;
  eyes: EyeTracker;
  onEyes(on: boolean): void;
  onEyeCalibrate(distanceM: number): void;
}

const CARD_MM = 85.6; // ISO/IEC 7810 ID-1 long edge

export class Hud {
  private readonly root: HTMLElement;
  private readonly status: HTMLElement;
  private readonly speedNum: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly target: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly dyn: HTMLElement;
  private readonly card: HTMLElement;
  private readonly fovLabel: HTMLElement;
  private readonly slider: HTMLInputElement;
  private eyeInfo!: HTMLElement;
  private fps = 0;
  private frames = 0;
  private lastFpsT = performance.now();
  private open: boolean;

  constructor(root: HTMLElement, private readonly d: HudDeps) {
    this.root = root;
    // The panel starts closed; `?panel` opens it for spike sessions.
    this.open = new URLSearchParams(location.search).has('panel');
    root.innerHTML = `
      <div class="status"></div>
      <div class="gauge">
        <div class="speed"><span class="num">0.0</span><span class="unit"> m/s</span></div>
        <div class="bar"><div class="zero"></div><div class="fill"></div><div class="target"></div></div>
      </div>
      <button class="stop" aria-label="stop">STOP</button>
      <button class="gear" aria-label="settings">⚙</button>
      <div class="panel" hidden>
        <button class="close">Close panel</button>
        <h2>Steering (D-10 feel test)</h2>
        <select class="mode">
          <option value="look">look: go where you look</option>
          <option value="yawrate">yawrate: yaw is a handlebar</option>
          <option value="roll">roll: bank to steer, look freely</option>
        </select>
        <button class="recentre">Recentre</button>
        <button class="respawn">Respawn</button>
        <h2>Throttle</h2>
        <select class="throttle">
          <option value="displacement">displacement: hold the phone out to go</option>
          <option value="impulse">impulse: push to add speed, coast</option>
        </select>
        <div class="small">Hold the screen to brake; that also sets the base position.</div>
        <h2>Eye (S8)</h2>
        <label><input type="checkbox" class="eyes" /> Track the eye with the front camera</label>
        <div>Rate <select class="eyerate"><option>5</option><option selected>10</option><option>15</option><option>30</option></select> /s</div>
        <div class="small">Calibrate once: hold the phone at the given distance from your eye, then tap.</div>
        <button class="cal30">I am at 30 cm</button><button class="cal40">I am at 40 cm</button>
        <div class="eyeinfo"></div>
        <h2>Window (S7)</h2>
        <div>Match the bar to the long edge of a bank card (${CARD_MM} mm), then check the FOV.</div>
        <div class="card"></div>
        <input type="range" class="cal" min="0.6" max="1.6" step="0.005" />
        <div class="fov"></div>
        <h2>Sensors (S1, S6)</h2>
        <button class="drift">Reset drift timer</button>
        <div class="dyn"></div>
      </div>`;
    this.status = root.querySelector('.status') as HTMLElement;
    this.speedNum = root.querySelector('.gauge .num') as HTMLElement;
    this.fill = root.querySelector('.gauge .fill') as HTMLElement;
    this.target = root.querySelector('.gauge .target') as HTMLElement;
    this.panel = root.querySelector('.panel') as HTMLElement;
    this.dyn = root.querySelector('.dyn') as HTMLElement;
    this.card = root.querySelector('.card') as HTMLElement;
    this.fovLabel = root.querySelector('.fov') as HTMLElement;
    this.slider = root.querySelector('.cal') as HTMLInputElement;
    this.panel.hidden = !this.open;

    const toggle = (open: boolean) => { this.open = open; this.panel.hidden = !open; };
    (root.querySelector('.gear') as HTMLButtonElement).onclick = () => toggle(!this.open);
    (root.querySelector('.close') as HTMLButtonElement).onclick = () => toggle(false);
    const mode = root.querySelector('.mode') as HTMLSelectElement;
    mode.value = d.vehicle.mode;
    mode.onchange = () => d.onMode(mode.value as SteerMode);
    const thr = root.querySelector('.throttle') as HTMLSelectElement;
    thr.value = d.vehicle.throttleMode;
    thr.onchange = () => d.onThrottleMode(thr.value as ThrottleMode);
    (root.querySelector('.recentre') as HTMLButtonElement).onclick = () => d.onRecentre();
    (root.querySelector('.respawn') as HTMLButtonElement).onclick = () => d.onRespawn();
    const stop = root.querySelector('.stop') as HTMLButtonElement;
    stop.addEventListener('pointerdown', (e) => { e.stopPropagation(); d.onStop(); });
    (root.querySelector('.drift') as HTMLButtonElement).onclick = () => d.probe.resetDrift();
    const eyes = root.querySelector('.eyes') as HTMLInputElement;
    eyes.checked = d.eyes.tracking;
    eyes.onchange = () => d.onEyes(eyes.checked);
    const rate = root.querySelector('.eyerate') as HTMLSelectElement;
    rate.value = String(d.eyes.opts.rate);
    rate.onchange = () => d.eyes.setRate(parseInt(rate.value, 10));
    (root.querySelector('.cal30') as HTMLButtonElement).onclick = () => d.onEyeCalibrate(0.3);
    (root.querySelector('.cal40') as HTMLButtonElement).onclick = () => d.onEyeCalibrate(0.4);
    this.eyeInfo = root.querySelector('.eyeinfo') as HTMLElement;
    this.slider.value = String(d.window.calibration);
    this.slider.oninput = () => { d.window.setCalibration(parseFloat(this.slider.value)); this.updateCalibration(); };
    // Stop panel touches from reaching the view (brake / recentre).
    for (const ev of ['pointerdown', 'pointerup', 'pointermove'] as const) {
      this.panel.addEventListener(ev, (e) => e.stopPropagation());
    }
    this.updateCalibration();
  }

  private updateCalibration(): void {
    const w = this.d.window;
    this.card.style.width = `${(CARD_MM / w.mmPerCssPx).toFixed(1)}px`;
    const vp = w.viewportMm;
    this.fovLabel.textContent =
      `screen ≈ ${vp.w.toFixed(0)} × ${vp.h.toFixed(0)} mm · vertical FOV ${w.verticalFovDeg.toFixed(1)}° at 40 cm · ` +
      `dpr ${window.devicePixelRatio.toFixed(2)} · ${window.innerWidth}×${window.innerHeight} css px · cal ${w.calibration.toFixed(3)}`;
  }

  flash(text: string): void {
    this.status.dataset.flash = text;
    this.status.dataset.flashUntil = String(performance.now() + 1200);
  }

  update(): void {
    this.frames++;
    const now = performance.now();
    if (now - this.lastFpsT >= 500) {
      this.fps = (this.frames * 1000) / (now - this.lastFpsT);
      this.frames = 0;
      this.lastFpsT = now;
    }
    const v = this.d.vehicle;
    const o = this.d.orientation();
    this.updateGauge(v);
    const flash = now < Number(this.status.dataset.flashUntil ?? 0) ? `\n${this.status.dataset.flash}` : '';
    const brake = v.braking ? ' BRAKE' : '';
    const disp = v.throttleMode === 'displacement' ? `  ${(this.d.throttle.x * 100).toFixed(0)} cm` : '';
    this.status.textContent =
      `${v.speed.toFixed(1)} m/s${disp}${brake}  hdg ${((v.heading * 180) / Math.PI).toFixed(0)}°  ` +
      `${v.mode}  ${o.kind} ${o.rate.hz} Hz  ${this.fps.toFixed(0)} fps${flash}`;

    if (this.open && this.frames % 6 === 0) { this.updatePanel(); this.updateEye(); }
  }

  /** Speed bar: zero in the middle-left, forward fills right, reverse fills left. */
  private updateGauge(v: Vehicle): void {
    const t = v.tuning;
    const span = t.maxSpeed + t.maxReverse;
    const zeroPct = (100 * t.maxReverse) / span;
    const pct = (s: number) => (100 * (s + t.maxReverse)) / span;
    this.speedNum.textContent = Math.abs(v.speed).toFixed(1);
    this.speedNum.classList.toggle('reverse', v.speed < -0.05);
    const a = Math.min(zeroPct, pct(v.speed));
    const b = Math.max(zeroPct, pct(v.speed));
    this.fill.style.left = `${a}%`;
    this.fill.style.width = `${b - a}%`;
    this.fill.classList.toggle('braking', v.braking);
    const showTarget = v.throttleMode === 'displacement' && !v.braking;
    this.target.hidden = !showTarget;
    if (showTarget) this.target.style.left = `${pct(v.targetSpeed)}%`;
  }

  private updateEye(): void {
    const e = this.d.eyes;
    const cb = this.root.querySelector('.eyes') as HTMLInputElement | null;
    if (cb && cb.checked !== e.tracking && !e.status.startsWith('starting') && !e.status.startsWith('loading')) cb.checked = e.tracking;
    const f = e.fix;
    const vf = this.d.window.verticalFovDeg;
    const live = `eye ${(e.eye.z * 100).toFixed(1)} cm · x ${(e.eye.x * 100).toFixed(1)} y ${(e.eye.y * 100).toFixed(1)} cm · ` +
      `window ${(2 * Math.atan((this.d.window.viewportMm.h / 1000 / 2) / e.eye.z) * 180 / Math.PI).toFixed(0)}° (was ${vf.toFixed(0)}° at 40 cm)`;
    this.eyeInfo.textContent = `${e.status} · ${e.delegate} · ${e.rate.hz}/s · ${e.inferenceMs.toFixed(0)} ms · f ${e.focalPx.toFixed(0)} px\n${live}` +
      (f ? `\nfix: ${f.eye} eye · iris ${f.irisPx.toFixed(1)} px → ${(f.z * 100).toFixed(1)} cm · IPD → ${f.ipdDistance ? (f.ipdDistance * 100).toFixed(1) + ' cm' : '—'}` : '');
  }

  private updatePanel(): void {
    const t = this.d.throttle;
    const o = this.d.orientation();
    const p = this.d.probe;
    const has = (n: string) => (n in window ? 'yes' : 'no');
    const rows: [string, string][] = [
      ['secure context', String(isSecureContext)],
      ['RelativeOrientationSensor', has('RelativeOrientationSensor')],
      ['AbsoluteOrientationSensor', has('AbsoluteOrientationSensor')],
      ['Accelerometer', has('Accelerometer')],
      ['LinearAccelerationSensor', has('LinearAccelerationSensor')],
      ['Gyroscope', has('Gyroscope')],
      ['DeviceOrientationEvent', has('DeviceOrientationEvent')],
      ['deviceorientationabsolute', 'ondeviceorientationabsolute' in window ? 'yes' : 'no'],
      ['DeviceMotionEvent', has('DeviceMotionEvent')],
      ['orientation source', `${o.kind} · ${o.rate.hz} Hz · age ${o.rate.age.toFixed(0)} ms`],
      ['yaw drift (rest the phone)', `${p.driftDeg >= 0 ? '+' : ''}${p.driftDeg.toFixed(2)}° over ${p.driftSeconds.toFixed(0)} s` +
        (p.driftSeconds > 5 ? ` = ${((60 * p.driftDeg) / p.driftSeconds).toFixed(2)}°/min` : '')],
      ['deviceorientation events', `${p.deviceorientation.hz} Hz · α ${p.alpha?.toFixed(1) ?? '—'}`],
      ['deviceorientationabsolute events', `${p.deviceorientationabsolute.hz} Hz · α ${p.alphaAbsolute?.toFixed(1) ?? '—'}`],
      ['devicemotion events', `${p.devicemotion.hz} Hz`],
      ['throttle source', t.available ? `${t.kind} · ${t.rate.hz} Hz · a_z ${t.az.toFixed(2)} m/s² · ${t.phase}` : 'no readings yet'],
      ['displacement', `${(t.x * 100).toFixed(1)} cm · v ${t.v.toFixed(2)} m/s · ${t.still ? 'still' : 'moving'} · target ${this.d.vehicle.targetSpeed.toFixed(1)} m/s`],
      ['screen.orientation', `${screen.orientation?.type ?? '?'} ${screen.orientation?.angle ?? '?'}°`],
      ['steer', `${((this.d.vehicle.steer * 180) / Math.PI).toFixed(0)}°`],
    ];
    const impulses = t.history.slice(-10).map((i) => `${i.value >= 0 ? '+' : ''}${i.value.toFixed(2)}/${i.ms.toFixed(0)}ms`).join(' ');
    const stats = impulseStats(t.history.map((i) => i.value));
    this.dyn.innerHTML =
      `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>` +
      `<h2>Impulses (m/s / ms)</h2><div>${impulses || '—'}</div>` +
      (stats ? `<div>push: n=${stats.push.n} mean ${stats.push.mean.toFixed(2)} spread ±${stats.push.spread.toFixed(0)}% · ` +
        `pull: n=${stats.pull.n} mean ${stats.pull.mean.toFixed(2)} spread ±${stats.pull.spread.toFixed(0)}%</div>` : '') +
      `<h2>Orientation source log</h2><div>${this.d.orientationLog().join('<br>')}</div>`;
  }
}

function impulseStats(values: number[]) {
  if (!values.length) return null;
  const side = (xs: number[]) => {
    if (!xs.length) return { n: 0, mean: 0, spread: 0 };
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const max = Math.max(...xs.map((x) => Math.abs(x - mean)));
    return { n: xs.length, mean, spread: mean ? (100 * max) / Math.abs(mean) : 0 };
  };
  return { push: side(values.filter((v) => v > 0)), pull: side(values.filter((v) => v < 0)) };
}
