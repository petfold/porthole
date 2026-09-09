import * as THREE from 'three';
import { loadWorld } from '../world/manifest';
import { View } from '../render/scene';
import { chooseOrientation, rollOf, yawOf, type OrientationKind, type OrientationSource } from '../sensing/orientation';
import { ThrottleGesture } from '../sensing/motion';
import { SensorProbe } from '../sensing/probe';
import { TouchControls } from '../sensing/touch';
import { Vehicle, type SteerMode, type ThrottleMode } from './vehicle';
import { Hud } from './hud';
import { Minimap } from './minimap';
import { EyeTracker } from '../sensing/eye';
import { calibrationMode } from './calibrate';
import { Tracer } from './trace';

const params = new URLSearchParams(location.search);
// Worlds live under ./worlds/<name>/world.json; later a Swarm reference goes here.
const worldUrl = params.get('world') ?? './worlds/paris-eiffel/world.json';
const forceOrientation = params.get('orientation') as OrientationKind | null;

async function main(): Promise<void> {
  if (params.has('calibrate')) return calibrationMode();
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hudRoot = document.getElementById('hud') as HTMLElement;
  const startEl = document.getElementById('start') as HTMLElement;
  const startBtn = document.getElementById('start-button') as HTMLButtonElement;

  const world = await loadWorld(worldUrl);
  const view = new View(canvas, world);
  if (world.attribution) {
    const credit = document.getElementById('credit');
    if (credit) credit.textContent = `${world.name} · ${world.attribution}`;
  }
  const vehicle = new Vehicle(undefined, world.ground.size / 2);
  const throttle = new ThrottleGesture();
  const probe = new SensorProbe();

  // Draw the world behind the start screen so the first frame is instant.
  view.render();

  // `?autostart` skips the tap for headless screenshots and tests.
  if (!params.has('autostart')) await new Promise<void>((resolve) => { startBtn.onclick = () => resolve(); });
  startEl.remove();
  document.documentElement.requestFullscreen?.().catch(() => { /* optional */ });
  keepScreenAwake();

  let orientation: OrientationSource;
  let orientationLog: string[];
  ({ source: orientation, log: orientationLog } = await chooseOrientation(canvas, forceOrientation ?? undefined));
  throttle.orientation = orientation.quaternion;
  throttle.start();
  probe.start();
  if (orientation.kind === 'drag') showSensorBanner(orientationLog);

  const spawnHeading = THREE.MathUtils.degToRad(world.spawn.heading);
  const spawnPos = new THREE.Vector3(...world.spawn.position);
  const respawn = () => vehicle.spawn(spawnPos, spawnHeading, yawOf(orientation.quaternion));
  respawn();
  vehicle.mode = (params.get('mode') as SteerMode | null) ?? 'look';
  vehicle.throttleMode = (params.get('throttle') as ThrottleMode | null) ?? 'displacement';

  const eyes = new EyeTracker({
    model: (params.get('model') as 'auto' | 'detector' | 'landmarker' | null) ?? 'auto',
    eye: (params.get('eyeside') as 'auto' | 'left' | 'right' | null) ?? 'auto',
  });
  eyes.setDisplacementSource(() => throttle.x);
  eyes.setOrientationSource(() => orientation.quaternion);
  const startEyes = () => eyes.start().then(() => hud.flash('eye tracking on')).catch((e: Error) => { eyes.status = `failed: ${e.message}`; hud.flash(`eye tracking failed: ${e.message}`); });

  const hud = new Hud(hudRoot, {
    vehicle,
    orientation: () => orientation,
    orientationLog: () => orientationLog,
    throttle,
    probe,
    window: view.window,
    onMode: (m) => { vehicle.setMode(m, yawOf(orientation.quaternion)); hud.flash(`mode: ${m}`); },
    onThrottleMode: (m) => { vehicle.throttleMode = m; throttle.rebase(); vehicle.targetSpeed = 0; hud.flash(`throttle: ${m}`); },
    onRecentre: () => recentre(),
    onRespawn: () => { respawn(); hud.flash('respawned'); },
    onStop: () => stop(),
    eyes,
    onEyes: (on) => { if (on) startEyes(); else { eyes.stop(); hud.flash('eye tracking off'); } },
    onEyeCalibrate: (m) => { const n = eyes.calibrate(m); hud.flash(n ? `calibrated at ${(m * 100).toFixed(1)} cm from ${n} samples: f = ${eyes.focalPx.toFixed(0)} px` : 'hold still with your face in view, then try again'); },
  });

  /** Stop dead and make the current phone position the new base. */
  const stop = () => {
    vehicle.speed = 0;
    vehicle.targetSpeed = 0;
    throttle.rebase();
    hud.flash('stopped · base reset');
    navigator.vibrate?.(20);
  };

  const minimap = new Minimap(hudRoot, world);
  if (params.has('eye')) startEyes();

  // `?trace`: a REC button streams per-frame eye/sensor data to the dev machine (spikes/records/s8-trace.jsonl).
  const tracer = params.has('trace') ? new Tracer('s8-trace') : null;
  if (tracer) {
    const rec = document.createElement('button');
    rec.className = 'rec';
    rec.textContent = 'REC';
    rec.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (tracer.recording) { tracer.stopRecording(); rec.classList.remove('on'); rec.textContent = 'REC'; hud.flash(`recording stopped · session ${tracer.session}`); }
      else { tracer.start({ ua: navigator.userAgent, css: [window.innerWidth, window.innerHeight, window.devicePixelRatio], url: location.href }); rec.classList.add('on'); rec.textContent = 'STOP REC'; hud.flash('recording'); }
      navigator.vibrate?.(30);
    });
    hudRoot.appendChild(rec);
  }
  let lastFixT = -1;
  let lastStatus = '';

  const recentre = () => {
    const did = vehicle.recentre(yawOf(orientation.quaternion));
    hud.flash(did ? 'recentred' : `recentre has no effect in "${vehicle.mode}" mode`);
    navigator.vibrate?.(did ? 30 : [20, 40, 20]);
  };

  throttle.onImpulse((i) => {
    if (vehicle.throttleMode !== 'impulse') return;
    vehicle.addImpulse(i.value);
    hud.flash(`${i.value > 0 ? 'push' : 'pull'} ${Math.abs(i.value).toFixed(2)} m/s`);
  });

  new TouchControls(canvas, {
    // Holding the screen brakes and makes the current phone position the base.
    onBrake: (b) => { vehicle.braking = b; if (b) { throttle.rebase(); vehicle.targetSpeed = 0; } },
    onRecentre: recentre,
    onImpulse: (v) => vehicle.addImpulse(v),
  }).start();

  const camera = view.window.camera;
  const yawQ = new THREE.Quaternion();
  const Y = new THREE.Vector3(0, 1, 0);
  const eyeOffset = new THREE.Vector3();
  let last = performance.now();

  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const q = orientation.quaternion;
    vehicle.setDisplacement(throttle.x);
    vehicle.update(dt, yawOf(q), rollOf(q));
    probe.trackDrift(q, now);

    // Camera: rigid yaw of the world, then the phone's orientation. The window (screen centre)
    // sits at eye height above the vehicle; the eye is behind it in the screen frame, so the
    // camera moves to the eye and the frustum passes through the window's edges (D-27).
    eyes.update(dt);
    camera.quaternion.copy(yawQ.setFromAxisAngle(Y, vehicle.viewOffset)).multiply(q);
    eyeOffset.set(eyes.eye.x, eyes.eye.y, eyes.eye.z).applyQuaternion(camera.quaternion);
    camera.position.set(vehicle.position.x, vehicle.position.y + world.eyeHeight, vehicle.position.z).add(eyeOffset);
    view.window.applyEye(eyes.eye.x, eyes.eye.y, eyes.eye.z);
    if (tracer?.recording) {
      const f = eyes.fix;
      const rec: Record<string, unknown> = {
        k: 'f', t: performance.now(), dt: Math.round(dt * 1000 * 10) / 10,
        q: [q.x, q.y, q.z, q.w].map((v) => Math.round(v * 1e4) / 1e4),
        e: [eyes.eye.x, eyes.eye.y, eyes.eye.z].map((v) => Math.round(v * 1e4) / 1e4),
        dw: [eyes.dirWorld.x, eyes.dirWorld.y, eyes.dirWorld.z].map((v) => Math.round(v * 1e4) / 1e4),
        disp: Math.round(throttle.x * 1e4) / 1e4,
      };
      if (f && f.t !== lastFixT) {
        lastFixT = f.t;
        rec.fix = {
          t: f.t, x: +f.x.toFixed(4), y: +f.y.toFixed(4), z: +f.z.toFixed(4), eye: f.eye, cue: f.cue, src: eyes.lastSource,
          ipd: +f.ipdPx.toFixed(2), ipdc: +f.ipdCorrPx.toFixed(2), fs: +f.foreshorten.toFixed(4), iris: +f.irisPx.toFixed(2),
          ds: +eyes.detectorScale.toFixed(4), is: +eyes.irisScale.toFixed(4), detMs: +eyes.detectorMs.toFixed(1), lmMs: +eyes.landmarkerMs.toFixed(1),
          dwr: [eyes.dirWorldRaw.x, eyes.dirWorldRaw.y, eyes.dirWorldRaw.z].map((v) => Math.round(v * 1e4) / 1e4),
        };
      }
      if (eyes.status !== lastStatus) { lastStatus = eyes.status; rec.status = eyes.status; }
      tracer.log(rec);
    }

    view.render();
    hud.update();
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    minimap.update(vehicle.position.x, vehicle.position.z, yawOf(camera.quaternion), hfov);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Hold a screen wake lock while the app is visible; re-acquire after tab switches. */
function keepScreenAwake(): void {
  const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
  if (!wl) return;
  const acquire = () => { if (document.visibilityState === 'visible') wl.request('screen').catch(() => { /* not granted */ }); };
  acquire();
  document.addEventListener('visibilitychange', acquire);
}

function showSensorBanner(log: string[]): void {
  const el = document.createElement('div');
  el.className = 'banner';
  el.innerHTML =
    `<b>No motion sensors: drag to look.</b><br>${log.map((l) => l.replace(/</g, '&lt;')).join('<br>')}<br>` +
    `Vanadium: tap the icon left of the address bar → Permissions → <b>Motion sensors</b> → Allow. ` +
    `GrapheneOS: Settings → Apps → Vanadium → Permissions → Sensors. Then retry.<br>` +
    `<button class="retry">Retry</button> <button class="dismiss">Dismiss</button>`;
  (el.querySelector('.retry') as HTMLButtonElement).onclick = () => location.reload();
  (el.querySelector('.dismiss') as HTMLButtonElement).onclick = () => el.remove();
  document.body.appendChild(el);
}

main().catch((e) => {
  console.error(e);
  const el = document.getElementById('start');
  if (el) el.innerHTML = `<div><h1>porthole</h1><p class="warn">${(e as Error).message}</p></div>`;
});
