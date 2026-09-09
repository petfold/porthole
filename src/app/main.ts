import * as THREE from 'three';
import { loadWorld } from '../world/manifest';
import { View } from '../render/scene';
import { chooseOrientation, rollOf, yawOf, type OrientationKind, type OrientationSource } from '../sensing/orientation';
import { ThrottleGesture } from '../sensing/motion';
import { TouchControls } from '../sensing/touch';
import { Vehicle, type SteerMode } from './vehicle';
import { Hud } from './hud';

const params = new URLSearchParams(location.search);
// Worlds live under ./worlds/<name>/world.json; later a Swarm reference goes here.
const worldUrl = params.get('world') ?? './worlds/shapes/world.json';
const forceOrientation = params.get('orientation') as OrientationKind | null;

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hudRoot = document.getElementById('hud') as HTMLElement;
  const startEl = document.getElementById('start') as HTMLElement;
  const startBtn = document.getElementById('start-button') as HTMLButtonElement;

  const world = await loadWorld(worldUrl);
  const view = new View(canvas, world);
  const vehicle = new Vehicle(undefined, world.ground.size / 2);
  const throttle = new ThrottleGesture();

  // Draw the world behind the start screen so the first frame is instant.
  view.render();

  await new Promise<void>((resolve) => { startBtn.onclick = () => resolve(); });
  startEl.remove();
  document.documentElement.requestFullscreen?.().catch(() => { /* optional */ });

  let orientation: OrientationSource;
  let orientationLog: string[];
  ({ source: orientation, log: orientationLog } = await chooseOrientation(canvas, forceOrientation ?? undefined));
  throttle.start();

  const spawnHeading = THREE.MathUtils.degToRad(world.spawn.heading);
  const spawnPos = new THREE.Vector3(...world.spawn.position);
  const respawn = () => vehicle.spawn(spawnPos, spawnHeading, yawOf(orientation.quaternion));
  respawn();
  vehicle.mode = (params.get('mode') as SteerMode | null) ?? 'look';

  const hud = new Hud(hudRoot, {
    vehicle,
    orientation: () => orientation,
    orientationLog: () => orientationLog,
    throttle,
    window: view.window,
    onMode: (m) => { vehicle.setMode(m, yawOf(orientation.quaternion)); hud.flash(`mode: ${m}`); },
    onRecentre: () => recentre(),
    onRespawn: () => { respawn(); hud.flash('respawned'); },
  });

  const recentre = () => {
    const did = vehicle.recentre(yawOf(orientation.quaternion));
    hud.flash(did ? 'recentred' : `recentre has no effect in "${vehicle.mode}" mode`);
    navigator.vibrate?.(did ? 30 : [20, 40, 20]);
  };

  throttle.onImpulse((i) => {
    vehicle.addImpulse(i.value);
    hud.flash(`${i.value > 0 ? 'push' : 'pull'} ${Math.abs(i.value).toFixed(2)} m/s`);
  });

  new TouchControls(canvas, {
    onBrake: (b) => { vehicle.braking = b; },
    onRecentre: recentre,
    onImpulse: (v) => vehicle.addImpulse(v),
  }).start();

  const camera = view.window.camera;
  const yawQ = new THREE.Quaternion();
  const Y = new THREE.Vector3(0, 1, 0);
  let last = performance.now();

  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const q = orientation.quaternion;
    vehicle.update(dt, yawOf(q), rollOf(q));

    // Camera: rigid yaw of the world, then the phone's orientation; eye above the vehicle.
    camera.quaternion.copy(yawQ.setFromAxisAngle(Y, vehicle.viewOffset)).multiply(q);
    camera.position.set(vehicle.position.x, vehicle.position.y + world.eyeHeight, vehicle.position.z);

    view.render();
    hud.update();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((e) => {
  console.error(e);
  const el = document.getElementById('start');
  if (el) el.innerHTML = `<div><h1>porthole</h1><p class="warn">${(e as Error).message}</p></div>`;
});
