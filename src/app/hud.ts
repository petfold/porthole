/**
 * On-screen status line plus a debug panel (gear button, or `?debug`).
 * The panel doubles as the Phase 0 sensor spike (S1, S6, S7): it lists
 * which APIs exist, their rates, recent throttle impulses, and the FOV
 * calibration.
 */
import type { OrientationSource } from '../sensing/orientation';
import type { ThrottleGesture } from '../sensing/motion';
import type { WindowCamera } from '../render/camera';
import type { SteerMode, Vehicle } from './vehicle';

export interface HudDeps {
  vehicle: Vehicle;
  orientation: () => OrientationSource;
  orientationLog: () => string[];
  throttle: ThrottleGesture;
  window: WindowCamera;
  onMode(mode: SteerMode): void;
  onRecentre(): void;
  onRespawn(): void;
}

const CARD_MM = 85.6; // ISO/IEC 7810 ID-1 long edge

export class Hud {
  private readonly root: HTMLElement;
  private readonly status: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly dyn: HTMLElement;
  private readonly card: HTMLElement;
  private readonly fovLabel: HTMLElement;
  private readonly slider: HTMLInputElement;
  private fps = 0;
  private frames = 0;
  private lastFpsT = performance.now();
  private open: boolean;

  constructor(root: HTMLElement, private readonly d: HudDeps) {
    this.root = root;
    this.open = new URLSearchParams(location.search).has('debug');
    root.innerHTML = `
      <div class="status"></div>
      <button class="gear" aria-label="settings">⚙</button>
      <div class="panel" hidden>
        <h2>Steering (D-10 feel test)</h2>
        <select class="mode">
          <option value="look">look: go where you look</option>
          <option value="yawrate">yawrate: yaw is a handlebar</option>
          <option value="roll">roll: bank to steer, look freely</option>
        </select>
        <button class="recentre">Recentre</button>
        <button class="respawn">Respawn</button>
        <h2>Window (S7)</h2>
        <div>Match the bar to the long edge of a bank card (${CARD_MM} mm), then check the FOV.</div>
        <div class="card"></div>
        <input type="range" class="cal" min="0.6" max="1.6" step="0.005" />
        <div class="fov"></div>
        <h2>Sensors (S1, S6)</h2>
        <div class="dyn"></div>
      </div>`;
    this.status = root.querySelector('.status') as HTMLElement;
    this.panel = root.querySelector('.panel') as HTMLElement;
    this.dyn = root.querySelector('.dyn') as HTMLElement;
    this.card = root.querySelector('.card') as HTMLElement;
    this.fovLabel = root.querySelector('.fov') as HTMLElement;
    this.slider = root.querySelector('.cal') as HTMLInputElement;
    this.panel.hidden = !this.open;

    (root.querySelector('.gear') as HTMLButtonElement).onclick = () => {
      this.open = !this.open;
      this.panel.hidden = !this.open;
    };
    const mode = root.querySelector('.mode') as HTMLSelectElement;
    mode.value = d.vehicle.mode;
    mode.onchange = () => d.onMode(mode.value as SteerMode);
    (root.querySelector('.recentre') as HTMLButtonElement).onclick = () => d.onRecentre();
    (root.querySelector('.respawn') as HTMLButtonElement).onclick = () => d.onRespawn();
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
    const flash = now < Number(this.status.dataset.flashUntil ?? 0) ? `\n${this.status.dataset.flash}` : '';
    const brake = v.braking ? ' BRAKE' : '';
    this.status.textContent =
      `${v.speed.toFixed(1)} m/s${brake}  hdg ${((v.heading * 180) / Math.PI).toFixed(0)}°  ` +
      `${v.mode}  ${o.kind} ${o.rate.hz} Hz  ${this.fps.toFixed(0)} fps${flash}`;

    if (this.open && this.frames % 6 === 0) this.updatePanel();
  }

  private updatePanel(): void {
    const t = this.d.throttle;
    const o = this.d.orientation();
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
      ['devicemotion', t.available ? `${t.rate.hz} Hz · a_z ${t.az.toFixed(2)} · ${t.phase}` : 'no readings'],
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
