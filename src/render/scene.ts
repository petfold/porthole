import * as THREE from 'three';
import type { WorldManifest } from '../world/manifest';
import { buildWorld } from '../world/primitives';
import { WindowCamera } from './camera';

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly window: WindowCamera;
  readonly worldGroup: THREE.Group;

  constructor(canvas: HTMLCanvasElement, world: WorldManifest) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.window = new WindowCamera();

    const sky = new THREE.Color(world.sky?.color ?? '#a9c9e6');
    this.scene.background = sky;
    if (world.sky?.fog) this.scene.fog = new THREE.Fog(sky, world.sky.fog * 0.6, world.sky.fog);

    this.scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x4a5a40, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(30, 50, 20);
    this.scene.add(sun);

    this.worldGroup = buildWorld(world);
    this.scene.add(this.worldGroup);

    this.resize();
    window.addEventListener('resize', this.resize);
    screen.orientation?.addEventListener?.('change', this.resize);
  }

  resize = (): void => {
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.window.resize();
  };

  render(): void {
    this.renderer.render(this.scene, this.window.camera);
  }
}
