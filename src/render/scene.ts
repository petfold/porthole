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
    if (world.sky?.fog) this.scene.fog = new THREE.Fog(sky, world.sky.fog * 0.35, world.sky.fog);

    // Soft sky light plus a warm low sun from the south-west.
    this.scene.add(new THREE.HemisphereLight(0xdde9f5, 0x9a8f7c, 1.7));
    const sun = new THREE.DirectionalLight(0xfff3e0, 1.6);
    sun.position.set(-250, 600, 300);
    this.scene.add(sun);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

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
